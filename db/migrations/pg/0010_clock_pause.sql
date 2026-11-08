-- GENERATED from db/migrations/0010_clock_pause.sql — do not edit by hand.
-- Regenerate with: node scripts/gen-pg-migrations.mjs

-- ---------------------------------------------------------------------------
-- 0010 — Clock pause/resume state and history.
--
-- R23/R38 were incomplete: `paused` was a terminal outcome, so a clock paused
-- while waiting on a client could never resume, and the sweep would breach it
-- anyway. Pause is a sub-state of a running clock, not an ending.
--
--   outcome    = the verdict: running | met | missed | waived
--   paused_at  = non-null while the clock is stopped, waiting
--
-- Authorised pause time is banked in paused_ms and excluded from elapsed time;
-- resume pushes due_at forward by exactly that duration.
-- ---------------------------------------------------------------------------
-- `paused_at` already exists on the table (0004); this migration adds the
-- accounting and provenance around it, and repurposes the `paused` outcome as a
-- transient sub-state rather than a terminal verdict.
ALTER TABLE sla_timers ADD COLUMN paused_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sla_timers ADD COLUMN pause_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE sla_timers ADD COLUMN pause_category TEXT NOT NULL DEFAULT ''
  CHECK (pause_category IN ('','client','internal','vendor'));
ALTER TABLE sla_timers ADD COLUMN paused_by TEXT REFERENCES users(id);

CREATE INDEX idx_timers_paused ON sla_timers(paused_at);

-- Append-only clock event log: every start, pause, resume, resolve and sweep
-- verdict, with who did it and why. This is what makes a clock auditable rather
-- than merely present.
-- Lifecycle clocks are scoped to a stage instance, not one of the six original
-- entity kinds. SQLite cannot alter a CHECK constraint in place, so the table is
-- rebuilt with the widened enum and its rows copied across.
--
-- Two traps handled explicitly:
--   1. any table with a FOREIGN KEY to sla_timers would have its reference
--      rewritten to the temporary name by ALTER TABLE ... RENAME, so those
--      children are detached first and rebuilt afterwards;
--   2. indexes are recreated after the swap, because they die with the table.
DROP TABLE IF EXISTS clock_acknowledgements;
DROP TABLE IF EXISTS clock_events;

CREATE TABLE sla_timers_new (
  id           TEXT PRIMARY KEY,
  clock_key    TEXT NOT NULL REFERENCES sla_clocks(key),
  entity_type  TEXT NOT NULL CHECK (entity_type IN ('deal','project','phase','task','release','qa','lifecycle','client')),
  entity_id    TEXT NOT NULL,
  label        TEXT NOT NULL DEFAULT '',
  started_at   TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')),
  due_at       TEXT NOT NULL,
  warn_at      TEXT NOT NULL,
  met_at       TEXT,
  missed_at    TEXT,
  outcome      TEXT NOT NULL DEFAULT 'running'
               CHECK (outcome IN ('running','met','missed','paused','waived')),
  minutes_used INTEGER,
  exception_note TEXT NOT NULL DEFAULT '',
  paused_at    TEXT,
  paused_ms    INTEGER NOT NULL DEFAULT 0,
  pause_reason TEXT NOT NULL DEFAULT '',
  pause_category TEXT NOT NULL DEFAULT '' CHECK (pause_category IN ('','client','internal','vendor')),
  paused_by    TEXT REFERENCES users(id)
);
INSERT INTO sla_timers_new
  (id,clock_key,entity_type,entity_id,label,started_at,due_at,warn_at,met_at,missed_at,outcome,minutes_used,exception_note,paused_at,paused_ms,pause_reason,pause_category,paused_by)
SELECT
  id,clock_key,entity_type,entity_id,label,started_at,due_at,warn_at,met_at,missed_at,outcome,minutes_used,exception_note,paused_at,paused_ms,pause_reason,pause_category,paused_by
FROM sla_timers;

DROP TABLE sla_timers;
ALTER TABLE sla_timers_new RENAME TO sla_timers;

-- Both child tables are recreated against the rebuilt parent. They are empty by
-- construction: `clock_events` is created below in this same migration, and
-- acknowledgements postdate it.
CREATE TABLE clock_events (
  id         TEXT PRIMARY KEY,
  timer_id   TEXT NOT NULL REFERENCES sla_timers(id) ON DELETE CASCADE,
  clock_key  TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('started','paused','resumed','met','missed','waived','acknowledged','swept')),
  reason     TEXT NOT NULL DEFAULT '',
  category   TEXT NOT NULL DEFAULT '' CHECK (category IN ('','client','internal','vendor')),
  actor_id   TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS'))
);
CREATE INDEX idx_clock_events_timer ON clock_events(timer_id, id);

CREATE TABLE clock_acknowledgements (
  id              TEXT PRIMARY KEY,
  timer_id        TEXT NOT NULL REFERENCES sla_timers(id) ON DELETE CASCADE,
  acknowledged_by TEXT NOT NULL REFERENCES users(id),
  reason          TEXT NOT NULL,
  escalated_to    TEXT REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')),
  UNIQUE (timer_id)
);
CREATE INDEX idx_clock_ack_timer ON clock_acknowledgements(timer_id);

CREATE INDEX idx_timers_clock ON sla_timers(clock_key, outcome);
CREATE INDEX idx_timers_entity ON sla_timers(entity_type, entity_id);
CREATE INDEX idx_timers_outcome ON sla_timers(outcome, due_at);
