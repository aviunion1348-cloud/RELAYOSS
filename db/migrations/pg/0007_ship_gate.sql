-- GENERATED from db/migrations/0007_ship_gate.sql — do not edit by hand.
-- Regenerate with: node scripts/gen-pg-migrations.mjs

-- ---------------------------------------------------------------------------
-- 0007 — Ship-gate enforcement and the turnover clock set.
--
-- The delivery board defines ten hard clocks. Five of them were previously
-- policy rows that no workflow event ever started; they are wired here through
-- a single append-only acknowledgement table rather than left as decoration.
--
-- This migration also makes "block shipment on outstanding requirements" a
-- server decision: the release row records the last gate evaluation, so an
-- operator can prove *why* a ship was refused, not just that it was.
-- ---------------------------------------------------------------------------

-- Release lifecycle evidence. `exec_summary_at` is the timestamp the executive
-- summary was *prepared* (not merely linked), which is what the 48h rule needs.
ALTER TABLE releases ADD COLUMN exec_summary_at TEXT;
ALTER TABLE releases ADD COLUMN ship_blocked_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE releases ADD COLUMN ship_approved_by TEXT REFERENCES users(id);
ALTER TABLE releases ADD COLUMN ship_approved_at TEXT;

CREATE INDEX idx_releases_status ON releases(status, ship_planned_at);

-- ---------------------------------------------------------------------------
-- Post-ship acknowledgement.
--
-- A deployment is not successful because a pipeline said so. Each of the three
-- signals is recorded separately with its own timestamp and source, so "shipped"
-- can only be claimed when the evidence actually arrived. Absence of a signal is
-- NULL, never a fabricated 'ok'.
-- ---------------------------------------------------------------------------
CREATE TABLE ship_acknowledgements (
  id             TEXT PRIMARY KEY,
  release_id     TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  signal         TEXT NOT NULL
                 CHECK (signal IN ('device_ack','deployment_ack','post_ship_verification')),
  state          TEXT NOT NULL DEFAULT 'pending'
                 CHECK (state IN ('pending','received','failed','waived')),
  source         TEXT NOT NULL DEFAULT '',
  detail         TEXT NOT NULL DEFAULT '',
  received_at    TEXT,
  recorded_by    TEXT REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')),
  UNIQUE (release_id, signal)
);
CREATE INDEX idx_ship_ack_release ON ship_acknowledgements(release_id, state);

-- ---------------------------------------------------------------------------
-- Clock acknowledgements (escalation receipt).
--
-- A missed clock is only closed when a human has acknowledged it with a reason.
-- This is the difference between "the sweep notified someone" and "someone owns
-- the miss", and it is what the SLA dashboard reads.
-- ---------------------------------------------------------------------------
CREATE TABLE clock_acknowledgements (
  id           TEXT PRIMARY KEY,
  timer_id     TEXT NOT NULL REFERENCES sla_timers(id) ON DELETE CASCADE,
  acknowledged_by TEXT NOT NULL REFERENCES users(id),
  reason       TEXT NOT NULL,
  escalated_to TEXT REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')),
  UNIQUE (timer_id)
);
CREATE INDEX idx_clock_ack_timer ON clock_acknowledgements(timer_id);
