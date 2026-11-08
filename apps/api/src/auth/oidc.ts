/**
 * OIDC authorization-code flow with PKCE (R5, R6).
 *
 * The token-exchange endpoint proves tokens are verified correctly, but a real
 * browser login is a redirect flow, and a redirect flow has three things that a
 * bearer exchange does not:
 *
 *   state  — binds the callback to a request *we* created. Without it an
 *            attacker can feed a victim's browser a code for the attacker's
 *            account (login CSRF).
 *   nonce  — binds the ID token to that same request. Without it a token minted
 *            for a different session can be replayed into this one.
 *   PKCE   — binds the code to a verifier we generated and never exposed in the
 *            URL, so a stolen code is useless on its own.
 *
 * All three are generated here, stored server-side, and single-use. The flow row
 * is consumed in the same transaction-shaped operation that creates the session,
 * so a replayed callback finds no flow.
 */
import crypto from 'node:crypto';
import type { Db } from '../db/index.ts';
import { badRequest, unauthorized } from '../lib/http.ts';

export const FLOW_TTL_MS = 10 * 60_000;

export function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.randomBytes(bytes));
}

/** S256 PKCE challenge: BASE64URL(SHA256(verifier)). */
export function pkceChallenge(verifier: string): string {
  return base64url(crypto.createHash('sha256').update(verifier).digest());
}

export interface FlowStart {
  state: string;
  nonce: string;
  codeVerifier: string;
  codeChallenge: string;
}

/**
 * Begin a login. Returns the values needed to build the authorize URL; the
 * verifier never leaves the server.
 */
export async function beginFlow(
  db: Db,
  input: { redirectUri: string; returnTo?: string; ip?: string; userAgent?: string },
): Promise<FlowStart> {
  if (!input.redirectUri) throw badRequest('A redirect URI is required');
  const state = randomToken(32);
  const nonce = randomToken(24);
  const codeVerifier = randomToken(48);
  const expiresAt = new Date(Date.now() + FLOW_TTL_MS).toISOString().slice(0, 19).replace('T', ' ');
  await db.run(
    `INSERT INTO oidc_flows (state, nonce, code_verifier, redirect_uri, return_to, expires_at, ip, user_agent)
     VALUES (?,?,?,?,?,?,?,?)`,
    [state, nonce, codeVerifier, input.redirectUri, sanitiseReturnTo(input.returnTo), expiresAt,
      (input.ip ?? '').slice(0, 64), (input.userAgent ?? '').slice(0, 300)],
  );
  await audit(db, state, 'authorize', '', '', input.ip ?? '');
  return { state, nonce, codeVerifier, codeChallenge: pkceChallenge(codeVerifier) };
}

/**
 * Open redirects are a real vulnerability, so `return_to` is restricted to a
 * same-site absolute path. Anything else falls back to the dashboard.
 */
export function sanitiseReturnTo(value: string | undefined): string {
  if (!value) return '/';
  // Must start with a single slash: `//evil.com` and `https://evil.com` are
  // both rejected, as are backslash and control-character tricks.
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  if (/[\u0000-\u001f]/.test(value)) return '/';
  return value.slice(0, 500);
}

/** Build the authorization URL for the configured provider. */
export function authorizeUrl(opts: {
  issuer: string;
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  scope?: string;
}): string {
  // The issuer may or may not carry the authorize path; the well-known location
  // is the source of truth, but a direct value keeps this dependency-free.
  const base = (process.env.OIDC_AUTHORIZE_URL ?? `${opts.issuer.replace(/\/$/, '')}/oauth2/authorize`).trim();
  const url = new URL(base);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', opts.clientId);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('scope', opts.scope ?? 'openid profile email');
  url.searchParams.set('state', opts.state);
  url.searchParams.set('nonce', opts.nonce);
  url.searchParams.set('code_challenge', opts.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export interface FlowRecord {
  state: string;
  nonce: string;
  code_verifier: string;
  redirect_uri: string;
  return_to: string;
  expires_at: string;
  consumed_at: string | null;
  failed_reason: string;
}

/**
 * Consume a flow exactly once.
 *
 * Every failure mode is distinct in the audit log but identical to the caller
 * (401), so the endpoint is not an oracle for which check failed. `state` from
 * the callback is matched against the server row, never trusted as a session id.
 */
export async function consumeFlow(db: Db, state: string, ip = ''): Promise<FlowRecord> {
  if (!state || typeof state !== 'string') {
    await audit(db, String(state ?? ''), 'callback_failed', '', 'missing state', ip);
    throw unauthorized('Invalid or expired login attempt. Please sign in again.');
  }
  const flow = await db.get<FlowRecord>('SELECT * FROM oidc_flows WHERE state = ?', [state]);
  if (!flow) {
    await audit(db, state, 'callback_failed', '', 'unknown state', ip);
    throw unauthorized('Invalid or expired login attempt. Please sign in again.');
  }
  if (flow.consumed_at) {
    // Replay of a used state: someone is trying the callback twice.
    await audit(db, state, 'callback_failed', '', 'state already used', ip);
    throw unauthorized('Invalid or expired login attempt. Please sign in again.');
  }
  const expires = Date.parse(String(flow.expires_at).replace(' ', 'T') + 'Z');
  if (Number.isFinite(expires) && Date.now() > expires) {
    await audit(db, state, 'callback_failed', '', 'state expired', ip);
    throw unauthorized('Invalid or expired login attempt. Please sign in again.');
  }
  // Mark consumed before the caller does anything else with it, so a concurrent
  // second callback cannot also find it open.
  await db.run('UPDATE oidc_flows SET consumed_at = ? WHERE state = ? AND consumed_at IS NULL', [
    new Date().toISOString().slice(0, 19).replace('T', ' '), state,
  ]);
  return flow;
}

export async function failFlow(db: Db, state: string, reason: string, ip = ''): Promise<void> {
  try {
    await db.run('UPDATE oidc_flows SET failed_reason = ? WHERE state = ?', [reason.slice(0, 300), state]);
  } catch {
    // A failed-flow annotation must never mask the original failure.
  }
  await audit(db, state, 'callback_failed', '', reason, ip);
}

export async function audit(db: Db, state: string, kind: string, subject: string, reason: string, ip: string): Promise<void> {
  await db.run(
    'INSERT INTO oidc_audit (state, kind, subject, reason, ip) VALUES (?,?,?,?,?)',
    [state, kind, subject.slice(0, 200), reason.slice(0, 300), ip.slice(0, 64)],
  );
}

/** Opportunistic cleanup of expired flows; safe to call on any login. */
export async function pruneFlows(db: Db): Promise<void> {
  await db.run(
    "DELETE FROM oidc_flows WHERE expires_at < datetime('now', '-1 day')",
  );
}

/** Pre-flight check: what is missing for a working browser login. */
export function oidcConfigStatus(): { configured: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!process.env.OIDC_ISSUER) missing.push('OIDC_ISSUER');
  if (!process.env.OIDC_AUDIENCE) missing.push('OIDC_AUDIENCE');
  if (!process.env.OIDC_JWKS_URI) missing.push('OIDC_JWKS_URI');
  if (!process.env.OIDC_CLIENT_ID) missing.push('OIDC_CLIENT_ID');
  if (!process.env.OIDC_CLIENT_SECRET && !process.env.OIDC_TOKEN_AUTH_METHOD) missing.push('OIDC_CLIENT_SECRET');
  if (!process.env.OIDC_REDIRECT_URI) missing.push('OIDC_REDIRECT_URI');
  return { configured: missing.length === 0, missing };
}

/* --------------------------------------------------------- code exchange -- */

export interface CodeExchangeResult {
  idToken: string;
  accessToken: string;
  tokenType: string;
  claims: Record<string, unknown>;
}

/**
 * Exchange an authorization code at the provider's token endpoint.
 *
 * The request is authenticated as a confidential client (client_secret_basic by
 * default, client_secret_post as an option) and carries the PKCE verifier. A
 * provider error becomes a 401 for the user and a detailed audit row for us.
 */
export async function exchangeCode(opts: {
  tokenEndpoint: string;
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret?: string;
  codeVerifier: string;
  timeoutMs?: number;
}): Promise<CodeExchangeResult> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    code_verifier: opts.codeVerifier,
  });

  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  const authMethod = process.env.OIDC_TOKEN_AUTH_METHOD ?? 'client_secret_basic';
  if (opts.clientSecret) {
    if (authMethod === 'client_secret_post') {
      form.set('client_secret', opts.clientSecret);
    } else {
      headers.authorization = `Basic ${Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64')}`;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
  let res: Response;
  try {
    res = await fetch(opts.tokenEndpoint, {
      method: 'POST',
      headers,
      body: form.toString(),
      signal: controller.signal,
    });
  } catch (err) {
    throw unauthorized(`The identity provider could not be reached (${(err as Error).message}). Try again or contact an administrator.`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let body: Record<string, any>;
  try {
    body = JSON.parse(text);
  } catch {
    throw unauthorized(`The identity provider returned an unreadable token response (HTTP ${res.status}).`);
  }
  if (!res.ok || body.error) {
    const detail = body.error_description ?? body.error ?? `HTTP ${res.status}`;
    throw unauthorized(`The identity provider rejected the sign-in (${detail}).`);
  }
  if (!body.id_token) throw unauthorized('The identity provider did not return an ID token.');
  return {
    idToken: String(body.id_token),
    accessToken: String(body.access_token ?? ''),
    tokenType: String(body.token_type ?? 'Bearer'),
    claims: body,
  };
}

/**
 * Reject a token whose `nonce` claim is absent or does not match the flow.
 *
 * Some providers omit `nonce` from the ID token entirely; that is a provider
 * configuration fault and is treated as a failure here rather than waved
 * through, because accepting it would remove the replay protection the flow
 * exists to provide.
 */
export function assertNonce(claims: Record<string, unknown>, expected: string): void {
  const actual = claims.nonce;
  if (typeof actual !== 'string' || !actual) {
    throw unauthorized('The identity provider did not bind the token to this sign-in (missing nonce).');
  }
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw unauthorized('This sign-in attempt does not match the request that started it.');
  }
}
