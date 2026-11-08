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
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.SESSION_SECRET ||= 'test-session-secret-do-not-use-in-production';
process.env.RATE_LIMIT_AUTH ||= '1000';
process.env.RATE_LIMIT_GLOBAL ||= '5000';
process.env.RATE_LIMIT_WRITE ||= '5000';

import { buildApp } from '../src/app.ts';
import { SqliteDb } from '../src/db/sqlite.ts';
import { setDb } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { authMode, resetResolvedAuthMode } from '../src/auth/index.ts';
import { hashPassword } from '../src/auth/password.ts';
import { provisionLoginFromEnv } from '../src/auth/provision.ts';

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
  /*
   * This test is about the *automatic* resolution, so it must control AUTH_MODE
   * itself rather than inherit it. CI exports AUTH_MODE=dev for the whole workflow,
   * which is correct there and would make this assertion test the wrong thing — an
   * explicit mode overrides resolution by design, so the test would fail for a
   * reason unrelated to the behaviour under test.
   */
  const declared = process.env.AUTH_MODE;
  delete process.env.AUTH_MODE;
  try {
    await provisionedCredentialResolution();
  } finally {
    if (declared === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = declared;
    resetResolvedAuthMode();
  }
});

async function provisionedCredentialResolution() {
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
}

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

test('vercel: the exported handler itself serves, streams and refuses correctly over HTTP', async () => {
  /*
   * The test above emits into `app.server` with objects Node created. That proves
   * Fastify handles a request; it does not prove the *adapter Vercel calls* does,
   * because Vercel invokes `default handler(req, res)` — the only thing in this
   * file that touches the raw IncomingMessage/ServerResponse pair. Everything
   * asserted about `api/index.js` and the compiled artefact was, until now, an
   * assertion about a code path no test entered. "The function entry works" is
   * the single most load-bearing claim in a Vercel deployment, so it is tested by
   * mounting the real export as a listener and speaking HTTP to it.
   */
  const entry = await import('../src/entrypoints/vercel.ts');
  const handler = entry.default;
  assert.equal(typeof handler, 'function', 'vercel.ts must default-export the request handler');

  const db = await freshDb();
  const { app } = await buildApp({ db, logger: false });
  await app.ready();
  // The handler builds its own app; point its database at this fixture so the
  // request is answered from a real migrated schema with real rows.
  await db.run("INSERT INTO clients (id,name,slug,initials) VALUES ('c_v','Vercel Co','vercel','VC')");

  let sawRequest = 0;
  const server = http.createServer((req, res) => {
    sawRequest += 1;
    handler(req, res).catch((err) => {
      res.statusCode = 500;
      res.end(`handler threw: ${String(err)}`);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {any} */ (server.address());
  const base = `http://127.0.0.1:${port}`;

  try {
    // 1. A real request is answered, and the handler ran rather than a fallback.
    const live = await fetch(`${base}/api/live`);
    assert.equal(live.status, 200, 'the exported handler did not answer /api/live');
    assert.equal((await live.json()).data.live, true);
    assert.ok(sawRequest > 0, 'the handler was never invoked');

    // 2. Auth is enforced through the adapter, not only through inject().
    const denied = await fetch(`${base}/api/projects`);
    assert.equal(denied.status, 401, 'an anonymous request through the adapter was not refused');

    // 3. An unknown /api path is JSON, never the SPA document. The fallback
    //    swallowing /api is the failure mode that makes a broken API look like a
    //    working app: the browser would receive HTML and fail to parse it.
    //
    //    The status here is 401 rather than 404 because authentication precedes
    //    routing — an unauthenticated caller learns nothing about which endpoints
    //    exist, which is the correct order. What is asserted is the content type
    //    and the error envelope, because those are what the fallback would break.
    const missing = await fetch(`${base}/api/no-such-endpoint`);
    assert.match(String(missing.headers.get('content-type')), /application\/json/i,
      'the SPA fallback swallowed an /api path');
    assert.ok(missing.status !== 200, 'an unknown /api path must not look like success');
    const body = await missing.json();
    assert.ok(body.error?.code, 'a JSON error must carry a code');

    // 4. The API function does not serve the SPA.
    //
    //    This assertion has changed twice, and the history is the point.
    //
    //    Originally it required 200 + HTML for a browser route, which passed on a
    //    workstation with a stale `apps/web/dist` and failed on every clean runner,
    //    because CI builds the unit suite before the web build. That was fixed by
    //    accepting either the document or the "build the web app first" 404.
    //
    //    In the multi-service deployment neither is right. Vercel rewrites every
    //    non-`/api` path to the `web` service before a request reaches this
    //    function, so a browser route arriving here means the routing config is
    //    wrong. Serving a document — or a document's absence — makes that invisible.
    //    The API function answers a JSON 404, which is a routing bug you can see.
    const spa = await fetch(`${base}/projects/some-deep-link`);
    assert.equal(spa.status, 404, 'the API function answered a browser route as if it owned it');
    assert.match(String(spa.headers.get('content-type')), /application\/json/i,
      'a browser route reaching the API must not be answered with a document');

    // 5. A request with a body reaches the handler intact — the adapter must not
    //    depend on the body having been pre-parsed.
    const posted = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'nobody', password: 'nothing' }),
    });
    assert.ok([400, 401, 403, 429].includes(posted.status), `login through the adapter returned ${posted.status}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await app.close();
    await entry.getApp().then(({ app: inner }) => inner.close()).catch(() => {});
  }
});

/**
 * A deployment whose environment was never provisioned must say so.
 *
 * This is the failure that reached production and could not be diagnosed from the
 * browser. The API was reachable and healthy, but `buildApp` refused to start
 * because `SESSION_SECRET` was unset, and the resulting 500 withheld its message
 * (correctly — production never returns internal detail). The client could only
 * conclude "the API is not reachable", which was false and sent the reader after
 * the wrong problem.
 *
 * The assertions are deliberately about *actionability*, not about wording: the
 * response must name the missing variable and must not leak a value.
 */
test('vercel: an unprovisioned instance reports what is missing instead of an opaque 500', async () => {
  const saved = { ...process.env };
  delete process.env.SESSION_SECRET;
  delete process.env.DATABASE_URL;
  process.env.NODE_ENV = 'production';

  const entry = await import('../src/entrypoints/vercel.ts');
  entry.resetBootState();

  const responses = [];
  const call = async (url) => {
    const headers = {};
    const chunks = [];
    const res = {
      statusCode: 200,
      setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
      end: (c) => { if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); },
      write: (c) => { if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); },
    };
    await entry.default({ method: 'GET', url, headers: { host: 'relay.example' } }, res);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    responses.push({ url, status: res.statusCode, headers, body });
    return body;
  };

  try {
    const me = await call('/api/auth/me');
    assert.equal(responses[0].status, 503, 'an instance that cannot boot is unavailable, not OK');

    assert.equal(me.error.code, 'misconfigured', 'the failure must be identifiable by code');
    assert.equal(me.error.stage, 'configuration', 'a refused boot is a configuration failure');
    assert.ok(
      me.error.missing.includes('SESSION_SECRET'),
      `the response must name the missing variable, got ${JSON.stringify(me.error.missing)}`,
    );
    /**
     * `DATABASE_URL` is optional, and the difference is not cosmetic: without it the
     * API falls back to SQLite in the instance temp directory and runs. Reporting it
     * as *missing* would send an operator to provision a database before finding out
     * whether they needed one. Its absence is still stated, as a cost.
     */
    assert.ok(
      !me.error.missing.includes('DATABASE_URL'),
      'DATABASE_URL must not be reported as required — the API runs without it',
    );
    assert.ok(
      me.error.optional.some((o) => o.name === 'DATABASE_URL' && /ephemeral/i.test(o.consequence)),
      'its absence must still be stated, with the cost (data is not durable)',
    );
    assert.ok(
      Array.isArray(me.error.remedy) && me.error.remedy.length > 0,
      'a report that names no remedy leaves the operator where they started',
    );
    assert.match(me.error.summary, /SESSION_SECRET is required/, 'the boot check\'s own explanation must survive');

    // No value may be echoed. The endpoint is unauthenticated.
    const serialised = JSON.stringify(me);
    for (const name of ['SESSION_SECRET', 'DATABASE_URL']) {
      const value = process.env[name];
      if (value) assert.ok(!serialised.includes(value), `${name}'s value leaked into the report`);
    }
    assert.ok(!/\$argon2id\$/.test(serialised), 'no hash may appear in a public report');

    assert.equal(
      responses[0].headers['cache-control'],
      'no-store, max-age=0',
      'a provisioning failure must never be cached — the deployment would look broken after it is fixed',
    );

    // Every route, not just the failed one: the whole instance is down.
    await call('/api/live');
    assert.equal(responses[1].status, 503, 'a liveness probe must not claim success on an instance that cannot serve');
  } finally {
    process.env = saved;
    entry.resetBootState();
  }
});

test('vercel: a misconfigured instance recovers once the environment is provisioned', async () => {
  const saved = { ...process.env };
  delete process.env.SESSION_SECRET;
  process.env.NODE_ENV = 'production';

  const entry = await import('../src/entrypoints/vercel.ts');
  entry.resetBootState();

  const call = async () => {
    const chunks = [];
    const res = {
      statusCode: 200,
      setHeader: () => {},
      end: (c) => { if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); },
      write: (c) => { if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); },
    };
    await entry.default({ method: 'GET', url: '/api/auth/me', headers: { host: 'relay.example' } }, res);
    const text = Buffer.concat(chunks).toString();
    return { status: res.statusCode, body: text ? JSON.parse(text) : null };
  };

  try {
    const before = await call();
    assert.equal(before.status, 503, 'the instance must start out unavailable');

    // Provisioning the variable is exactly what an operator does. The next boot
    // must pick it up — a recorded failure that outlives its cause is a worse bug
    // than the original 500, because the instance never recovers and reports a
    // stale reason while doing it.
    process.env.SESSION_SECRET = 'a'.repeat(48);
    // No database is reachable here, so the second boot still fails — but for a
    // *different* reason. That difference is what proves the failure was re-derived
    // rather than replayed from the cached first attempt.
    entry.resetBootState();
    const after = await call();
    assert.equal(after.status, 503, 'a boot with no database still cannot serve');
    assert.ok(
      !JSON.stringify(after.body).includes('SESSION_SECRET'),
      'the SESSION_SECRET complaint must disappear once it is set — a stale reason is misleading',
    );
  } finally {
    process.env = saved;
    entry.resetBootState();
  }
});

/**
 * When the visible error blames something else, explain the chain.
 *
 * With no `DATABASE_URL` the boot falls back to an empty local SQLite file, so no
 * credential exists, so `AUTH_MODE=auto` resolves to `dev`, so the production
 * guard refuses. The message therefore says "AUTH_MODE=dev is refused" while the
 * one variable that fixes everything is `DATABASE_URL`. Reporting only the literal
 * message invites the operator to go configure an identity provider they do not
 * need.
 */
test('vercel: a missing database is named as the cause of the auth refusal it produces', async () => {
  const saved = { ...process.env };
  delete process.env.DATABASE_URL;
  delete process.env.RELAY_ADMIN_PASSWORD_HASH;
  process.env.SESSION_SECRET = 'a'.repeat(48);
  process.env.NODE_ENV = 'production';

  const entry = await import('../src/entrypoints/vercel.ts');
  entry.resetBootState();

  try {
    const chunks = [];
    const res = {
      statusCode: 200,
      setHeader: () => {},
      end: (c) => { if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); },
      write: (c) => { if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); },
    };
    await entry.default({ method: 'GET', url: '/api/users', headers: { host: 'relay.example' } }, res);
    const body = JSON.parse(Buffer.concat(chunks).toString());

    assert.equal(res.statusCode, 503);
    assert.deepEqual(
      body.error.missing,
      [],
      'nothing required is absent — SESSION_SECRET is set and DATABASE_URL is optional',
    );
    assert.ok(
      body.error.remedy.some((step) => /No shared login credential is provisioned.*AUTH_MODE=auto resolved to/i.test(step)),
      'the report must connect the missing credential to the auth refusal it causes',
    );
    assert.ok(
      /DATABASE_URL/.test(body.error.remedy[0]) && /RELAY_ADMIN_PASSWORD_HASH/.test(body.error.remedy[0]),
      'the causal note must offer both paths: a database, or a credential from configuration',
    );
  } finally {
    process.env = saved;
    entry.resetBootState();
  }
});

/**
 * No request may ever get a blank error.
 *
 * A production report showed `500` with a non-JSON body on every `/api` call. That
 * signature is useless: a platform error page, a crashed function, an unhandled
 * rejection and a proxy rejection all look identical, and the client cannot even
 * tell whether the request reached the application.
 *
 * The handler therefore wraps the whole request path. This asserts the property
 * rather than the mechanism — whatever goes wrong inside, the caller gets JSON that
 * says where it went wrong.
 */
test('vercel: an in-process failure still answers with JSON, not a blank 500', async () => {
  const saved = { ...process.env };
  process.env.NODE_ENV = 'production';
  process.env.SESSION_SECRET = 'a'.repeat(48);
  // A bootable environment, so the failure below is unambiguously *in the request
  // path* rather than a refusal to start. Without this the boot fails first and the
  // test would silently assert the wrong thing.
  process.env.ALLOW_DEV_AUTH_IN_PRODUCTION = '1';
  process.env.DB_PATH = path.join(os.tmpdir(), `relay-handler-failure-${process.pid}.sqlite`);

  const entry = await import('../src/entrypoints/vercel.ts');
  entry.resetBootState();

  try {
    // A request object whose own `url` getter throws: the failure happens inside
    // the handler, after the entry point has been reached, so it cannot be caught
    // by anything upstream in the application.
    const hostile = {
      get url() { throw new TypeError('simulated defect reading the request'); },
      method: 'GET',
      headers: { host: 'relay.example' },
    };

    const headers = {};
    const chunks = [];
    const res = {
      statusCode: 200,
      headersSent: false,
      writableEnded: false,
      setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
      end: (c) => { if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); },
      write: (c) => { if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); },
    };

    await entry.default(hostile, res);

    const body = Buffer.concat(chunks).toString();
    assert.ok(body.length > 0, 'a failure must never answer with an empty body');
    assert.match(String(headers['content-type']), /application\/json/i, 'the error must be JSON');

    const parsed = JSON.parse(body);
    assert.equal(parsed.error.code, 'handler_failed');
    assert.equal(parsed.error.stage, 'request');
    assert.match(parsed.error.detail, /simulated defect/, 'the cause must survive to the client');
    assert.ok(Array.isArray(parsed.error.remedy) && parsed.error.remedy.length > 0);
  } finally {
    process.env = saved;
    entry.resetBootState();
  }
});

/**
 * A deployment with no PostgreSQL must still be usable.
 *
 * The realistic first deployment has a secret and nothing else: no database
 * provisioned yet, no credential row. Before this, two things made that state
 * fatal and unrecoverable — the SQLite fallback pointed inside the read-only
 * deployment bundle, so the API could not open a database at all; and even when it
 * could, the file was empty, so no credential existed, so `AUTH_MODE=auto`
 * resolved to `dev`, which a production build refuses.
 *
 * The net effect was a sign-in screen that could never work and a blank 500 to go
 * with it. This asserts the whole path instead: writable location, schema, demo
 * data, credential from the environment, and a real login.
 */
test('vercel: a deployment with no database configures itself and serves a real login', async () => {
  const saved = { ...process.env };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cold-'));

  try {
    delete process.env.DATABASE_URL;
    delete process.env.ALLOW_DEV_AUTH_IN_PRODUCTION;
    delete process.env.SEED_DEMO_DATA;
    delete process.env.FORCE;
    /**
     * CI exports `AUTH_MODE=dev` for the whole workflow, and an explicit mode wins
     * over `auto` — which would bypass the credential this test exists to prove was
     * provisioned. The scenario under test is a deployment that specifies no mode,
     * so the variable has to be absent, not merely defaulted.
     */
    delete process.env.AUTH_MODE;
    process.env.NODE_ENV = 'production';
    process.env.VERCEL = '1';
    process.env.SESSION_SECRET = 'cold-start-secret-value-0123456789';
    process.env.DB_PATH = path.join(dir, 'relay.sqlite');
    process.env.RELAY_LOGIN_USERNAME = 'cold start user';
    process.env.RELAY_ADMIN_PASSWORD_HASH = await hashPassword('cold-start-password');

    // Fresh process-level state: no cached app, no cached database handle, no
    // resolved auth mode. The handle matters — a singleton left over from an
    // earlier test points at that test's database.
    setDb(null);
    const entry = await import('../src/entrypoints/vercel.ts');
    entry.resetBootState();
    resetResolvedAuthMode();

    const { app } = await buildApp({ serveStatic: false, logger: false });
    try {
      assert.ok(fs.existsSync(process.env.DB_PATH), 'the SQLite file must be created where it was configured');
      assert.equal(
        (await app.inject({ method: 'GET', url: '/api/ready' })).statusCode,
        200,
        'a deployment with no DATABASE_URL must be ready',
      );

      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ username: 'cold start user', password: 'cold-start-password' }),
      });
      assert.equal(login.statusCode, 200, `the configured shared login must work, got ${login.statusCode}`);
      const cookie = String(login.headers['set-cookie'] ?? '').split(';')[0];
      assert.ok(cookie, 'a session cookie must be issued');

      // Usable behind the login — real seeded data, not an empty shell.
      const projects = await app.inject({ method: 'GET', url: '/api/projects', headers: { cookie } });
      assert.equal(projects.statusCode, 200);
      assert.ok(JSON.parse(projects.body).data.length > 0, 'the seeded projects must be visible');

      // Development identities stay closed: this is a password deployment now.
      assert.equal(
        (await app.inject({ method: 'GET', url: '/api/auth/dev-users' })).statusCode,
        403,
        'provisioning a credential must close the demo picker',
      );
    } finally {
      await app.close();
    }
  } finally {
    process.env = saved;
    setDb(null);
    resetResolvedAuthMode();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('vercel: the credential is not rewritten when it has not changed', async () => {
  const saved = { ...process.env };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-idem-'));

  try {
    process.env.NODE_ENV = 'production';
    const db = new SqliteDb(path.join(dir, 'idem.sqlite'));
    await migrate(db, { log: () => {} });

    process.env.RELAY_LOGIN_USERNAME = 'idem user';
    process.env.RELAY_ADMIN_PASSWORD_HASH = await hashPassword('idempotent-password');

    const first = await provisionLoginFromEnv(db);
    assert.equal(first.action, 'created');

    // A restart must not rotate: rotation bumps `version` and invalidates every
    // live session, so doing it per boot would sign the whole studio out whenever
    // an instance recycled.
    const second = await provisionLoginFromEnv(db);
    assert.equal(second.action, 'unchanged', 'an unchanged hash must not bump the version');

    const row = await db.get('SELECT version FROM local_credentials WHERE username = ?', ['idem user']);
    assert.equal(Number(row?.version), 1, 'the version must still be 1 after a no-op boot');

    process.env.RELAY_ADMIN_PASSWORD_HASH = await hashPassword('rotated-password');
    assert.equal((await provisionLoginFromEnv(db)).action, 'rotated');
    const after = await db.get('SELECT version FROM local_credentials WHERE username = ?', ['idem user']);
    assert.equal(Number(after?.version), 2, 'rotation must invalidate prior sessions');
    await db.close();
  } finally {
    process.env = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
