-- A version counter for the whole database.
--
-- The client's live feed asks one question every few seconds: "has anything changed
-- since the last id I saw?" The obvious source was `audit_log`, whose integer primary
-- key is exactly such a counter — except only five of the forty-nine mutating routes
-- ever wrote to it. A feed built on that would have been blind to most edits, and the
-- failure mode is the quiet one: the screen looks fine and is simply out of date.
--
-- This table exists only to be counted. It records *that* a mutation succeeded, not
-- what it contained — the audit trail remains the place for entity-specific history,
-- with before/after payloads, and the two are deliberately separate so neither has to
-- compromise:
--
--   audit_log    rich, queryable, written where it matters, read by people
--   change_log   append-only, one row per mutation, read only for MAX(id)
--
-- An `onResponse` hook writes one row for every successful mutating request, so a
-- route added tomorrow is covered without anyone remembering to instrument it.
--
-- `entity_type` is what the client maps to query keys, so a client edit invalidates
-- the client list and not the task board. `path` is kept for diagnosing a feed that
-- fires when it should not.
CREATE TABLE change_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL DEFAULT '',
  method      TEXT NOT NULL,
  path        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_change_log_entity ON change_log(entity_type, id);
