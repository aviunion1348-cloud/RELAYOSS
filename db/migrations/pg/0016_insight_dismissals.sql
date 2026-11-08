-- GENERATED from db/migrations/0016_insight_dismissals.sql — do not edit by hand.
-- Regenerate with: node scripts/gen-pg-migrations.mjs

-- Dismissed intelligence findings.
--
-- The Intelligence screen computes its findings from live operational data: a task
-- is blocking four others, one project is 30% over estimate, five tasks have not
-- moved in a week. Editing a finding would be a lie — the numbers come from the
-- database and change when the work changes.
--
-- What was missing is the decision that follows. "We know, it is handled" is a real
-- decision, and without somewhere to record it the only options are to fix the work
-- (which is what the finding suggests, but not always what is right) or to see the
-- same warning every day until it becomes wallpaper. Every alerting product that
-- survives contact with users has this: acknowledge, and it stops shouting.
--
-- So the dismissal is stored against a stable *key*, not against the rendered text.
-- A key is kind + subject, so the same underlying finding stays dismissed while its
-- wording updates as the numbers move — and a different project's drift stays
-- visible because its key is different. Deleting the row un-dismisses it, which is
-- why this is a table rather than a boolean on the insight.
--
-- `dismissed_by` is a real user and `dismissed_at` is stored, because "who decided
-- to ignore this, and when" is the question asked after an incident.
CREATE TABLE insight_dismissals (
  key           TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  subject       TEXT NOT NULL DEFAULT '',
  reason        TEXT NOT NULL DEFAULT '',
  dismissed_by  TEXT REFERENCES users(id),
  dismissed_at  TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')),
  -- Until when the finding stays hidden. NULL means indefinitely.
  muted_until   TEXT
);
CREATE INDEX idx_insight_dismissals_kind ON insight_dismissals(kind);
