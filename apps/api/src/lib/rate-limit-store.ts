/**
 * Database-backed rate limiting and login lockout.
 *
 * The in-process implementation in `rate-limit.ts` is a `Map` and therefore a
 * per-process budget. That is acceptable for a single container and not acceptable
 * for anything else: N replicas give an attacker N times the allowance, and on a
 * serverless platform there is no fixed N at all — each cold start begins with an
 * empty map. §10 asks for a shared, atomic store, so this is it.
 *
 * The hard part is atomicity, not storage. A read-then-write ("select the count,
 * decide, update") is a check-then-act race: two concurrent requests both read 29
 * against a limit of 30, both decide they are allowed, and the 31st request
 * succeeds. Under credential stuffing that is not a theoretical gap — the extra
 * requests are exactly the ones an attacker sends in parallel.
 *
 * The consume operation is therefore a single statement whose decision is made by
 * the database, followed by a single read of the resulting row. Two statements
 * rather than one only because the adapter returns rows from `get` and a change
 * count from `run`; the *decision* — whether this caller may proceed — comes from
 * the conditional `UPDATE`, so no interleaving can grant an extra token.
 *
 * Windows are fixed rather than sliding. A fixed window permits a burst of up to
 * twice the limit across a boundary (limit at t=59s, limit again at t=61s); a
 * sliding window avoids that at the cost of either many rows or an in-memory
 * sketch. For the budgets here — 30 auth requests a minute, 1 200 global — the
 * boundary burst is bounded and harmless, and the simpler mechanism is the one that
 * can be verified. Recorded as a deliberate trade-off in docs/SECURITY.md.
 */
import type { Db } from '../db/index.ts';

export interface LimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
  /** Window end, epoch milliseconds — the instant the caller may try again. */
  resetAt: number;
}

/**
 * Consume one token from `bucketKey`.
 *
 * Atomicity comes from the `ON CONFLICT … DO UPDATE … WHERE` form:
 *
 *   - first touch inserts a row with count = 1 and returns 1 row;
 *   - a live window under the limit increments and returns 1 row;
 *   - a live window at the limit suppresses the update and returns **0 rows**,
 *     which is the refusal — decided inside the engine, not by the caller.
 *
 * An expired window is handled by the `CASE` expressions, which reset the counter
 * in the same statement, so there is no window in which the row is inconsistent.
 */
export async function consumeRateLimit(
  db: Db,
  bucketKey: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): Promise<LimitDecision> {
  const windowEnd = now + windowMs;

  /*
   * `reset_at <= now` means the previous window has elapsed: start a new one. The
   * comparison is against the *current* instant, never against the value being
   * written — an earlier version compared the stored reset against the new reset,
   * which is always true for a fresh row and made every caller look over-limit.
   */
  /*
   * `granted` is the number of rows the statement touched: 1 when this caller
   * consumed a token, 0 when the `WHERE` suppressed the update because the window
   * was live and already at the limit. That 0 is the refusal, decided atomically.
   */
  let granted = 0;
  try {
    const result = await db.run(
      `INSERT INTO rate_limit_counters (bucket_key, count, reset_at, window_start)
       VALUES (?, 1, ?, ?)
       ON CONFLICT (bucket_key) DO UPDATE SET
         count = CASE WHEN rate_limit_counters.reset_at <= ? THEN 1 ELSE rate_limit_counters.count + 1 END,
         reset_at = CASE WHEN rate_limit_counters.reset_at <= ? THEN ? ELSE rate_limit_counters.reset_at END,
         window_start = CASE WHEN rate_limit_counters.reset_at <= ? THEN ? ELSE rate_limit_counters.window_start END
         WHERE rate_limit_counters.reset_at <= ? OR rate_limit_counters.count < ?`,
      [bucketKey, windowEnd, now, now, now, windowEnd, now, now, now, limit],
    );
    granted = Number(result?.changes ?? 0);
  } catch {
    /*
     * Some drivers report a suppressed `ON CONFLICT` as an error rather than a zero
     * change count. Treating an unknown outcome as a refusal is the safe direction:
     * a false refusal is a visible 429, a false grant is an unbounded bypass.
     */
    granted = 0;
  }

  const row = await db.get<{ count: number; reset_at: number }>(
    'SELECT count, reset_at FROM rate_limit_counters WHERE bucket_key = ?',
    [bucketKey],
  );
  const count = Number(row?.count ?? 0);
  const resetAt = Number(row?.reset_at ?? windowEnd);
  const allowed = granted > 0;
  return {
    allowed,
    remaining: allowed ? Math.max(0, limit - count) : 0,
    retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil((resetAt - now) / 1000)),
    resetAt,
  };
}

/**
 * Consecutive-failure lockout for a credential endpoint.
 *
 * The increment happens inside the upsert, so no concurrent failure is lost — a
 * read-modify-write would let two parallel attempts overwrite each other and delay
 * the lockout indefinitely.
 */
export async function recordLoginFailure(
  db: Db,
  subject: string,
  opts: { threshold: number; baseLockMs: number; maxLockMs: number },
  now = Date.now(),
): Promise<{ locked: boolean; retryAfterSec: number; failures: number }> {
  await db.run(
    `INSERT INTO login_lockouts (subject, failures, locked_until, updated_at)
     VALUES (?, 1, NULL, ?)
     ON CONFLICT (subject) DO UPDATE SET
       failures = login_lockouts.failures + 1,
       updated_at = ?`,
    [subject, now, now],
  );

  const row = await db.get<{ failures: number }>('SELECT failures FROM login_lockouts WHERE subject = ?', [
    subject,
  ]);
  const failures = Number(row?.failures ?? 1);
  if (failures < opts.threshold) return { locked: false, retryAfterSec: 0, failures };

  const backoff = Math.min(opts.maxLockMs, opts.baseLockMs * 2 ** (failures - opts.threshold));
  await db.run('UPDATE login_lockouts SET locked_until = ?, updated_at = ? WHERE subject = ?', [
    now + backoff,
    now,
    subject,
  ]);
  return { locked: true, retryAfterSec: Math.ceil(backoff / 1000), failures };
}

/** Is this subject currently locked? */
export async function checkLoginLockout(
  db: Db,
  subject: string,
  now = Date.now(),
): Promise<{ locked: boolean; retryAfterSec: number }> {
  const row = await db.get<{ locked_until: number | null }>(
    'SELECT locked_until FROM login_lockouts WHERE subject = ?',
    [subject],
  );
  const until = Number(row?.locked_until ?? 0);
  if (until > now) return { locked: true, retryAfterSec: Math.ceil((until - now) / 1000) };
  return { locked: false, retryAfterSec: 0 };
}

/** Clear the failure history after a success, so one mistype does not accumulate. */
export async function clearLoginFailures(db: Db, subject: string): Promise<void> {
  await db.run('DELETE FROM login_lockouts WHERE subject = ?', [subject]);
}

/**
 * Delete expired counters and lockouts. Called by the cron sweep rather than on a
 * request path: the tables stay small, but no request should pay for maintenance.
 */
export async function pruneRateLimits(
  db: Db,
  now = Date.now(),
): Promise<{ counters: number; lockouts: number }> {
  const counters = await db.run('DELETE FROM rate_limit_counters WHERE reset_at <= ?', [now]);
  const lockouts = await db.run(
    'DELETE FROM login_lockouts WHERE locked_until IS NOT NULL AND locked_until <= ?',
    [now],
  );
  return { counters: Number(counters?.changes ?? 0), lockouts: Number(lockouts?.changes ?? 0) };
}

/**
 * A `LoginThrottle`-compatible facade over the database.
 *
 * This is what makes the swap safe: `routes/password-login.ts` and
 * `routes/auth.ts` call `check`/`fail`/`succeed` and know nothing about storage. The
 * in-process class remains the default for tests and single-container runs; this one
 * is used when a database is the shared store.
 */
export class DbLoginThrottle {
  /*
   * Fields are declared explicitly rather than with constructor parameter
   * properties. The test runner strips types instead of compiling them, and
   * `constructor(private readonly db: Db)` is syntax that stripping cannot
   * transform — it fails at import time with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX.
   */
  readonly db: Db;
  readonly opts: { threshold?: number; baseLockMs?: number; maxLockMs?: number };

  constructor(db: Db, opts: { threshold?: number; baseLockMs?: number; maxLockMs?: number } = {}) {
    this.db = db;
    this.opts = opts;
  }

  private get settings() {
    return {
      threshold: this.opts.threshold ?? 5,
      baseLockMs: this.opts.baseLockMs ?? 60_000,
      maxLockMs: this.opts.maxLockMs ?? 30 * 60_000,
    };
  }

  async check(key: string, now = Date.now()) {
    return checkLoginLockout(this.db, key, now);
  }

  async fail(key: string, now = Date.now()) {
    return recordLoginFailure(this.db, key, this.settings, now);
  }

  async succeed(key: string) {
    await clearLoginFailures(this.db, key);
  }
}
