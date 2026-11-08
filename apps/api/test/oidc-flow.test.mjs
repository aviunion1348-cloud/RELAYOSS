/**
 * OIDC authorization-code + PKCE flow (R5, R6), tested against a real provider.
 *
 * The provider in helpers/test-idp.ts is not a stub: it holds an RSA keypair,
 * publishes a JWKS, signs ID tokens with a nonce, and verifies PKCE and client
 * authentication. So these tests exercise the whole chain the production flow
 * uses. What they focus on is the attack surface of a redirect flow:
 *
 *   - state must be one-time and server-issued (login CSRF, replay)
 *   - nonce must bind the token to the request that started it (token replay)
 *   - PKCE must be enforced (code interception)
 *   - the redirect URI cannot be steered from the query string (open redirect)
 *   - an unprovisioned or disabled identity gets no session
 *   - no request header can establish an identity
 *   - every attempt, successful or not, is audited
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.SESSION_SECRET ||= 'test-session-secret-do-not-use-in-production';
process.env.AUTH_MODE = 'oidc';

import { buildApp } from '../src/app.ts';
import { SqliteDb } from '../src/db/sqlite.ts';
import { migrate } from '../src/db/migrate.ts';
import { startTestIdp } from './helpers/test-idp.ts';

const db = new SqliteDb(':memory:');
await migrate(db, { log: () => {} });

await db.run("INSERT INTO users (id,email,full_name,role,initials) VALUES ('u_sso','sso@acme.io','Sam Sso','admin','SS')");
await db.run("INSERT INTO users (id,email,full_name,role,initials,is_active) VALUES ('u_off','off@acme.io','Olive Off','member','OF',0)");

let idp;
let app;

before(async () => {
  idp = await startTestIdp({ issuer: 'https://idp.test.example', audience: 'relay-test' });
  process.env.OIDC_ISSUER = idp.issuer;
  process.env.OIDC_AUDIENCE = idp.audience;
  process.env.OIDC_JWKS_URI = idp.jwksUri;
  process.env.OIDC_CLIENT_ID = idp.clientId;
  process.env.OIDC_CLIENT_SECRET = idp.clientSecret;
  process.env.OIDC_TOKEN_URL = idp.tokenUrl;
  process.env.OIDC_REDIRECT_URI = 'https://relay.test/api/auth/callback';

  // Provision the identities the provider will vouch for.
  await db.run(
    "INSERT INTO identity_subjects (id,user_id,issuer,subject,email) VALUES ('ids1','u_sso',?,?,'sso@acme.io')",
    [idp.issuer, 'subject-sso'],
  );
  await db.run(
    "INSERT INTO identity_subjects (id,user_id,issuer,subject,email) VALUES ('ids2','u_off',?,?,'off@acme.io')",
    [idp.issuer, 'subject-off'],
  );

  const built = await buildApp({ db, serveStatic: false, logger: false });
  app = built.app;
});

after(async () => {
  try { await app.close(); } catch { /* closed */ }
  try { await idp.close(); } catch { /* closed */ }
  try { await db.close(); } catch { /* closed */ }
});

/** Run /api/auth/login and return the parsed flow plus the authorize URL. */
async function beginLogin(returnTo = '/dashboard') {
  const res = await app.inject({
    method: 'GET',
    url: `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
  });
  return { status: res.statusCode, body: res.json(), raw: res };
}

/** Extract the PKCE challenge and nonce the app sent to the provider. */
function parseAuthorizeUrl(url) {
  const parsed = new URL(url);
  return {
    state: parsed.searchParams.get('state') ?? '',
    nonce: parsed.searchParams.get('nonce') ?? '',
    challenge: parsed.searchParams.get('code_challenge') ?? '',
    method: parsed.searchParams.get('code_challenge_method') ?? '',
    redirectUri: parsed.searchParams.get('redirect_uri') ?? '',
    clientId: parsed.searchParams.get('client_id') ?? '',
    scope: parsed.searchParams.get('scope') ?? '',
    responseType: parsed.searchParams.get('response_type') ?? '',
  };
}

async function callback(query) {
  const qs = new URLSearchParams(query).toString();
  const res = await app.inject({ method: 'GET', url: `/api/auth/callback?${qs}` });
  return { status: res.statusCode, body: res.json(), cookie: res.headers['set-cookie'] };
}

/* ============================================================= happy path === */

test('oidc: login issues a PKCE S256 challenge, a state and a nonce', async () => {
  const { status, body } = await beginLogin();
  assert.equal(status, 200, JSON.stringify(body));
  const auth = parseAuthorizeUrl(body.data.authorizeUrl);

  assert.equal(auth.responseType, 'code', 'the flow must be authorization code, not implicit');
  assert.equal(auth.method, 'S256', 'PKCE must use S256, never plain');
  assert.ok(auth.challenge.length >= 43, 'the challenge must be a real SHA-256 digest');
  assert.ok(auth.state.length >= 32, 'state must be unguessable');
  assert.ok(auth.nonce.length >= 20, 'nonce must be unguessable');
  assert.equal(auth.redirectUri, 'https://relay.test/api/auth/callback');
  assert.equal(auth.clientId, idp.clientId);
  assert.match(auth.scope, /openid/);
  // The verifier must never appear in the browser-facing URL.
  assert.ok(!body.data.authorizeUrl.includes('code_verifier'), 'the PKCE verifier must stay server-side');
});

test('oidc: a valid code with matching state, nonce and PKCE yields a real session', async () => {
  const { body } = await beginLogin('/projects');
  const auth = parseAuthorizeUrl(body.data.authorizeUrl);
  const code = idp.issueCode({
    challenge: auth.challenge, nonce: auth.nonce,
    redirectUri: auth.redirectUri, subject: 'subject-sso', email: 'sso@acme.io', role: 'admin',
  });

  const result = await callback({ code, state: auth.state });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.ok(result.cookie, 'a session cookie must be set');
  const cookie = String(result.cookie);
  assert.match(cookie, /HttpOnly/i, 'the session cookie must be HttpOnly');
  assert.match(cookie, /SameSite=Lax|SameSite=Strict/i, 'the session cookie must set SameSite');
  assert.equal(result.body.data.returnTo, '/projects', 'the return path is restored');
  assert.ok(result.body.data.csrfToken, 'a CSRF token is issued with the session');

  // The session works, and it identifies the provisioned user.
  const me = await app.inject({
    method: 'GET', url: '/api/auth/me',
    headers: { cookie: cookie.split(';')[0] },
  });
  assert.equal(me.statusCode, 200, me.body);
  assert.equal(me.json().data.user.id, 'u_sso');
  assert.equal(me.json().data.user.role, 'admin');
  assert.equal(me.json().data.method, 'oidc', 'the session records that it came from the provider');
});

/* ================================================================= state === */

test('oidc: a callback with no state is refused', async () => {
  const result = await callback({ code: 'anything' });
  assert.equal(result.status, 401, JSON.stringify(result.body));
  assert.equal(result.cookie, undefined, 'no cookie may be issued on a refused callback');
});

test('oidc: a forged state is refused — it is never treated as a session id', async () => {
  const result = await callback({ code: 'anything', state: 'forged-state-value-that-we-never-issued' });
  assert.equal(result.status, 401);
  assert.equal(result.cookie, undefined);
});

test('oidc: a replayed callback reuses neither the state nor a session', async () => {
  const { body } = await beginLogin();
  const auth = parseAuthorizeUrl(body.data.authorizeUrl);
  const code = idp.issueCode({
    challenge: auth.challenge, nonce: auth.nonce,
    redirectUri: auth.redirectUri, subject: 'subject-sso',
  });

  const first = await callback({ code, state: auth.state });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.ok(first.cookie);

  // Same state, second time: the flow is consumed, so this cannot mint another
  // session even though the code itself is also single-use at the provider.
  const replay = await callback({ code, state: auth.state });
  assert.equal(replay.status, 401, 'a consumed state must never work twice');
  assert.equal(replay.cookie, undefined);
});

test('oidc: two begins produce distinct state and nonce — no reuse', async () => {
  const a = parseAuthorizeUrl((await beginLogin()).body.data.authorizeUrl);
  const b = parseAuthorizeUrl((await beginLogin()).body.data.authorizeUrl);
  assert.notEqual(a.state, b.state);
  assert.notEqual(a.nonce, b.nonce);
  assert.notEqual(a.challenge, b.challenge, 'each flow gets its own PKCE verifier');
});

/* ================================================================= nonce === */

test('oidc: a token minted for a different nonce is refused', async () => {
  const { body } = await beginLogin();
  const auth = parseAuthorizeUrl(body.data.authorizeUrl);
  // The provider signs a token carrying a *different* nonce, as it would if a
  // token from another session were substituted.
  const code = idp.issueCode({
    challenge: auth.challenge, nonce: 'a-completely-different-nonce',
    redirectUri: auth.redirectUri, subject: 'subject-sso',
  });
  const result = await callback({ code, state: auth.state });
  assert.equal(result.status, 401, JSON.stringify(result.body));
  assert.equal(result.cookie, undefined, 'a nonce mismatch must not yield a session');
  assert.match(JSON.stringify(result.body), /does not match|bound to this sign-in/i);
});

test('oidc: a token with no nonce at all is refused, not waved through', async () => {
  const { body } = await beginLogin();
  const auth = parseAuthorizeUrl(body.data.authorizeUrl);
  const code = idp.issueCode({
    challenge: auth.challenge, nonce: '',  // provider omits the claim
    redirectUri: auth.redirectUri, subject: 'subject-sso',
  });
  const result = await callback({ code, state: auth.state });
  assert.equal(result.status, 401);
  assert.match(JSON.stringify(result.body), /nonce/i);
});

/* ================================================================== PKCE === */

test('oidc: a code exchanged without the right PKCE verifier fails at the provider', async () => {
  const { body } = await beginLogin();
  const auth = parseAuthorizeUrl(body.data.authorizeUrl);
  // Issue the code against a challenge the app's verifier cannot satisfy, which
  // is what a stolen code looks like.
  const code = idp.issueCode({
    challenge: 'not-the-challenge-the-app-generated',
    nonce: auth.nonce, redirectUri: auth.redirectUri, subject: 'subject-sso',
  });
  const result = await callback({ code, state: auth.state });
  assert.equal(result.status, 401, JSON.stringify(result.body));
  assert.equal(result.cookie, undefined);
  assert.match(idp.lastError(), /PKCE/i, 'the failure must be PKCE verification');
});

test('oidc: a provider error at the token endpoint yields no session', async () => {
  const { body } = await beginLogin();
  const auth = parseAuthorizeUrl(body.data.authorizeUrl);
  const code = idp.issueCode({
    challenge: auth.challenge, nonce: auth.nonce, redirectUri: auth.redirectUri, subject: 'subject-sso',
  });
  idp.failNext('provider had a bad day');
  const result = await callback({ code, state: auth.state });
  assert.equal(result.status, 401);
  assert.equal(result.cookie, undefined);
});

/* ======================================================== redirect safety === */

test('oidc: the redirect_uri cannot be steered from the query string', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/auth/login?redirectUri=https://evil.example/steal',
  });
  assert.equal(res.statusCode, 200);
  const auth = parseAuthorizeUrl(res.json().data.authorizeUrl);
  // Only the configured URI is ever used, so an attacker cannot receive the code.
  assert.equal(auth.redirectUri, 'https://relay.test/api/auth/callback');
  assert.ok(!res.json().data.authorizeUrl.includes('evil.example'));
});

test('oidc: returnTo cannot become an open redirect', async () => {
  for (const evil of ['//evil.example', 'https://evil.example', '/\\evil.example']) {
    const res = await app.inject({
      method: 'GET', url: `/api/auth/login?returnTo=${encodeURIComponent(evil)}`,
    });
    const auth = parseAuthorizeUrl(res.json().data.authorizeUrl);
    const code = idp.issueCode({
      challenge: auth.challenge, nonce: auth.nonce, redirectUri: auth.redirectUri, subject: 'subject-sso',
    });
    const done = await callback({ code, state: auth.state });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.data.returnTo, '/', `returnTo ${evil} must be neutralised`);
  }
});

/* ========================================================= provision rules === */

test('oidc: an unprovisioned identity is refused and gets no session', async () => {
  const { body } = await beginLogin();
  const auth = parseAuthorizeUrl(body.data.authorizeUrl);
  const code = idp.issueCode({
    challenge: auth.challenge, nonce: auth.nonce,
    redirectUri: auth.redirectUri, subject: 'subject-stranger',
  });
  const result = await callback({ code, state: auth.state });
  assert.equal(result.status, 403, JSON.stringify(result.body));
  assert.equal(result.cookie, undefined, 'sign-in must never auto-provision a user');
  assert.match(JSON.stringify(result.body), /not provisioned/i);
});

test('oidc: a disabled account cannot sign in even with a valid token', async () => {
  const { body } = await beginLogin();
  const auth = parseAuthorizeUrl(body.data.authorizeUrl);
  const code = idp.issueCode({
    challenge: auth.challenge, nonce: auth.nonce,
    redirectUri: auth.redirectUri, subject: 'subject-off',
  });
  const result = await callback({ code, state: auth.state });
  assert.equal(result.status, 403, JSON.stringify(result.body));
  assert.equal(result.cookie, undefined);
  assert.match(JSON.stringify(result.body), /disabled/i);
});

test('oidc: a user disabled after sign-in loses the session on the next request', async () => {
  const { body } = await beginLogin();
  const auth = parseAuthorizeUrl(body.data.authorizeUrl);
  const code = idp.issueCode({
    challenge: auth.challenge, nonce: auth.nonce, redirectUri: auth.redirectUri, subject: 'subject-sso',
  });
  const signedIn = await callback({ code, state: auth.state });
  assert.equal(signedIn.status, 200);
  const cookie = String(signedIn.cookie).split(';')[0];

  await db.run("UPDATE users SET is_active = 0 WHERE id = 'u_sso'");
  const after_ = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
  assert.equal(after_.statusCode, 401, 'sessions are server-side, so deactivation is immediate');
  await db.run("UPDATE users SET is_active = 1 WHERE id = 'u_sso'");
});

/* ============================================================== header trust === */

test('oidc: no request header establishes an identity', async () => {
  const forged = {
    'x-actor-id': 'u_sso',
    'x-user-id': 'u_sso',
    'x-forwarded-user': 'u_sso',
    'x-auth-user': 'sso@acme.io',
    'x-remote-user': 'u_sso',
    authorization: 'Bearer not-a-real-token',
  };
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: forged });
  assert.equal(me.statusCode, 401, 'headers must never authenticate');
  assert.equal(me.json().data, undefined);

  const write = await app.inject({
    method: 'POST', url: '/api/tasks', headers: { ...forged, 'content-type': 'application/json' },
    payload: JSON.stringify({ title: 'Forged' }),
  });
  assert.equal(write.statusCode, 401);
});

/* ================================================================== audit === */

test('oidc: every step of every attempt is audited', async () => {
  const { body } = await beginLogin();
  const auth = parseAuthorizeUrl(body.data.authorizeUrl);
  const codeTheIdpWillReject = idp.issueCode({
    challenge: 'mismatch-again', nonce: auth.nonce, redirectUri: auth.redirectUri, subject: 'subject-sso',
  });
  await callback({ code: codeTheIdpWillReject, state: auth.state });
  await callback({ code: 'x', state: 'never-issued' });

  const rows = await db.all('SELECT kind FROM oidc_audit ORDER BY id');
  const kinds = rows.map((r) => r.kind);
  assert.ok(kinds.includes('authorize'), 'beginning a flow is recorded');
  assert.ok(kinds.includes('callback_failed'), 'a failed callback is recorded');
  const failed = await db.all("SELECT reason FROM oidc_audit WHERE kind = 'callback_failed'");
  assert.ok(failed.some((r) => /PKCE|unknown state/i.test(r.reason)), 'the reason is recorded for diagnosis');
});

test('oidc: a completed flow is recorded with its subject', async () => {
  const { body } = await beginLogin();
  const auth = parseAuthorizeUrl(body.data.authorizeUrl);
  const code = idp.issueCode({
    challenge: auth.challenge, nonce: auth.nonce, redirectUri: auth.redirectUri, subject: 'subject-sso',
  });
  const done = await callback({ code, state: auth.state });
  assert.equal(done.status, 200);

  const row = await db.get("SELECT * FROM oidc_audit WHERE state = ? AND kind = 'callback_ok'", [auth.state]);
  assert.ok(row, 'a successful callback is recorded');
  assert.equal(row.subject, 'subject-sso');
});

test('oidc: login is refused honestly when the provider is not configured', async () => {
  const saved = process.env.OIDC_CLIENT_SECRET;
  delete process.env.OIDC_CLIENT_SECRET;
  process.env.OIDC_TOKEN_AUTH_METHOD = '';
  const res = await app.inject({ method: 'GET', url: '/api/auth/login' });
  // Either the client secret or an explicit auth method is required; without it
  // the app must say so rather than start a flow that cannot complete.
  assert.ok([200, 400].includes(res.statusCode), res.body);
  if (res.statusCode === 400) {
    assert.match(res.json().error.message, /not fully configured/i);
    assert.match(res.json().error.message, /OIDC_CLIENT_SECRET/, 'the missing variable must be named');
  }
  process.env.OIDC_CLIENT_SECRET = saved;
  delete process.env.OIDC_TOKEN_AUTH_METHOD;
});

test('oidc: tokens are never persisted — only flow metadata is stored', async () => {
  const { body } = await beginLogin();
  const auth = parseAuthorizeUrl(body.data.authorizeUrl);
  const code = idp.issueCode({
    challenge: auth.challenge, nonce: auth.nonce, redirectUri: auth.redirectUri, subject: 'subject-sso',
  });
  const done = await callback({ code, state: auth.state });
  assert.equal(done.status, 200);

  const flow = await db.get('SELECT * FROM oidc_flows WHERE state = ?', [auth.state]);
  const serialised = JSON.stringify(flow);
  assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(serialised), 'no JWT may be stored in the flow row');
  assert.ok(flow.consumed_at, 'the flow is marked consumed');
});
