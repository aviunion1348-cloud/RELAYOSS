-- ---------------------------------------------------------------------------
-- 0008 — Permission-scoped search, meeting notes and soft-delete.
--
-- Search previously read every row in tasks/projects/clients/deals/docs and
-- filtered nothing. That is a cross-tenant data leak: a member granted project
-- A could retrieve titles from a client they have no relationship with, and the
-- client portal could see internal delivery work. The fix is not a filter in
-- one handler — it is a single scope object that every read path must use.
--
-- This migration adds the columns that scope needs (soft delete, partner
-- ownership) and the meeting-notes entity the communication centre requires.
-- ---------------------------------------------------------------------------

-- Soft delete: an archived or deleted record must remain referenced by history
-- (audit, acceptance, turnover evidence) but must never appear in search.
ALTER TABLE tasks ADD COLUMN hidden_at TEXT;
ALTER TABLE projects ADD COLUMN hidden_at TEXT;
ALTER TABLE task_comments ADD COLUMN deleted_at TEXT;

CREATE INDEX idx_tasks_hidden ON tasks(hidden_at);
CREATE INDEX idx_projects_hidden ON projects(hidden_at);
CREATE INDEX idx_comments_deleted ON task_comments(deleted_at);

-- Partner-owned records: a partner may only ever see its own tenant. The scope
-- needs to answer "which partner does this user belong to" without trusting a
-- request parameter.
ALTER TABLE partner_iam_users ADD COLUMN user_id TEXT REFERENCES users(id);
CREATE INDEX idx_partner_iam_user ON partner_iam_users(user_id);

-- Which projects a partner's console may see. Absence means "none", not "all".
CREATE TABLE partner_projects (
  partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (partner_id, project_id)
);

-- ---------------------------------------------------------------------------
-- Meeting notes (part of the communication centre)
-- ---------------------------------------------------------------------------
CREATE TABLE meeting_notes (
  id          TEXT PRIMARY KEY,
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
  client_id   TEXT REFERENCES clients(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  attendees   TEXT NOT NULL DEFAULT '',
  agenda      TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  decisions   TEXT NOT NULL DEFAULT '',
  follow_ups  TEXT NOT NULL DEFAULT '',
  owner_id    TEXT REFERENCES users(id),
  client_visible INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (project_id IS NOT NULL OR client_id IS NOT NULL)
);
CREATE INDEX idx_meeting_notes_project ON meeting_notes(project_id, occurred_at);
CREATE INDEX idx_meeting_notes_client ON meeting_notes(client_id, occurred_at);

-- ---------------------------------------------------------------------------
-- Retrieval index support.
--
-- Search is a LIKE scan over an authorised row set, which is fine at this scale
-- and impossible to get subtly wrong. These indexes keep it from degrading as
-- the dataset grows; they do not change authorisation semantics.
-- ---------------------------------------------------------------------------
CREATE INDEX idx_docs_title ON docs(title);
CREATE INDEX idx_tasks_title ON tasks(title);
CREATE INDEX idx_clients_name ON clients(name);
CREATE INDEX idx_deals_title ON deals(title);
