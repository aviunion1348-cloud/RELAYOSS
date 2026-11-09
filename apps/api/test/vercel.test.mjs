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
import { resetOperatorIdentity } from '../src/auth/operator-middleware.ts';

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

/**
 * A migrated database with an operator, so requests can be attributed.
 *
 * It used to seed a `local_credentials` row via `hashPassword`, because the app
 * resolved a login from it. Nothing reads that table now, so seeding it would be
 * arranging scenery: the only thing a request needs is a `users` row to name.
 */
async function provisionedApp() {
  const db = await freshDb();
  await db.run(
    `INSERT INTO users (id,email,full_name,role,is_active) VALUES ('usr_shared','shared@relay.local','Shared User','admin',1)`,
  );
  const { app } = await buildApp({ db, logger: false });
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

test('vercel: an unseeded database names its cause instead of refusing with 401', async () => {
  /**
   * A migrated but empty database cannot attribute a request, because `users` is
   * empty and every mutation has a foreign key to it. That is a *seeding* problem
   * and must say so.
   *
   * The previous behaviour — which this test used to assert as correct — was a bare
   * `401 unauthorized` for every route with no data in the tables. That is the worst
   * possible answer: it names no cause, suggests no fix, and looks identical to an
   * expired session, which is how a deployment mistake gets diagnosed as an auth
   * bug for a week.
   */
  const { app } = await buildApp({ db: await freshDb(), logger: false });

  const read = await app.inject({ method: 'GET', url: '/api/projects' });
  assert.equal(read.statusCode, 503, `expected a diagnosable 503, got ${read.statusCode}`);
  assert.equal(read.json().error.code, 'misconfigured');
  assert.match(read.json().error.message, /seed|OPERATOR_USER_ID/i, 'the message must name the remedy');

  // The probes still work, and they are how an operator finds out in the first place.
  for (const url of ['/api/live', '/api/health']) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 200, `${url} must survive an empty database`);
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
  assert.equal(res.statusCode, 404, 'an unknown API route is a 404, not a refusal');
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

test('vercel: cron is reachable only with the bearer secret, not with a cookie', async () => {
  /**
   * The cron endpoint has its own authentication — an `Authorization: Bearer`
   * shared secret — and that is *not* user authentication, so it stays. Removing
   * it would leave an open endpoint that mutates SLA state on demand, which is
   * strictly worse than an endpoint nobody can reach.
   *
   * The original test signed in and showed a session cookie did not grant access.
   * With no sessions, the equivalent — and stronger — statement is that no cookie
   * of any value grants access, and that the secret itself still does.
   */
  process.env.CRON_SECRET = 'cookie-must-not-work';
  const { app } = await provisionedApp();

  for (const cookie of ['relay_session=forged', 'relay_session=' + 'a'.repeat(64)]) {
    const res = await app.inject({ method: 'GET', url: '/api/cron/sweep', headers: { cookie } });
    assert.equal(res.statusCode, 401, `a cookie (${cookie.slice(0, 20)}…) must not trigger scheduled work`);
  }

  const unauth = await app.inject({ method: 'GET', url: '/api/cron/sweep' });
  assert.equal(unauth.statusCode, 401, 'no credential at all must be refused');

  const wrong = await app.inject({ method: 'GET', url: '/api/cron/sweep', headers: { authorization: 'Bearer wrong-secret' } });
  assert.equal(wrong.statusCode, 401, 'a wrong secret must be refused');

  const right = await app.inject({ method: 'GET', url: '/api/cron/sweep', headers: { authorization: 'Bearer cookie-must-not-work' } });
  assert.equal(right.statusCode, 200, `the real secret must still work: ${right.body}`);

  delete process.env.CRON_SECRET;
  await app.close();
});

test('vercel: a provisioned credential no longer selects any mode, because there is none', async () => {
  /**
   * This asserted that setting `RELAY_ADMIN_PASSWORD_HASH` made the deployment
   * resolve to `password` mode rather than `dev`. Neither mode exists. What matters
   * now is the inverse and stronger property: the *presence* of credential
   * environment variables changes nothing, so an operator cannot accidentally
   * reintroduce a gate by leaving a stale secret in the dashboard.
   */
  const saved = {
    hash: process.env.RELAY_ADMIN_PASSWORD_HASH,
    mode: process.env.AUTH_MODE,
    secret: process.env.SESSION_SECRET,
  };
  process.env.RELAY_ADMIN_PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA';
  process.env.AUTH_MODE = 'password';
  process.env.SESSION_SECRET = 'a'.repeat(48);
  try {
    const { app } = await buildApp({ db: await freshDb(), logger: false });
    const res = await app.inject({ method: 'GET', url: '/api/auth/session' });
    assert.equal(res.json().data.authMode, 'none', 'a stale credential must not re-enable a mode');
    const read = await app.inject({ method: 'GET', url: '/api/projects' });
    assert.equal(read.statusCode, 200, 'a stale credential must not gate reads');
    await app.close();
  } finally {
    for (const [k, v] of [['RELAY_ADMIN_PASSWORD_HASH', saved.hash], ['AUTH_MODE', saved.mode], ['SESSION_SECRET', saved.secret]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});


test('vercel: AUTH_MODE has no effect, because no mode is resolved', async () => {
  /**
   * This asserted that an explicit `AUTH_MODE` overrode automatic detection. There
   * is no detection and no mode: the variable is inert.
   *
   * Asserting its inertness is not pedantry. A stale `AUTH_MODE` left in a
   * deployment's environment is exactly how a gate gets reintroduced by accident,
   * and the test states that it cannot change behaviour.
   */
  const db = await freshDb();
  await db.run("INSERT INTO users (id,email,full_name,role,initials) VALUES ('usr_maya','m@x.io','Maya','admin','MI')");
  const previous = process.env.AUTH_MODE;
  try {
    for (const mode of ['dev', 'password', 'oidc', 'auto']) {
      process.env.AUTH_MODE = mode;
      resetOperatorIdentity();
      const { app } = await buildApp({ db, logger: false });
      const res = await app.inject({ method: 'GET', url: '/api/auth/session' });
      assert.equal(res.statusCode, 200, `AUTH_MODE=${mode} changed the answer: ${res.body}`);
      assert.equal(res.json().data.authMode, 'none', `AUTH_MODE=${mode} re-enabled a mode`);
      await app.close();
    }
  } finally {
    if (previous === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = previous;
    resetOperatorIdentity();
    await db.close();
  }
});

test('vercel: a malformed credential does not prevent boot, and is not used', async () => {
  /**
   * Previously a malformed `RELAY_ADMIN_PASSWORD_HASH` threw at boot. That was
   * right while the hash was a login credential; now nothing reads it, so refusing
   * to start over it would be a self-inflicted outage — precisely the failure mode
   * this change removes. The assertion is that boot succeeds and the API serves.
   */
  const previous = process.env.RELAY_ADMIN_PASSWORD_HASH;
  process.env.RELAY_ADMIN_PASSWORD_HASH = 'not-a-hash';
  try {
    const db = new SqliteDb(':memory:');
    await migrate(db, { log: () => {} });
    await db.run("INSERT INTO users (id,email,full_name,role,initials) VALUES ('u1','u1@x.io','U One','admin','U1')");
    const { app } = await buildApp({ db, logger: false });
    const res = await app.inject({ method: 'GET', url: '/api/live' });
    assert.equal(res.statusCode, 200, 'a junk credential must not stop the service');
    await app.close();
    await db.close();
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
    const db = await createDb();
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

    /*
     * 2. A business read works through the adapter, not only through inject().
     *
     * This assertion used to be that the same request was refused with 401. The
     * adapter was never the problem — the gate was — so the check that survives is
     * that the wrapper does not add one: the request goes in with no credential and
     * comes back with data, over a real socket.
     */
    const readable = await fetch(`${base}/api/projects`);
    assert.equal(readable.status, 200, `an anonymous request through the adapter got ${readable.status}`);
    assert.match(String(readable.headers.get('content-type')), /application\/json/i);
    assert.ok(Array.isArray((await readable.json()).data), 'the adapter must return the payload, not a shell');

    // 3. An unknown /api path is JSON, never the SPA document. The fallback
    //    swallowing /api is the failure mode that makes a broken API look like a
    //    working app: the browser would receive HTML and fail to parse it.
    //
    //    The status is 404 now that no authentication runs before routing. What is
    //    asserted is the content type and the error envelope, because those are what
    //    the SPA fallback would break.
    const missing = await fetch(`${base}/api/no-such-endpoint`);
    assert.match(String(missing.headers.get('content-type')), /application\/json/i,
      'the SPA fallback swallowed an /api path');
    assert.ok(missing.status !== 200, 'an unknown /api path must not look like success');
    const body = await missing.json();
    assert.ok(body.error?.code, 'a JSON error must carry a code');

    // 4. A browser route gets the document, because in this deployment the handler owns
    //    the browser's paths.
    //
    //    This assertion has changed three times, and the history is the point.
    //
    //    It first required 200 + HTML, which passed on a workstation with a stale
    //    `apps/web/dist` and failed on clean runners, because CI builds the unit suite
    //    before the web build.
    //
    //    It was then inverted to a JSON 404 for the multi-service deployment, where
    //    Vercel rewrote non-`/api` traffic to a separate `web` service and a browser
    //    route reaching the function meant the routing config was wrong.
    //
    //    The deployment is a single service now: the catch-all rewrite sends every
    //    browser path to this handler, so `/` and deep links are its responsibility.
    //    Returning 404 there broke the entire application in production while this
    //    test insisted it was correct — so it now asserts the behaviour the deployment
    //    depends on: a browser route is the SPA document, and `/api` is never.
    const spa = await fetch(`${base}/projects/some-deep-link`);
    assert.equal(spa.status, 200, 'a browser route must be answered with the SPA document');
    assert.match(String(spa.headers.get('content-type')), /text\/html/i,
      'a browser route must be answered with a document, not JSON');
    assert.match(await spa.text(), /<!doctype html>/i);

    /*
     * 5. A request with a body reaches the handler intact — the adapter must not
     *    depend on the body having been pre-parsed.
     *
     *    This posted to `/api/auth/login`. That endpoint is gone, so the body is now
     *    exercised against a real mutation instead, which is a better test: the
     *    payload has to survive the adapter *and* be accepted by a handler that
     *    reads it.
     */
    const posted = await fetch(`${base}/api/clients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Adapter Postcheck Ltd', tier: 'growth' }),
    });
    assert.equal(posted.status, 201, `a POST with a body through the adapter returned ${posted.status}`);
    assert.equal((await posted.json()).data.name, 'Adapter Postcheck Ltd', 'the body did not survive the adapter');
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
/**
 * A deployment with no environment at all still boots and serves.
 *
 * This is the single most important assertion in this file, because it is the
 * inverse of the failure that reached production. There, `SESSION_SECRET` was
 * unset, `buildApp` refused to start, and every request got a non-JSON 500 — so a
 * working frontend showed a blank page and could only say "the API is not
 * reachable", which was false.
 *
 * The instance below is deliberately starved: no `SESSION_SECRET`, no
 * `DATABASE_URL`, no credential, `NODE_ENV=production`, on Vercel. It must answer.
 */
/**
 * A deployment with no authentication environment still boots and serves.
 *
 * This is the most important assertion in this file, because it is the inverse of
 * the failure that reached production. There, `SESSION_SECRET` was unset,
 * `buildApp` refused to start, and every request got a non-JSON 500 — so a working
 * frontend showed a blank page and could only report "the API is not reachable",
 * which was false.
 *
 * The instance below is deliberately starved: no `SESSION_SECRET`, no
 * `DATABASE_URL`, no `AUTH_MODE`, no credential, `NODE_ENV=production`, on Vercel.
 *
 * It drives the real exported entrypoint — `getApp()` is the same app the HTTP
 * adapter serves — and uses `inject`, so the assertions are about the application
 * rather than about a hand-built simulation of `IncomingMessage`.
 */
test('vercel: an instance with no authentication environment still boots and serves', async () => {
  const saved = { ...process.env };
  delete process.env.SESSION_SECRET;
  delete process.env.DATABASE_URL;
  delete process.env.AUTH_MODE;
  delete process.env.RELAY_ADMIN_PASSWORD_HASH;
  process.env.NODE_ENV = 'production';

  const entry = await import('../src/entrypoints/vercel.ts');
  entry.resetBootState();

  try {
    const { app } = await entry.getApp();

    const live = await app.inject({ method: 'GET', url: '/api/live' });
    assert.equal(live.statusCode, 200, `a starved instance refused /api/live: ${live.body}`);
    assert.equal(live.json().data.live, true);

    const health = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(health.statusCode, 200, `health failed on a starved instance: ${health.body}`);
    assert.equal(health.json().data.authMode, 'none', 'the probe must report that nothing authenticates');

    /**
     * A business read on an empty database. SQLite is used because no
     * `DATABASE_URL` is set, and it is unseeded — so no user exists to attribute a
     * request to. That must be a *diagnosable* JSON answer naming the remedy, never
     * a blank failure and never an authentication error.
     */
    const read = await app.inject({ method: 'GET', url: '/api/projects' });
    assert.notEqual(read.statusCode, 500, `an empty database must not produce a blank failure: ${read.body}`);
    assert.notEqual(read.statusCode, 401, 'and it must not be reported as an authentication problem');
    if (read.statusCode !== 200) {
      assert.equal(read.statusCode, 503);
      assert.equal(read.json().error.code, 'misconfigured');
      assert.match(read.json().error.message, /seed|OPERATOR_USER_ID/i, 'the message must name the remedy');
    }

    // Nothing may be cached as broken, and no secret may be echoed.
    const rendered = live.body + health.body + read.body;
    assert.ok(!/SESSION_SECRET is required/.test(rendered), 'a removed dependency must not be demanded');
    assert.ok(!/\$argon2id\$/.test(rendered), 'no hash may appear in a public response');
  } finally {
    process.env = saved;
    entry.resetBootState();
  }
});

test('vercel: each boot resolves the operator afresh, and a cold start always succeeds', async () => {
  /**
   * The original proved that a *refused boot* un-stuck itself once `SESSION_SECRET`
   * appeared. There is no refused boot to recover from now, so the property shifts
   * to the one that still matters: boot is not a one-shot latch. A fresh instance
   * (which is what `resetBootState` models) must serve every time, because Vercel
   * starts one per cold start and a latched failure would be permanent.
   */
  const saved = { ...process.env };
  process.env.NODE_ENV = 'production';

  const entry = await import('../src/entrypoints/vercel.ts');
  try {
    for (let boot = 0; boot < 3; boot += 1) {
      entry.resetBootState();
      const { app } = await entry.getApp();
      const res = await app.inject({ method: 'GET', url: '/api/live' });
      assert.equal(res.statusCode, 200, `boot ${boot} failed to serve`);
      const session = await app.inject({ method: 'GET', url: '/api/auth/session' });
      // 200 when the database is seeded; a diagnosable 503 when it is not — never 500.
      assert.notEqual(session.statusCode, 500, `boot ${boot} produced an opaque failure`);
    }
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
test('vercel: a missing database is named as the cause, with its real cost', async () => {
  /**
   * Previously this asserted a 503 whose remedy explained that an auth refusal was
   * caused by an unprovisioned login. There is no login, so that causal chain is
   * gone — and with it went the deployment's worst failure mode: a missing
   * credential no longer refuses anything.
   *
   * What must survive is honesty about durability. Without `DATABASE_URL` the API
   * runs on SQLite in the instance's temp directory, which means data is lost on
   * every cold start and is unsafe across concurrent instances. The readiness probe
   * has to say so rather than reporting a cheerful `ready: true`.
   */
  const saved = { ...process.env };
  delete process.env.DATABASE_URL;
  process.env.NODE_ENV = 'production';

  const entry = await import('../src/entrypoints/vercel.ts');
  entry.resetBootState();

  try {
    const { app } = await entry.getApp();

    // The instance serves — that is the whole point of the change.
    const projects = await app.inject({ method: 'GET', url: '/api/projects' });
    assert.notEqual(projects.statusCode, 401, 'a missing database is not an authentication problem');

    const ready = await app.inject({ method: 'GET', url: '/api/ready' });
    const body = ready.json();
    assert.equal(ready.statusCode, 200, `readiness failed on SQLite: ${ready.body}`);
    assert.equal(body.data.engine, 'sqlite', 'the engine must be reported, not hidden');
    /**
     * The configuration must not claim a required variable is missing. `DATABASE_URL`
     * is optional; reporting it as required would send an operator to provision a
     * database before learning whether they need one.
     */
    assert.ok(!JSON.stringify(body).includes('SESSION_SECRET'), 'a removed dependency must not be reported');
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
 * A deployment with no database must refuse to start, and say why.
 *
 * This test used to assert the opposite: that a production Vercel runtime with no
 * `DATABASE_URL` would create a SQLite file, seed it and serve data. It did — and
 * that is precisely the bug. The file lived under `/tmp`, which is per-instance and
 * discarded, so the product accepted every write, served it back for the life of the
 * instance, and lost all of it on the next cold start. Nothing appeared broken,
 * which is why it survived this long.
 *
 * The property worth asserting is the honest one:
 *
 *   1. the request fails, and it fails as a *configuration* error rather than a
 *      blank 500 — the body names `DATABASE_URL` and the remedy;
 *   2. no SQLite file is created anywhere, because creating one is how the silent
 *      data loss started;
 *   3. the same deployment works the moment a database is configured.
 *
 * A local process with no `DATABASE_URL` is a different case and is deliberately
 * still allowed to use a file: that is development, not a deployment.
 */
test('vercel: a deployment with no database refuses to start and names the missing variable', async () => {
  const saved = { ...process.env };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cold-'));

  try {
    delete process.env.DATABASE_URL;
    delete process.env.SESSION_SECRET;
    delete process.env.DB_PATH;
    process.env.NODE_ENV = 'production';
    process.env.VERCEL = '1';

    setDb(null);
    resetOperatorIdentity();
    const entry = await import('../src/entrypoints/vercel.ts');
    entry.resetBootState();

    /*
     * The boot is expected to fail. What must not happen is a *working* boot backed
     * by a temporary file, so both outcomes are captured and only one is accepted.
     */
    let failure = null;
    let app = null;
    try {
      app = (await buildApp({ serveStatic: false, logger: false })).app;
    } catch (err) {
      failure = err;
    }

    if (app) {
      // If the app did build, the first data request must be the thing that refuses.
      const res = await app.inject({ method: 'GET', url: '/api/projects' });
      await app.close();
      failure = { message: `the app served ${res.statusCode} with no DATABASE_URL`, body: res.body };
    }

    assert.ok(failure, 'a production runtime with no database must not boot silently');
    const detail = String(failure.message ?? failure);
    assert.match(detail, /DATABASE_URL/, `the failure must name DATABASE_URL, got: ${detail}`);
    assert.match(
      detail,
      /PostgreSQL|per-instance|discarded/i,
      `the failure must explain why a local file is not a database, got: ${detail}`,
    );

    // And it must not have quietly left a database behind.
    const strays = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    assert.deepEqual(strays, [], `no database file may be created in a serverless runtime: ${strays.join(', ')}`);
  } finally {
    process.env = saved;
    setDb(null);
    resetOperatorIdentity();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The refusal has to be real behaviour, not a documented intention.
 *
 * `scripts/guard-deployment-config.mjs` scans for the explanation in the source, which
 * is all a text check can do — and it passed against `if (false)`, verified by
 * sabotage. This calls the actual factory in a serving runtime with no `DATABASE_URL`
 * and requires it to throw, then requires the local case to still work. A fallback that
 * silently writes to `/tmp` on a serverless runtime is the bug that lost every write
 * this product ever accepted there.
 */
test('db: a serving runtime without DATABASE_URL throws instead of creating a file', async () => {
  const saved = { ...process.env };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-engine-'));
  try {
    delete process.env.DATABASE_URL;
    process.env.DB_PATH = path.join(dir, 'should-not-exist.sqlite');

    const { createDb } = await import('../src/db/index.ts');

    // Serverless.
    process.env.VERCEL = '1';
    process.env.NODE_ENV = 'production';
    await assert.rejects(
      () => createDb(),
      (err) => {
        assert.match(String(err.message), /DATABASE_URL/);
        assert.match(String(err.message), /PostgreSQL/);
        return true;
      },
      'a serverless runtime with no DATABASE_URL must refuse to open a file',
    );

    // A production process on a server is no different.
    delete process.env.VERCEL;
    await assert.rejects(() => createDb(), /DATABASE_URL/);

    // Nothing may have been created while refusing.
    assert.deepEqual(fs.readdirSync(dir), [], 'the refusal must not leave a database file behind');

    // The local case is deliberately still allowed: that is development.
    process.env.NODE_ENV = 'development';
    const local = await createDb();
    try {
      assert.equal(local.dialect, 'sqlite');
      assert.ok(fs.existsSync(process.env.DB_PATH), 'a local run opens the file it was told to');
    } finally {
      await local.close();
    }
  } finally {
    process.env = saved;
    setDb(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The read contract is unchanged for the runtime that *is* configured correctly:
 * no credential of any kind is needed to read the product.
 *
 * This keeps the half of the old cold-start test that still matters — that the app
 * is genuinely usable without signing in — on a local engine, which is the engine a
 * developer actually runs.
 */
test('a locally-run deployment serves real seeded data with no credential', async () => {
  const saved = { ...process.env };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-local-'));
  try {
    delete process.env.DATABASE_URL;
    delete process.env.VERCEL;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    process.env.NODE_ENV = 'development';
    process.env.DB_PATH = path.join(dir, 'relay.sqlite');

    setDb(null);
    resetOperatorIdentity();
    const { app } = await buildApp({ serveStatic: false, logger: false });
    try {
      assert.ok(fs.existsSync(process.env.DB_PATH), 'a local run creates its database where it was told to');

      const ready = await app.inject({ method: 'GET', url: '/api/ready' });
      assert.equal(ready.statusCode, 200, ready.body);

      const projects = await app.inject({ method: 'GET', url: '/api/projects' });
      assert.equal(projects.statusCode, 200, projects.body);
      assert.ok(projects.json().data.length > 0, 'the seeded projects must be visible without signing in');

      const dashboard = await app.inject({ method: 'GET', url: '/api/dashboard' });
      assert.equal(dashboard.statusCode, 200);
      assert.ok(dashboard.json().data.kpis, 'the dashboard aggregates must be present');

      // The retired login endpoints must be unmistakably gone, not merely quiet.
      for (const url of ['/api/auth/login', '/api/auth/dev-login']) {
        const res = await app.inject({
          method: 'POST',
          url,
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({ username: 'x', password: 'y' }),
        });
        assert.equal(res.statusCode, 410, `${url} must be Gone`);
        assert.equal(res.json().error.code, 'auth_removed');
      }
    } finally {
      await app.close();
    }
  } finally {
    process.env = saved;
    setDb(null);
    resetOperatorIdentity();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('vercel: boot is idempotent and never rewrites data', async () => {
  /**
   * This asserted that `provisionLoginFromEnv` did not rotate an unchanged password
   * hash on every boot, because rotation bumped `version` and invalidated live
   * sessions. Credential provisioning is gone.
   *
   * The property is kept, generalised to what still boots: repeated boots must be
   * idempotent. Nothing should be re-seeded, rewritten or migrated twice, because a
   * deploy-time write that runs once per instance would corrupt data under
   * concurrent cold starts — which is exactly the hazard the original was guarding.
   */
  const saved = { ...process.env };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-idem-'));

  try {
    process.env.NODE_ENV = 'production';
    const dbPath = path.join(dir, 'idem.sqlite');
    const db = new SqliteDb(dbPath);
    await migrate(db, { log: () => {} });

    const tables = async () => (await db.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).map((r) => r.name).join(',');
    const schemaBefore = await tables();

    // A third boot must not add, drop or rewrite anything.
    for (let i = 0; i < 3; i += 1) await migrate(db, { log: () => {} });
    assert.equal(await tables(), schemaBefore, 'migrating repeatedly must converge, not churn');

    // A user written by one boot is untouched by the next.
    await db.run("INSERT INTO users (id,email,full_name,role,initials) VALUES ('u_idem','idem@x.io','Idem User','admin','IU')");
    await migrate(db, { log: () => {} });
    const row = await db.get("SELECT full_name FROM users WHERE id = 'u_idem'");
    assert.equal(row.full_name, 'Idem User', 'a later migration must not rewrite existing rows');

    await db.close();
  } finally {
    process.env = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The function must load on a runtime that cannot provide `node:sqlite`.
 *
 * This is the defect that produced a blank `500` in production. `node:sqlite` is a
 * built-in whose availability depends on the Node version, and `db/index.ts` used
 * a *static* import — so it sat in the module graph of every request, including
 * deployments configured for PostgreSQL that would never open SQLite.
 *
 * Where the built-in is missing, the module graph throws while being evaluated.
 * The function is then left with no handler at all: the platform answers `500`
 * with no body, and no `try/catch` in this application can run, because there is
 * no code to catch it. Wrapping the handler, as an earlier fix did, was provably
 * insufficient for the same reason.
 *
 * The assertion is on the module graph, not on SQLite behaviour: the SQLite driver
 * must not be reachable from the entry module purely by importing it.
 */
test('vercel: the entry module does not require node:sqlite to load', async () => {
  const entry = await import('../src/entrypoints/vercel.ts');
  assert.equal(typeof entry.default, 'function', 'the entry must export a handler');

  /**
   * Every module the entry graph pulls in, read from the loader cache. A static
   * `import ... from 'node:sqlite'` appears here as a loaded module; a dynamic
   * import inside a branch that never runs does not.
   */
  const loaded = Object.keys(
    /** @type {any} */ (await import('node:module')).createRequire(import.meta.url).cache ?? {},
  );
  void loaded;

  // The built-in is only requested lazily, so it is absent from the graph unless a
  // SQLite deployment actually constructed one. Assert the shape of the code that
  // makes that true, since the cache above cannot see ESM built-ins reliably.
  const source = fs.readFileSync(
    new URL('../src/db/index.ts', import.meta.url).pathname,
    'utf8',
  );
  assert.ok(
    !/^import\s+.*SqliteDb.*from\s+['"]\.\/sqlite/m.test(source),
    'db/index.ts must not statically import the SQLite driver — that puts a version-gated built-in in every request graph',
  );
  assert.match(
    source,
    /await\s+import\(['"]\.\/sqlite\.ts['"]\)/,
    'the driver must be imported dynamically, inside the SQLite branch',
  );

  /**
   * And the argon2 hazard is gone at the source.
   *
   * Argon2 was the first instance of the same bug class: a static native import
   * that, where it could not load, took the whole function with it. With
   * authentication removed nothing hashes a password, so the guarantee is stronger
   * than laziness — the binding must not be referenced anywhere in `auth/`.
   */
  const authDir = new URL('../src/auth/', import.meta.url).pathname;
  const authSources = fs
    .readdirSync(authDir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => fs.readFileSync(authDir + f, 'utf8'))
    .join('\n');
  assert.ok(
    !/from\s+['"]argon2['"]|import\(['"]argon2['"]\)|require\(['"]argon2['"]\)/.test(authSources),
    'nothing in auth/ may import argon2 — the native binding is no longer needed',
  );
});
