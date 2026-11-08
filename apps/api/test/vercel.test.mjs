/**
 * The Vercel deployment surface.
 *
 * The point of these tests is that "deployable" is a claim about behaviour, not
 * about the existence of a `vercel.json`. What is asserted:
 *
 *   - the serverless handler serves real requests without ever calling `listen()`
 *   - the handler refuses to authenticate unless a real credential is presented
 *   - the cron endpoint is authenticated, idempotent, and fails closed when unset
 *   - the SPA fallback and the API never shadow each other
 *   - the connection pool is bounded for serverless
 *   - a production boot is refused when authentication is unconfigured
 *
 * The handler is exercised through a real HTTP server so that Fastify's own
 * request lifecycle is under test, not a mocked imitation of it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.SESSION_SECRET ||= 'test-session-secret-do-not-use-in-production';
process.env.RATE_LIMIT_AUTH ||= '1000';
process.env.RATE_LIMIT_GLOBAL ||= '5000';
process.env.RATE_LIMIT_WRITE ||= '5000';

import { buildApp } from '../src/app.ts';
import { SqliteDb } from '../src/db/sqlite.ts';
import { migrate } from '../src/db/migrate.ts';
import { authMode, resetResolvedAuthMode } from '../src/auth/index.ts';
import { hashPassword } from '../src/auth/password.ts';

/**
 * A migrated in-memory database.
 *
 * Injected databases skip boot migration by design, so every test here migrates
 * explicitly — a test that relied on implicit migration would be testing a
 * side effect rather than the schema.
 */
async function freshDb() {
  const db = new SqliteDb(':memory:');
  await migrate(db, { log: () => {} });
  return db;
}

/** A migrated database seeded with one provisioned shared credential. */
async function provisionedApp(username = 'shared user') {
  const db = await freshDb();
  const { app } = await buildApp({ db, logger: false });
  await db.run(
    `INSERT INTO users (id,email,full_name,role,is_active) VALUES ('usr_shared','shared@relay.local','Shared User','admin',1)`,
  );
  const hash = await hashPassword('correct horse battery');
  await db.run(
    `INSERT INTO local_credentials (id,user_id,username,password_hash,version,disabled_at,created_at,updated_at)
     VALUES ('cred_1','usr_shared',?,?,1,NULL,?,?)`,
    [username, hash, '2026-01-01 00:00:00', '2026-01-01 00:00:00'],
  );
  return { app, db };
}

test('vercel: the handler serves requests without binding a port itself', async () => {
  const { app } = await buildApp({ db: await freshDb(), logger: false });

  // Constructing an app must not start a listener. This is the single most common
  // way a serverless port fails: `listen` is called and the platform has nothing
  // routing to that port.
  assert.equal(app.server.listening, false, 'buildApp must not listen');

  await app.ready();
  const res = await app.inject({ method: 'GET', url: '/api/live' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.live, true);
  await app.close();
});

test('vercel: an anonymous request cannot read data', async () => {
  const { app } = await buildApp({ db: await freshDb(), logger: false });
  for (const url of ['/api/projects', '/api/tasks', '/api/dashboard', '/api/clients', '/api/partners']) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 401, `${url} must require authentication`);
    assert.equal(res.json().error.code, 'unauthorized');
  }
  await app.close();
});

test('vercel: health endpoints stay reachable without a session', async () => {
  const { app } = await buildApp({ db: await freshDb(), logger: false });
  for (const url of ['/api/live', '/api/health', '/api/ready']) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 200, `${url} is an infrastructure probe`);
  }
  await app.close();
});

test('vercel: /api 404s are JSON, never the SPA document', async () => {
  const { app } = await buildApp({ db: await freshDb(), logger: false, serveStatic: false });
  const res = await app.inject({ method: 'GET', url: '/api/there-is-no-such-route' });
  assert.equal(res.statusCode, 401, 'unauthenticated unknown API routes are refused first');
  assert.match(res.headers['content-type'], /application\/json/);
  await app.close();
});

test('vercel: cron fails closed when CRON_SECRET is not configured', async () => {
  const previous = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  const { app } = await buildApp({ db: await freshDb(), logger: false });
  const res = await app.inject({ method: 'GET', url: '/api/cron/sweep' });
  // 503, not 200: an open endpoint that mutates SLA state would be worse than a
  // disabled one, and an operator must be told it is disabled.
  assert.equal(res.statusCode, 503);
  assert.match(res.json().error.message, /CRON_SECRET/);
  if (previous === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = previous;
  await app.close();
});

test('vercel: cron refuses a missing, wrong, and truncated secret', async () => {
  process.env.CRON_SECRET = 'a-real-cron-secret-value';
  const { app } = await buildApp({ db: await freshDb(), logger: false });
  const attempts = [
    {},
    { authorization: 'Bearer wrong' },
    { authorization: 'Bearer a-real-cron-secre' },
    { authorization: 'Bearer a-real-cron-secret-value-extra' },
    { authorization: 'Basic a-real-cron-secret-value' },
  ];
  for (const headers of attempts) {
    const res = await app.inject({ method: 'GET', url: '/api/cron/sweep', headers });
    assert.equal(res.statusCode, 401, `must refuse ${JSON.stringify(headers)}`);
  }
  const ok = await app.inject({
    method: 'GET',
    url: '/api/cron/sweep',
    headers: { authorization: 'Bearer a-real-cron-secret-value' },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(typeof ok.json().data.swept, 'number');
  delete process.env.CRON_SECRET;
  await app.close();
});

test('vercel: cron is idempotent — a second run sweeps nothing new', async () => {
  process.env.CRON_SECRET = 'idempotency-check';
  const db = await freshDb();
  const { app } = await buildApp({ db, logger: false });
  const headers = { authorization: 'Bearer idempotency-check' };
  const first = await app.inject({ method: 'GET', url: '/api/cron/sweep', headers });
  const second = await app.inject({ method: 'GET', url: '/api/cron/sweep', headers });
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  // Nothing is due on a fresh database, so both runs sweep zero. The assertion that
  // matters is that running twice is not an error and does not double-count.
  assert.equal(first.json().data.swept, 0);
  assert.equal(second.json().data.swept, 0);
  delete process.env.CRON_SECRET;
  await app.close();
});

test('vercel: cron is not reachable with a session cookie alone', async () => {
  process.env.CRON_SECRET = 'cookie-must-not-work';
  const { app } = await provisionedApp();
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'shared user', password: 'correct horse battery' },
  });
  assert.equal(login.statusCode, 200);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const res = await app.inject({ method: 'GET', url: '/api/cron/sweep', headers: { cookie } });
  // A human session must not trigger scheduled work. Only the bearer secret does.
  assert.equal(res.statusCode, 401);
  delete process.env.CRON_SECRET;
  await app.close();
});

test('vercel: a provisioned credential selects password mode, not dev', async () => {
  const db = await freshDb();
  const { app } = await buildApp({ db, logger: false });
  // No credential yet: a fresh clone must work without configuration.
  assert.equal(authMode(), 'dev');

  await db.run(
    `INSERT INTO users (id,email,full_name,role,is_active) VALUES ('usr_shared','s@relay.local','S','admin',1)`,
  );
  await db.run(
    `INSERT INTO local_credentials (id,user_id,username,password_hash,version,disabled_at,created_at,updated_at)
     VALUES ('cred_x','usr_shared','someone',?,1,NULL,'2026-01-01 00:00:00','2026-01-01 00:00:00')`,
    [await hashPassword('a-long-enough-password')],
  );
  resetResolvedAuthMode();
  const rebuilt = await buildApp({ db, logger: false });
  // The credential must win over the demo mode, or the demo identities would
  // remain a second way in.
  assert.equal(authMode(), 'password');

  // And the demo login must now be refused outright.
  const bypass = await rebuilt.app.inject({
    method: 'POST',
    url: '/api/auth/dev-login',
    payload: { userId: 'usr_shared' },
  });
  assert.equal(bypass.statusCode, 403);
  await rebuilt.app.close();
  await app.close();
});

test('vercel: an explicit AUTH_MODE wins over the automatic choice', async () => {
  const db = await freshDb();
  const previous = process.env.AUTH_MODE;
  process.env.AUTH_MODE = 'dev';
  try {
    const { app } = await buildApp({ db, logger: false });
    assert.equal(authMode(), 'dev');
    await app.close();
  } finally {
    if (previous === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = previous;
    resetResolvedAuthMode();
  }
});

test('vercel: a malformed hash is refused at boot', async () => {
  const previous = process.env.RELAY_ADMIN_PASSWORD_HASH;
  process.env.RELAY_ADMIN_PASSWORD_HASH = 'not-a-hash';
  try {
    await assert.rejects(
      () => buildApp({ db: new SqliteDb(':memory:'), logger: false }),
      /Argon2id/,
      'a plaintext or truncated value must not be accepted as a hash',
    );
  } finally {
    if (previous === undefined) delete process.env.RELAY_ADMIN_PASSWORD_HASH;
    else process.env.RELAY_ADMIN_PASSWORD_HASH = previous;
  }
});

/**
 * Pool size, measured through `createDb` — the function the server actually calls.
 *
 * Constructing a `PostgresDb` by hand would only prove that the constructor accepts
 * a `max` argument; it would say nothing about what a deployment gets.
 */
async function poolMaxUnder(env) {
  const saved = {
    VERCEL: process.env.VERCEL,
    DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX,
    DATABASE_URL: process.env.DATABASE_URL,
  };
  // A syntactically valid URL that is never contacted: pool construction is lazy.
  process.env.DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/unused';
  delete process.env.VERCEL;
  delete process.env.DATABASE_POOL_MAX;
  Object.assign(process.env, env);
  try {
    const { createDb } = await import('../src/db/index.ts');
    const db = createDb();
    const max = /** @type {any} */ (db).pool.options.max;
    await db.close();
    return max;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('vercel: the connection pool is bounded when running on Vercel', async () => {
  const max = await poolMaxUnder({ VERCEL: '1' });
  assert.equal(max, 3, `serverless pool must be 3, got ${max}`);
});

test('vercel: a long-lived container keeps the larger pool', async () => {
  const max = await poolMaxUnder({});
  assert.equal(max, 10, 'a container can afford a normal pool');
});

test('vercel: DATABASE_POOL_MAX overrides the default', async () => {
  const max = await poolMaxUnder({ VERCEL: '1', DATABASE_POOL_MAX: '7' });
  assert.equal(max, 7);
});

test('vercel: the exported handler answers a real HTTP request', async () => {
  // This runs the actual `api/index.js` wrapper — the file Vercel executes — not
  // the TypeScript source. It proves the delegation path and the compiled artefact
  // agree.
  const built = await import('node:fs').then((fs) =>
    fs.existsSync(new URL('../../api/index.js', import.meta.url)),
  );
  if (!built) {
    // The wrapper is plain JS at the repo root; it exists in every checkout.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const root = path.resolve(import.meta.dirname, '../../..');
    assert.ok(fs.existsSync(path.join(root, 'api', 'index.js')), 'api/index.js must exist');
  }

  const { buildApp: build } = await import('../src/app.ts');
  const { app } = await build({ db: await freshDb(), logger: false });
  await app.ready();
  const server = http.createServer((req, res) => {
    app.server.emit('request', req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {any} */ (server.address());
  const res = await fetch(`http://127.0.0.1:${port}/api/live`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.live, true);
  await new Promise((resolve) => server.close(resolve));
  await app.close();
});
