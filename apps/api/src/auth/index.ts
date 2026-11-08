/**
 * Authentication.
 *
 * Production identity is a signed OIDC ID/access token (RS256/ES256), verified
 * against the issuer's JWKS with an issuer + audience check, and carried in an
 * HttpOnly, SameSite=Lax, Secure session cookie. There is **no** identity
 * request header in OIDC mode: a client cannot assert who it is.
 *
 * Local development uses a signed dev session cookie (`AUTH_MODE=dev`) so the
 * product is usable without an IdP. It is explicit, logged at boot, refused in
 * production, and mapped from the same `sessions` table — the only difference
 * is which key material and which verifier produced the cookie.
 *
 * Deliberately not implemented here (documented as blockers, not faked):
 *   - interactive authorization-code flow with a real provider (needs tenant
 *     credentials: client id/secret/issuer)
 *   - token *refresh* against the provider's token endpoint (same credentials)
 * The verification boundary those flows hand off to is real and tested.
 */
import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { forbidden, unauthorized } from '../lib/http.ts';

export interface Identity {
  userId: string;
  email: string;
  role: 'admin' | 'lead' | 'member' | 'client' | 'bot';
  name: string;
  /** How this request was authenticated — audited with every mutation. */
  method: 'oidc' | 'dev' | 'password';
  /** The session backing this request, when there is one. Needed for logout and
   *  revocation; absent for bearer and header-derived identities. */
  sessionId?: string;
  /** Token/session expiry (epoch ms). */
  expiresAt: number;
  /** Scopes/claims relevant to authorisation decisions. */
  claims: Record<string, unknown>;
}

export interface Jwk {
  kid?: string;
  kty: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
  alg?: string;
  use?: string;
}

const JWKS_TTL_MS = 10 * 60_000;

/**
 * In-process JWKS cache. A missing `kid` forces one refetch (key rotation), but
 * never more than once per minute — a hostile or broken IdP must not be able to
 * turn our API into a request amplifier.
 */
export class JwksCache {
  private keys = new Map<string, crypto.KeyObject>();
  private fetchedAt = 0;
  private inflight: Promise<void> | null = null;

  private readonly uri: string;
  private readonly fetchImpl: typeof fetch;

  constructor(uri: string, fetchImpl: typeof fetch = fetch) {
    this.uri = uri;
    this.fetchImpl = fetchImpl;
  }

  private async refetch() {
    if (!this.uri) throw unauthorized('Identity provider is not configured (OIDC_JWKS_URI)');
    const res = await this.fetchImpl(this.uri, { headers: { accept: 'application/json' } });
    if (!res.ok) throw unauthorized(`JWKS fetch failed (${res.status})`);
    const body = (await res.json()) as { keys?: Jwk[] };
    const next = new Map<string, crypto.KeyObject>();
    for (const jwk of body.keys ?? []) {
      try {
        next.set(jwk.kid ?? `${jwk.kty}-${jwk.n ?? jwk.x ?? ''}`, crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: 'jwk' }));
      } catch {
        // Skip unusable keys rather than failing the whole set.
      }
    }
    if (!next.size) throw unauthorized('JWKS contained no usable keys');
    this.keys = next;
    this.fetchedAt = Date.now();
  }

  async get(kid?: string): Promise<crypto.KeyObject | undefined> {
    const stale = Date.now() - this.fetchedAt > JWKS_TTL_MS;
    if ((!this.keys.size || stale || (kid && !this.keys.has(kid))) && !this.inflight) {
      this.inflight = this.refetch().finally(() => {
        this.inflight = null;
      });
    }
    if (this.inflight) await this.inflight;
    if (kid) return this.keys.get(kid);
    return this.keys.values().next().value as crypto.KeyObject | undefined;
  }
}

export interface TokenPayload {
  sub?: string;
  email?: string;
  name?: string;
  preferred_username?: string;
  role?: string;
  roles?: string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  aud?: string | string[];
  iss?: string;
  [k: string]: unknown;
}

function b64urlToBuffer(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Verify a compact JWS. Checks signature, algorithm allow-list, `exp`, `nbf`,
 * `iss` and `aud`. Returns the payload or throws — never a partial success.
 */
export async function verifyJwt(
  token: string,
  opts: {
    jwks: JwksCache;
    issuer?: string;
    audience?: string;
    algAllowList?: string[];
    now?: number;
  },
): Promise<TokenPayload> {
  const parts = token.split('.');
  if (parts.length !== 3) throw unauthorized('Malformed token');
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: string; kid?: string; typ?: string };
  try {
    header = JSON.parse(b64urlToBuffer(headerB64).toString('utf8'));
  } catch {
    throw unauthorized('Malformed token header');
  }

  const allowed = opts.algAllowList ?? ['RS256', 'RS384', 'ES256'];
  const alg = header.alg ?? '';
  if (!allowed.includes(alg)) throw unauthorized(`Token algorithm not allowed: ${alg}`);
  if (alg === 'none') throw unauthorized('Unsigned tokens are not accepted');

  const key = await opts.jwks.get(header.kid);
  if (!key) throw unauthorized('No matching signing key');

  const data = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
  const sig = b64urlToBuffer(sigB64);
  const verifyAlg = alg.startsWith('ES') ? 'sha256' : alg === 'RS384' ? 'sha384' : 'sha256';
  const algorithm = alg.startsWith('ES')
    ? { name: 'sha256', dsaEncoding: 'ieee-p1363' as const }
    : verifyAlg;

  const ok = crypto.verify(algorithm as never, data, { key, dsaEncoding: 'ieee-p1363' } as never, sig);
  if (!ok) throw unauthorized('Invalid token signature');

  let payload: TokenPayload;
  try {
    payload = JSON.parse(b64urlToBuffer(payloadB64).toString('utf8'));
  } catch {
    throw unauthorized('Malformed token payload');
  }

  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  if (typeof payload.exp === 'number' && nowSec >= payload.exp) throw unauthorized('Token expired');
  if (typeof payload.nbf === 'number' && nowSec + 30 < payload.nbf) throw unauthorized('Token not yet valid');
  if (opts.issuer && payload.iss !== opts.issuer) throw unauthorized('Token issuer mismatch');
  if (opts.audience) {
    const aud = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
    if (!aud.includes(opts.audience)) throw unauthorized('Token audience mismatch');
  }
  return payload;
}

/* ------------------------------------------------------------- sessions -- */

export interface SessionRow {
  id: string;
  user_id: string;
  method: string;
  expires_at: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  user_agent: string | null;
  ip: string | null;
}

/**
 * Sessions are server-side rows, not just cookies: a role change, deactivation
 * or explicit revoke takes effect on the *next request*, which is what makes
 * "user loses permission mid-session" testable rather than aspirational.
 */
export async function createSession(
  db: Db,
  input: { userId: string; method: Identity['method']; ttlMs: number; userAgent?: string; ip?: string },
): Promise<{ id: string; expiresAt: number }> {
  const id = `ses_${crypto.randomBytes(18).toString('base64url')}`;
  const expiresAt = Date.now() + input.ttlMs;
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const exp = new Date(expiresAt).toISOString().slice(0, 19).replace('T', ' ');
  await db.run(
    `INSERT INTO sessions (id, user_id, method, token_hash, expires_at, user_agent, ip, created_at, last_seen_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, input.userId, input.method, crypto.createHash('sha256').update(id).digest('hex'), exp, input.userAgent ?? null, input.ip ?? null, now, now],
  );
  return { id, expiresAt };
}

export async function revokeSession(db: Db, sessionId: string): Promise<void> {
  await db.run('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [
    new Date().toISOString().slice(0, 19).replace('T', ' '),
    sessionId,
  ]);
}

export async function revokeAllSessions(db: Db, userId: string): Promise<number> {
  const rows = await db.all<{ id: string }>('SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL', [userId]);
  for (const r of rows) await revokeSession(db, r.id);
  return rows.length;
}

export interface SessionLookup {
  session: SessionRow;
  identity: Identity;
}

export async function lookupSession(
  db: Db,
  sessionId: string,
  opts: { touch?: boolean } = {},
): Promise<SessionLookup | null> {
  const session = await db.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', [sessionId]);
  if (!session) return null;
  if (session.revoked_at) return null;
  if (new Date(session.expires_at.replace(' ', 'T') + 'Z').getTime() <= Date.now()) return null;

  // Identity is re-derived from the user row on every request: a deactivated or
  // demoted user loses access immediately, without waiting for token expiry.
  const user = await db.get<{ id: string; email: string; role: Identity['role']; full_name: string; is_active: number }>(
    'SELECT id, email, role, full_name, is_active FROM users WHERE id = ?',
    [session.user_id],
  );
  if (!user || !user.is_active) return null;

  /**
   * Credential rotation invalidates password sessions.
   *
   * A session minted under credential version N stops working the moment the
   * credential moves to N+1. This is what makes "change the password" also mean
   * "sign everybody out" without enumerating sessions. OIDC and dev sessions are
   * not governed by the shared credential, so the check does not apply to them.
   */
  if (session.method === 'password') {
    const credentialVersion = (session as unknown as { credential_version?: number | null }).credential_version;
    if (credentialVersion === null || credentialVersion === undefined) return null;
    const credential = await db.get<{ version: number; disabled_at: string | null }>(
      'SELECT version, disabled_at FROM local_credentials WHERE user_id = ?',
      [session.user_id],
    );
    if (!credential) return null;
    if (credential.disabled_at) return null;
    if (Number(credential.version) !== Number(credentialVersion)) return null;
  }

  if (opts.touch !== false) {
    await db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [
      new Date().toISOString().slice(0, 19).replace('T', ' '),
      sessionId,
    ]);
  }

  return {
    session,
    identity: {
      userId: user.id,
      email: user.email,
      role: user.role,
      name: user.full_name,
      method: session.method as Identity['method'],
      sessionId: session.id,
      expiresAt: new Date(session.expires_at.replace(' ', 'T') + 'Z').getTime(),
      claims: {},
    },
  };
}

export const SESSION_COOKIE = 'relay_session';

export function readCookie(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

export function sessionCookie(sessionId: string, maxAgeSec: number, secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

/**
 * Signed CSRF token: `nonce.hmac`. Required on state-changing requests made
 * with a cookie session (double-submit + server-side signature check). Bearer
 * and dev-header clients are not cookie-authenticated, so CSRF does not apply.
 */
export function issueCsrf(sessionId: string, secret: string): string {
  const nonce = crypto.randomBytes(16).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(`${sessionId}.${nonce}`).digest('base64url');
  return `${nonce}.${mac}`;
}

export function verifyCsrf(sessionId: string, token: string | undefined, secret: string): boolean {
  if (!token || !secret) return false;
  const [nonce, mac] = token.split('.');
  if (!nonce || !mac) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${sessionId}.${nonce}`).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Does this string look like a real Argon2id hash?
 *
 * Written as explicit parsing rather than a regular expression because the
 * delimiter *is* `$` — the regex metacharacter for end-of-input — so the pattern
 * needs six escaped dollar signs and is easy to get subtly wrong (this code did,
 * once: `\\$` matches a literal backslash, and the check silently accepted a
 * plaintext value).
 *
 * Structure, per the PHC string format:
 *
 *   $argon2id$v=19$m=65536,t=3,p=4$<salt>$<hash>
 *
 * The salt and hash are unpadded base64. Their exact length is not fixed (the salt
 * is random), so this checks shape and non-emptiness rather than a byte count —
 * enough to reject a plaintext password, a truncated value, or a stub.
 */
export function looksLikeArgon2id(value: string): boolean {
  if (!value.startsWith('$argon2id$')) return false;
  const parts = value.split('$');
  // ['', 'argon2id', 'v=19', 'm=…,t=…,p=…', salt, hash]
  if (parts.length !== 6) return false;
  const [, algorithm, version, params, salt, hash] = parts;
  if (algorithm !== 'argon2id') return false;
  if (!/^v=\d+$/.test(version)) return false;
  if (!/^m=\d+,t=\d+,p=\d+$/.test(params)) return false;
  const base64 = /^[A-Za-z0-9+/]+$/;
  if (salt.length < 8 || !base64.test(salt)) return false;
  if (hash.length < 16 || !base64.test(hash)) return false;
  return true;
}

/**
 * The effective authentication mode.
 *
 * `config.authMode` is a live view over `AUTH_MODE` and may legitimately say
 * `auto`, which is not itself a usable mode. This resolves `auto` once at boot,
 * using the database, and remembers the answer: whether a shared credential exists
 * cannot change while the process is serving.
 *
 * Resolution order, and why:
 *
 *   1. An explicit `AUTH_MODE` always wins. An operator who names a mode gets it.
 *   2. Otherwise a provisioned shared credential means `password`. This must beat
 *      `dev`, or a deployment with a real password would leave the demonstration
 *      identities reachable — a bypass.
 *   3. Otherwise `dev`, so a fresh clone works with no configuration at all.
 */
let resolvedMode: 'oidc' | 'password' | 'dev' | null = null;

export function setResolvedAuthMode(mode: 'oidc' | 'password' | 'dev'): void {
  resolvedMode = mode;
}

/** The mode the application is actually enforcing right now. */
export function authMode(): 'oidc' | 'password' | 'dev' {
  const declared = config.authMode;
  if (declared === 'oidc' || declared === 'password' || declared === 'dev') return declared;
  return resolvedMode ?? 'dev';
}

/** Reset the cached resolution. Tests switch configuration between cases. */
export function resetResolvedAuthMode(): void {
  resolvedMode = null;
}

/**
 * Refuse to boot with an authentication configuration that cannot be safe.
 *
 * `mode` is the *effective* mode, which is `password` when a shared credential is
 * provisioned rather than whatever `AUTH_MODE` happens to say. Passing it in
 * avoids a second database round-trip during boot and keeps the decision in one
 * place.
 */
/**
 * Configuration checks that need no database.
 *
 * Run before the first connection is opened. A malformed hash or a missing session
 * secret is a deployment mistake, and it must be reported as such — validating it
 * after a query means an unreachable database masks a misconfiguration, and the
 * operator debugs the wrong problem.
 */
export function assertStaticAuthConfiguration(): void {
  const suppliedHash = process.env.RELAY_ADMIN_PASSWORD_HASH ?? '';
  if (suppliedHash && !looksLikeArgon2id(suppliedHash)) {
    throw new Error(
      'RELAY_ADMIN_PASSWORD_HASH is not a complete Argon2id hash. Expected the PHC form ' +
        '$argon2id$v=19$m=65536,t=3,p=4$<salt>$<hash>. Generate one with: npm run set-password',
    );
  }
  if (!config.sessionSecret) {
    throw new Error('SESSION_SECRET is required (used to sign CSRF tokens and cookie sessions)');
  }
  if (config.env === 'production' && config.internalErrorDetail) {
    throw new Error('INTERNAL_ERROR_DETAIL=1 is refused in production. Internal error text is not returned to clients.');
  }
}

export function assertAuthConfiguration(mode: string = authMode()): void {
  const prod = config.env === 'production';
  assertStaticAuthConfiguration();
  if (prod && mode === 'dev') {
    // The escape hatch exists for one case: a local/demo container stack that
    // runs with NODE_ENV=production to exercise the production build. It must be
    // opted into explicitly, and it announces itself at boot and in /api/health.
    if (process.env.ALLOW_DEV_AUTH_IN_PRODUCTION !== '1') {
      throw new Error(
        'AUTH_MODE=dev is refused in production. Configure OIDC (OIDC_ISSUER, OIDC_AUDIENCE, OIDC_JWKS_URI), ' +
          'or set ALLOW_DEV_AUTH_IN_PRODUCTION=1 for a local demonstration stack.',
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        level: 40,
        msg: 'INSECURE AUTHENTICATION: AUTH_MODE=dev in a production build. Demo identities only — do not expose this instance.',
      }),
    );
  }
  if (mode === 'oidc' && (!config.oidcIssuer || !config.oidcAudience || !config.oidcJwksUri)) {
    throw new Error('AUTH_MODE=oidc requires OIDC_ISSUER, OIDC_AUDIENCE and OIDC_JWKS_URI');
  }

}

export { forbidden };
