/**
 * Shared rate limiting, exercised against a real database.
 *
 * The point of these tests is the property the in-process limiter cannot have:
 * **a limit that survives more than one process and is enforced atomically.** Each
 * test therefore uses the shared store directly with an explicit clock, and the
 * concurrency test issues genuinely parallel calls rather than sequential ones.
 *
 * What is asserted, and why each matters:
 *
 *   - the limit is enforced at exactly the boundary (not one over, not one under)
 *   - a refused request does not consume a token, so refusal is not itself a denial
 *     of service against legitimate callers
 *   - the window reopens on time
 *   - concurrent callers cannot exceed the limit — the check-then-act race that a
 *     naive implementation has
 *   - lockout backoff grows and then clears on success
 *   - expired rows are pruned, so the tables do not grow without bound
 *   - the same behaviour on SQLite and PostgreSQL, because a rate limiter that only
 *     works on the engine you did not deploy is not a rate limiter
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

// SESSION_SECRET is checked at boot, and this file builds a real application in one
// test. Provide a throwaway value the way every other suite does, rather than relying
// on whatever the runner happens to export.
process.env.SESSION_SECRET ||= 'test-session-secret-do-not-use-in-production';
process.env.RATE_LIMIT_AUTH ||= '1000';

import { SqliteDb } from '../src/db/sqlite.ts';
import { PostgresDb } from '../src/db/postgres.ts';
import { migrate } from '../src/db/migrate.ts';
import {
  consumeRateLimit,
  recordLoginFailure,
  checkLoginLockout,
  clearLoginFailures,
  pruneRateLimits,
  DbLoginThrottle,
} from '../src/lib/rate-limit-store.ts';

/*
 * The engine is chosen by the same convention as the rest of the suite: when
 * TEST_DATABASE_URL is set the file runs against PostgreSQL, otherwise SQLite. That
 * is how `npm run test:pg` re-runs the whole suite on the real engine, so these
 * tests inherit dual-engine coverage without a second code path.
 */
const pgUrl = process.env.TEST_DATABASE_URL ?? '';
const engines = pgUrl ? [{ name: 'postgres' }, { name: 'sqlite' }] : [{ name: 'sqlite' }];

async function freshDb(engine) {
  if (engine === 'postgres') {
    const db = new PostgresDb(pgUrl);
    await migrate(db, { log: () => {} });
    // Clear only this suite's tables: a full reset between cases would fight the
    // other suites in the same run.
    await db.run('DELETE FROM rate_limit_counters');
    await db.run('DELETE FROM login_lockouts');
    return db;
  }
  const db = new SqliteDb(':memory:');
  await migrate(db, { log: () => {} });
  return db;
}

const T0 = Date.UTC(2026, 4, 1, 12, 0, 0);

for (const { name } of engines) {
  test(`[${name}] the limit is enforced at exactly the boundary`, async () => {
    const db = await freshDb(name);
    const limit = 3;
    const windowMs = 60_000;

    const decisions = [];
    for (let i = 0; i < 5; i++) {
      decisions.push(await consumeRateLimit(db, 'auth:1.2.3.4', limit, windowMs, T0 + i));
    }

    assert.deepEqual(
      decisions.map((d) => d.allowed),
      [true, true, true, false, false],
      'the first three are allowed, the fourth and fifth are refused',
    );
    assert.equal(decisions[2].remaining, 0, 'the third call leaves no headroom');
    assert.ok(decisions[3].retryAfterSec > 0, 'a refused caller is told when to retry');
    await db.close();
  });

  test(`[${name}] a refused request does not consume a token`, async () => {
    const db = await freshDb(name);
    // Six refusals against a limit of one must not turn into a longer lockout than
    // the window — a limiter that extends its own window on refusal can lock a
    // legitimate caller out indefinitely.
    await consumeRateLimit(db, 'k', 1, 60_000, T0);
    for (let i = 0; i < 6; i++) await consumeRateLimit(db, 'k', 1, 60_000, T0 + i);
    const row = await db.get('SELECT count FROM rate_limit_counters WHERE bucket_key = ?', ['k']);
    assert.equal(Number(row.count), 1, 'the counter stays at the limit, not above it');
    await db.close();
  });

  test(`[${name}] the window reopens on time`, async () => {
    const db = await freshDb(name);
    const windowMs = 60_000;
    await consumeRateLimit(db, 'k', 1, windowMs, T0);
    const blocked = await consumeRateLimit(db, 'k', 1, windowMs, T0 + windowMs - 1);
    assert.equal(blocked.allowed, false, 'still refused one millisecond before the window ends');

    const reopened = await consumeRateLimit(db, 'k', 1, windowMs, T0 + windowMs + 1);
    assert.equal(reopened.allowed, true, 'allowed again once the window has elapsed');
    assert.equal(reopened.remaining, 0);
    await db.close();
  });

  test(`[${name}] concurrent callers cannot exceed the limit`, async () => {
    const db = await freshDb(name);
    const limit = 10;
    /*
     * The race this is for: a read-then-write limiter lets two callers both see
     * slot 10 and both proceed. Firing well past the limit in parallel means a
     * non-atomic implementation will usually overshoot, and an atomic one never can.
     */
    const results = await Promise.all(
      Array.from({ length: 40 }, () => consumeRateLimit(db, 'race', limit, 60_000, T0)),
    );
    const allowed = results.filter((r) => r.allowed).length;
    assert.equal(allowed, limit, `exactly ${limit} of 40 parallel calls may succeed, got ${allowed}`);
    await db.close();
  });

  test(`[${name}] separate keys have separate budgets`, async () => {
    const db = await freshDb(name);
    await consumeRateLimit(db, 'global:a', 2, 60_000, T0);
    await consumeRateLimit(db, 'global:a', 2, 60_000, T0);
    const aBlocked = await consumeRateLimit(db, 'global:a', 2, 60_000, T0);
    const bFresh = await consumeRateLimit(db, 'global:b', 2, 60_000, T0);
    assert.equal(aBlocked.allowed, false, 'one exhausted key does not affect another');
    assert.equal(bFresh.allowed, true);
    await db.close();
  });

  test(`[${name}] lockout backoff grows, caps, and clears on success`, async () => {
    const db = await freshDb(name);
    const opts = { threshold: 2, baseLockMs: 1_000, maxLockMs: 8_000 };

    const first = await recordLoginFailure(db, 'user:x', opts, T0);
    assert.equal(first.locked, false, 'below the threshold is not a lockout');

    const second = await recordLoginFailure(db, 'user:x', opts, T0 + 1000);
    assert.equal(second.locked, true);
    assert.equal(second.retryAfterSec, 1, 'threshold breach locks for baseLockMs');

    const third = await recordLoginFailure(db, 'user:x', opts, T0 + 2000);
    assert.equal(third.retryAfterSec, 2, 'the next failure doubles the backoff');

    const fourth = await recordLoginFailure(db, 'user:x', opts, T0 + 3000);
    assert.equal(fourth.retryAfterSec, 4);

    // Capped, not unbounded.
    let capped = fourth;
    for (let i = 0; i < 6; i++) capped = await recordLoginFailure(db, 'user:x', opts, T0 + 4000 + i);
    assert.equal(capped.retryAfterSec, 8, 'the backoff is capped at maxLockMs');

    const locked = await checkLoginLockout(db, 'user:x', T0 + 5000);
    assert.equal(locked.locked, true);

    await clearLoginFailures(db, 'user:x');
    const cleared = await checkLoginLockout(db, 'user:x', T0 + 5000);
    assert.equal(cleared.locked, false, 'a success clears the history');
    await db.close();
  });

  test(`[${name}] a lockout expires rather than persisting forever`, async () => {
    const db = await freshDb(name);
    const opts = { threshold: 1, baseLockMs: 1_000, maxLockMs: 1_000 };
    await recordLoginFailure(db, 'user:y', opts, T0);
    assert.equal((await checkLoginLockout(db, 'user:y', T0 + 500)).locked, true);
    assert.equal((await checkLoginLockout(db, 'user:y', T0 + 1_001)).locked, false);
    await db.close();
  });

  test(`[${name}] concurrent failures are all counted`, async () => {
    const db = await freshDb(name);
    const opts = { threshold: 100, baseLockMs: 1000, maxLockMs: 1000 };
    // A lost increment would under-count failures and delay the lockout; the upsert
    // must increment inside the statement, not read-modify-write in application code.
    await Promise.all(Array.from({ length: 20 }, () => recordLoginFailure(db, 'user:z', opts, T0)));
    const row = await db.get('SELECT failures FROM login_lockouts WHERE subject = ?', ['user:z']);
    assert.equal(Number(row.failures), 20, 'every concurrent failure is counted');
    await db.close();
  });

  test(`[${name}] the DbLoginThrottle facade matches the in-process interface`, async () => {
    const db = await freshDb(name);
    const throttle = new DbLoginThrottle(db, { threshold: 2, baseLockMs: 1000, maxLockMs: 4000 });
    assert.deepEqual(await throttle.check('u'), { locked: false, retryAfterSec: 0 });
    await throttle.fail('u', T0);
    assert.equal((await throttle.check('u', T0 + 1)).locked, false);
    const locked = await throttle.fail('u', T0 + 1);
    assert.equal(locked.locked, true);
    assert.equal((await throttle.check('u', T0 + 2)).locked, true);
    await throttle.succeed('u');
    assert.equal((await throttle.check('u', T0 + 2)).locked, false);
    await db.close();
  });

  test(`[${name}] pruning removes expired rows and keeps live ones`, async () => {
    const db = await freshDb(name);
    await consumeRateLimit(db, 'old', 5, 1_000, T0);
    await consumeRateLimit(db, 'live', 5, 600_000, T0);
    await recordLoginFailure(db, 'user:old', { threshold: 1, baseLockMs: 1_000, maxLockMs: 1_000 }, T0);

    const pruned = await pruneRateLimits(db, T0 + 2_000);
    assert.ok(pruned.counters >= 1, 'the expired counter is removed');
    assert.ok(pruned.lockouts >= 1, 'the expired lockout is removed');

    const remaining = await db.all('SELECT bucket_key FROM rate_limit_counters');
    assert.deepEqual(
      remaining.map((r) => r.bucket_key),
      ['live'],
      'the live window is untouched',
    );
    await db.close();
  });
}

/**
 * The end-to-end property that motivates the whole file: a lockout earned on one
 * application instance must refuse a login on the next one.
 *
 * This is the difference between a real control and a decorative one. The
 * in-process `LoginThrottle` cannot pass this test by construction — a new instance
 * begins with an empty map — so running it against the database-backed throttle is
 * what proves the shared store is actually wired in.
 */
test('a lockout survives into a new application instance', { skip: pgUrl ? false : 'requires PostgreSQL: the shared store is selected only when the database is shared, so on SQLite the in-process throttle is used by design' }, async () => {
  const db = await freshDb('postgres');
  const { buildApp } = await import('../src/app.ts');
  const { hashPassword } = await import('../src/auth/password.ts');

  await db.run('DELETE FROM login_lockouts');
  await db.run("DELETE FROM users WHERE id = 'u_lock'");
  await db.run(
    "INSERT INTO users (id,email,full_name,role,is_active) VALUES ('u_lock','lock@relay.local','Lock','admin',1)",
  );
  await db.run(
    "INSERT INTO local_credentials (id,user_id,username,password_hash,version) VALUES ('c_lock','u_lock','lock me',?,1)",
    [await hashPassword('the-right-password')],
  );

  // Five failures, then the instance goes away — as a scaled-down serverless
  // instance does.
  const first = await buildApp({ db, logger: false, migrateOnBoot: false });
  for (let i = 0; i < 5; i++) {
    const res = await first.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'lock me', password: 'wrong' },
    });
    assert.equal(res.statusCode, 401, 'a wrong password is a 401');
  }
  await first.app.close();

  // A different instance, with the correct password, must still be refused.
  const second = await buildApp({ db, logger: false, migrateOnBoot: false });
  const refused = await second.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'lock me', password: 'the-right-password' },
  });
  assert.equal(refused.statusCode, 401, 'the lockout is enforced across instances');
  assert.ok(refused.headers['retry-after'], 'the caller is told how long to wait');

  // And once the lockout is cleared, the correct password works — proving the refusal
  // was the lockout and not a broken credential.
  await db.run('DELETE FROM login_lockouts');
  const allowed = await second.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'lock me', password: 'the-right-password' },
  });
  assert.equal(allowed.statusCode, 200);

  await second.app.close();
  await db.run("DELETE FROM users WHERE id = 'u_lock'");
  await db.close();
});

/**
 * The HTTP request budget, enforced across two independent application instances.
 *
 * This is the behaviour a per-process `Map` cannot produce: with a budget of five,
 * four requests to instance A and four to instance B must yield five successes and
 * three 429s — not eight successes. It is the reason §10 asks for a shared store
 * rather than a bigger in-process one.
 */
test(
  'the HTTP budget is shared across independent instances',
  { skip: pgUrl ? false : 'requires PostgreSQL: the shared limiter is selected only when the database is shared' },
  async () => {
    const db = await freshDb('postgres');
    const { buildApp } = await import('../src/app.ts');
    await db.run('DELETE FROM rate_limit_counters');

    const saved = process.env.RATE_LIMIT_GLOBAL;
    process.env.RATE_LIMIT_GLOBAL = '5';
    try {
      const a = await buildApp({ db, logger: false, migrateOnBoot: false });
      const b = await buildApp({ db, logger: false, migrateOnBoot: false });

      const statuses = [];
      for (let i = 0; i < 8; i++) {
        const app = i % 2 === 0 ? a.app : b.app;
        const res = await app.inject({ method: 'GET', url: '/api/live', remoteAddress: '9.9.9.9' });
        statuses.push(res.statusCode);
      }

      assert.deepEqual(
        statuses,
        [200, 200, 200, 200, 200, 429, 429, 429],
        'the fifth request exhausts the budget for both instances',
      );

      const row = await db.get("SELECT count FROM rate_limit_counters WHERE bucket_key LIKE 'global:%'");
      assert.equal(Number(row.count), 5, 'the counter lives in the database, not in either instance');

      await a.app.close();
      await b.app.close();
    } finally {
      if (saved === undefined) delete process.env.RATE_LIMIT_GLOBAL;
      else process.env.RATE_LIMIT_GLOBAL = saved;
      await db.run('DELETE FROM rate_limit_counters');
      await db.close();
    }
  },
);

after(async () => {
  /* connections are closed per test */
});
