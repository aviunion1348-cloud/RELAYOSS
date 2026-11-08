-- GENERATED from db/migrations/0015_db_rate_limits.sql — do not edit by hand.
-- Regenerate with: node scripts/gen-pg-migrations.mjs

-- Distributed rate limiting and login lockout.
--
-- The in-process limiter in lib/rate-limit.ts is a token bucket in a Map. It is
-- correct for one process and wrong for more than one: three replicas give an
-- attacker three times the budget, and a serverless deployment gives one budget per
-- concurrent instance, which is to say no reliable budget at all. §10 asks for a
-- shared store, so the counters live here.
--
-- Two tables because the two mechanisms answer different questions:
--
--   rate_limit_counters  "how many requests has this key made in this window?"
--   login_lockouts       "how many consecutive failures has this identity had?"
--
-- Both are keyed on a string so a single table serves every family (global, auth,
-- write, per-address, per-username) without schema changes per limiter.
--
-- Window boundaries are stored as **epoch milliseconds in a BIGINT column**, not
-- as a formatted timestamp. Rate windows are arithmetic — is this before or after
-- that — and comparing formatted strings across two engines invites exactly the
-- kind of bug where a boundary compares equal when it should compare greater. The
-- rest of the schema stores human-readable timestamps; these two tables are
-- deliberately the exception, and the reason is here rather than in a comment
-- somewhere else.
--
-- The columns are BIGINT, not INTEGER, and that is not decoration. PostgreSQL's
-- INTEGER is 32-bit, and a millisecond epoch value (~1.7e12) overflows it: every
-- insert fails with "value … is out of range for type integer". SQLite accepts it
-- silently, so the defect appears only on the engine that matters. BIGINT is 64-bit
-- on PostgreSQL and a no-op alias on SQLite, so one statement serves both.

CREATE TABLE rate_limit_counters (
  -- Family and key, joined: 'auth:1.2.3.4', 'login-user:lear roadmap 289'.
  bucket_key TEXT PRIMARY KEY,
  -- Requests observed in the current window.
  count INTEGER NOT NULL DEFAULT 0,
  -- Window end, epoch milliseconds (64-bit: see the note above).
  reset_at BIGINT NOT NULL,
  -- Window start, epoch milliseconds. Kept so the window can be reported rather
  -- than inferred from reset_at minus an assumed length.
  window_start BIGINT NOT NULL
);

-- Expired-window cleanup scans by reset_at.
CREATE INDEX IF NOT EXISTS idx_rate_limit_reset_at ON rate_limit_counters (reset_at);

CREATE TABLE login_lockouts (
  -- Normalised identity: 'user:<username>' or 'ip:<address>'.
  subject TEXT PRIMARY KEY,
  -- Consecutive failures since the last success.
  failures INTEGER NOT NULL DEFAULT 0,
  -- End of the current lockout in epoch milliseconds, or NULL when not locked.
  locked_until BIGINT,
  -- When this subject last failed, epoch milliseconds.
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_lockouts_until ON login_lockouts (locked_until);
