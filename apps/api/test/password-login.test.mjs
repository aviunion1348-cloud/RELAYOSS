/**
 * The requested single shared login.
 *
 * This suite is adversarial by design. A shared credential is the highest-value
 * target in the application, so the tests try the things an attacker would:
 *
 *   - sign in with the wrong password, and with a username that does not exist
 *   - confirm the two failures are indistinguishable (no username oracle)
 *   - confirm an anonymous request cannot reach any data
 *   - confirm a user-controlled header cannot establish identity
 *   - confirm the demo login cannot be used as a bypass once a credential exists
 *   - confirm CSRF is required for mutations
 *   - confirm logout actually revokes, and that the session cannot be replayed
 *   - confirm rotating the password invalidates live sessions
 *   - confirm brute force is throttled
 *   - confirm no password or hash ever appears in a response or a log row
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

process.env.SESSION_SECRET ||= 'test-session-secret-do-not-use-in-production';
process.env.RATE_LIMIT_AUTH ||= '1000';
process.env.RATE_LIMIT_GLOBAL ||= '5000';
process.env.RATE_LIMIT_WRITE ||= '5000';

import { buildApp } from '../src/app.ts';
import { SqliteDb } from '../src/db/sqlite.ts';
import { PostgresDb } from '../src/db/postgres.ts';
import { migrate } from '../src/db/migrate.ts';
import { resetPostgres } from './helpers/fresh.ts';
import { hashPassword, verifyPassword, findCredential } from '../src/auth/password.ts';
import { LoginThrottle } from '../src/lib/rate-limit.ts';
import { sqlNow } from '../src/lib/dates.ts';

const pgUrl = process.env.TEST_DATABASE_URL ?? '';
const db = pgUrl ? new PostgresDb(pgUrl) : new SqliteDb(':memory:');
await migrate(db, { log: () => {} });
await resetPostgres(db);

const USERNAME = 'lear roadmap 289';
const PASSWORD = 'HoElovesCTO';

await db.run("INSERT INTO users (id,email,full_name,role,initials) VALUES ('u_owner','owner@relay.local','Owner','admin','OW')");
await db.run("INSERT INTO clients (id,name,slug,initials) VALUES ('c1','Acme','acme','AC')");
await db.run("INSERT INTO projects (id,key,name,client_id) VALUES ('p1','ACM','Acme Portal','c1')");

const hash = await hashPassword(PASSWORD);
await db.run(
  'INSERT INTO local_credentials (id, user_id, username, password_hash, version) VALUES (?,?,?,?,1)',
  ['cred_test', 'u_owner', USERNAME, hash],
);

/**
 * The shared throttle is deliberately generous here. Several tests *do* fail a
 * login on purpose, and a tight threshold would lock the username for the rest of
 * the file — which is the limiter working correctly, not a bug to route around.
 * The throttling behaviour itself is tested separately, with its own instance.
 */
const throttle = new LoginThrottle({ threshold: 50, baseLockMs: 1000, maxLockMs: 2000 });
const { app } = await buildApp({ db, serveStatic: false, logger: false, throttle });
after(async () => {
  try { await app.close(); } catch { /* closed */ }
  try { await db.close(); } catch { /* closed */ }
});

const login = (username, password) =>
  app.inject({
    method: 'POST', url: '/api/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ username, password }),
  });

const get = (url, headers = {}) => app.inject({ method: 'GET', url, headers });
const post = (url, payload, headers = {}) =>
  app.inject({
    method: 'POST', url,
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(payload ?? {}),
  });

/* ============================================================== hashing === */

test('password: the stored value is an Argon2id hash, not the password', async () => {
  const row = await findCredential(db, USERNAME);
  assert.ok(row, 'the credential must exist');
  assert.match(row.password_hash, /^\$argon2id\$v=19\$m=65536,t=3,p=4\$/, 'Argon2id at the OWASP baseline');
  assert.ok(!row.password_hash.includes(PASSWORD), 'the plaintext must not appear inside the hash');
  assert.notEqual(row.password_hash, PASSWORD);
  // The same password hashed twice must differ: the salt is per-hash.
  const again = await hashPassword(PASSWORD);
  assert.notEqual(again, row.password_hash, 'each hash must carry a fresh salt');
  assert.ok(await verifyPassword(again, PASSWORD));
});

test('password: a corrupt hash denies rather than throwing', async () => {
  assert.equal(await verifyPassword('not-a-hash', PASSWORD), false);
  assert.equal(await verifyPassword('', PASSWORD), false);
  assert.equal(await verifyPassword('$argon2id$broken', PASSWORD), false);
});

/* ================================================================ login === */

test('login: the requested credentials open the workspace', async () => {
  const res = await login(USERNAME, PASSWORD);
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.data.user.id, 'u_owner');
  assert.equal(body.data.user.role, 'admin');
  assert.ok(body.data.csrfToken, 'a CSRF token must be issued with the session');

  const cookie = res.headers['set-cookie'];
  assert.ok(cookie, 'a session cookie must be set');
  assert.match(cookie, /HttpOnly/i, 'the cookie must be HttpOnly');
  assert.match(cookie, /SameSite=(Lax|Strict)/i, 'the cookie must set SameSite');
  assert.match(cookie, /Path=\//, 'the cookie must be scoped to the whole site');
});

test('login: a wrong password is denied', async () => {
  const res = await login(USERNAME, 'definitely-not-the-password');
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers['set-cookie'], undefined, 'a failed login must not set a cookie');
});

test('login: an unknown username is denied and indistinguishable from a wrong password', async () => {
  const wrongPassword = await login(USERNAME, 'definitely-not-the-password');
  const unknownUser = await login('nobody at all', PASSWORD);

  assert.equal(unknownUser.statusCode, 401);
  // Identical status and identical message. Only the request id differs, and that
  // is a per-request trace value, not an oracle.
  assert.equal(unknownUser.json().error.code, wrongPassword.json().error.code);
  assert.equal(unknownUser.json().error.message, wrongPassword.json().error.message);
});

test('login: a username that differs only in case is denied', async () => {
  // The provisioned username contains a space and mixed case; folding case would
  // accept near-misses the operator never set.
  const res = await login(USERNAME.toUpperCase(), PASSWORD);
  assert.equal(res.statusCode, 401, 'username comparison must be exact');
});

test('login: missing fields are refused before any hashing work', async () => {
  const noPassword = await post('/api/auth/login', { username: USERNAME });
  assert.equal(noPassword.statusCode, 400);
  const empty = await post('/api/auth/login', {});
  assert.equal(empty.statusCode, 400);
});

test('login: an oversized payload is refused', async () => {
  const res = await login(USERNAME, 'x'.repeat(5000));
  assert.equal(res.statusCode, 400, 'a huge password must be rejected, not hashed');
});

test('login: a disabled credential cannot authenticate', async () => {
  // `sqlNow()` is the engine-neutral form; `datetime('now')` is SQLite-only and the
  // portability guard rejects it, because the same statement must run on both.
  await db.run('UPDATE local_credentials SET disabled_at = ? WHERE id = ?', [sqlNow(), 'cred_test']);
  const res = await login(USERNAME, PASSWORD);
  assert.equal(res.statusCode, 401);
  await db.run('UPDATE local_credentials SET disabled_at = NULL WHERE id = ?', ['cred_test']);
});

/* ============================================================= sessions === */

test('sessions: an anonymous request cannot reach any data', async () => {
  for (const url of ['/api/projects', '/api/tasks', '/api/clients', '/api/clocks', '/api/partners']) {
    const res = await get(url);
    assert.equal(res.statusCode, 401, `${url} must require authentication`);
  }
});

test('sessions: a user-controlled header cannot establish an identity', async () => {
  const attempts = [
    { 'x-actor-id': 'u_owner' },
    { 'x-user-id': 'u_owner' },
    { 'x-authenticated-user': 'u_owner' },
    { 'x-relay-user': 'u_owner' },
  ];
  for (const headers of attempts) {
    const res = await get('/api/projects', headers);
    assert.equal(res.statusCode, 401, `${JSON.stringify(headers)} must not authenticate`);
  }
});

test('sessions: the probe reports the truth before and after login', async () => {
  const anon = await app.inject({ method: 'GET', url: '/api/auth/session' });
  assert.equal(anon.statusCode, 200);
  assert.equal(anon.json().data.authenticated, false);

  const res = await login(USERNAME, PASSWORD);
  assert.equal(res.statusCode, 200, `login after earlier tests returned ${res.statusCode}: ${res.body}`);
  const cookie = res.headers['set-cookie'].split(';')[0];
  const authed = await app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie } });
  assert.equal(authed.json().data.authenticated, true);
  assert.equal(authed.json().data.user.id, 'u_owner');
});

test('sessions: a session is required for reads and CSRF is required for writes', async () => {
  const res = await login(USERNAME, PASSWORD);
  const cookie = res.headers['set-cookie'].split(';')[0];

  const read = await get('/api/projects', { cookie });
  assert.equal(read.statusCode, 200, read.body);
  assert.ok(read.json().data.length >= 1, 'the authenticated user must see data');

  const noCsrf = await post('/api/tasks', { title: 'No token attached', boardId: 'b1', columnId: 'b1_todo' }, { cookie });
  assert.equal(noCsrf.statusCode, 403, 'a mutation without a CSRF token must be refused');

  const badCsrf = await post('/api/tasks', { title: 'Wrong token' }, { cookie, 'x-csrf-token': 'fabricated-token' });
  assert.equal(badCsrf.statusCode, 403, 'a fabricated CSRF token must be refused');
});

test('sessions: logout revokes the session and it cannot be replayed', async () => {
  const res = await login(USERNAME, PASSWORD);
  const cookie = res.headers['set-cookie'].split(';')[0];
  const csrf = res.json().data.csrfToken;

  assert.equal((await get('/api/projects', { cookie })).statusCode, 200);

  const out = await post('/api/auth/logout', {}, { cookie, 'x-csrf-token': csrf });
  assert.equal(out.statusCode, 200);

  const after = await get('/api/projects', { cookie });
  assert.equal(after.statusCode, 401, 'the revoked session must stop working immediately');

  const probe = await app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie } });
  assert.equal(probe.json().data.authenticated, false);
});

test('sessions: a rotated password invalidates every live session', async () => {
  const res = await login(USERNAME, PASSWORD);
  const cookie = res.headers['set-cookie'].split(';')[0];
  assert.equal((await get('/api/projects', { cookie })).statusCode, 200);

  // Rotation is what `assign-login` does: new hash, version + 1.
  const newHash = await hashPassword('a-completely-different-password');
  await db.run('UPDATE local_credentials SET password_hash = ?, version = version + 1 WHERE id = ?', [newHash, 'cred_test']);

  const stale = await get('/api/projects', { cookie });
  assert.equal(stale.statusCode, 401, 'a session minted under the old credential version must stop working');

  // Restore, so later tests are not affected.
  await db.run('UPDATE local_credentials SET password_hash = ?, version = version + 1 WHERE id = ?', [hash, 'cred_test']);
  const fresh = await login(USERNAME, PASSWORD);
  assert.equal(fresh.statusCode, 200, 'the restored password must work again');
});

/* =============================================================== bypass === */

test('bypass: the demo login is refused once a shared credential exists', async () => {
  const res = await post('/api/auth/dev-login', { userId: 'u_owner' });
  assert.equal(res.statusCode, 403, 'dev-login must not be an alternate way in');
  assert.match(res.json().error.message, /shared login/i);
  assert.equal(res.headers['set-cookie'], undefined);
});

test('bypass: no registration or guest endpoint exists', async () => {
  // A 404 is the correct answer: the feature must not exist at all.
  for (const url of ['/api/auth/register', '/api/auth/signup', '/api/auth/guest']) {
    const res = await post(url, { email: 'x@y.z', password: 'x' });
    assert.ok([401, 404].includes(res.statusCode), `${url} must not exist as a usable endpoint (got ${res.statusCode})`);
  }
});

/* =========================================================== throttling === */

test('throttling: repeated failures lock the account and say for how long', async () => {
  // A dedicated throttle with a low threshold, so the test does not depend on the
  // shared instance's timing.
  const tight = new LoginThrottle({ threshold: 2, baseLockMs: 5000, maxLockMs: 5000 });
  const { app: app2 } = await buildApp({ db, serveStatic: false, logger: false, throttle: tight });
  try {
    const attempt = () => app2.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ username: USERNAME, password: 'wrong' }),
    });

    assert.equal((await attempt()).statusCode, 401);
    assert.equal((await attempt()).statusCode, 401);
    const locked = await attempt();
    assert.equal(locked.statusCode, 401, 'a locked login is still a 401, not a 429 that confirms the username exists');
    assert.match(locked.json().error.message, /Too many sign-in attempts/);
    assert.ok(Number(locked.headers['retry-after']) > 0, 'the caller must be told how long to wait');
  } finally {
    await app2.close();
  }
});

/* ============================================================== auditing === */

test('auditing: every attempt is recorded, and no password or hash is stored', async () => {
  const before = await db.get("SELECT COUNT(*) AS c FROM auth_events WHERE kind LIKE 'login%'");

  await login(USERNAME, 'wrong-password-for-audit');
  await login(USERNAME, PASSWORD);

  const after = await db.get("SELECT COUNT(*) AS c FROM auth_events WHERE kind LIKE 'login%'");
  assert.ok(Number(after.c) > Number(before.c), 'attempts must be written to auth_events');

  const rows = await db.all("SELECT kind, detail, ip, user_agent FROM auth_events WHERE kind LIKE 'login%'");
  const serialised = JSON.stringify(rows);
  assert.ok(!serialised.includes(PASSWORD), 'the password must never be written to the audit trail');
  assert.ok(!serialised.includes('$argon2'), 'the hash must never be written to the audit trail');
  assert.ok(rows.some((r) => r.kind === 'login_failed'), 'a failure is recorded as such');
  assert.ok(rows.some((r) => r.kind === 'login_password'), 'a success is recorded as such');
});

test('auditing: no response ever contains the password or the hash', async () => {
  const ok = await login(USERNAME, PASSWORD);
  const bad = await login(USERNAME, 'wrong');
  for (const res of [ok, bad]) {
    assert.ok(!res.body.includes(PASSWORD), 'no response may echo the password');
    assert.ok(!res.body.includes('$argon2'), 'no response may expose the hash');
  }
});
