-- ============================================================================
-- Relay OSS · 0006_auth_identity.sql
-- Real authentication: OIDC subject binding, server-side sessions, and the
-- access-control boundary that makes partner/client isolation enforceable.
--
-- There is no "trust the header" identity in production. A session row is the
-- authority, and it is checked (and its user re-read) on every request, so a
-- revoked session, a demoted role or a deactivated user takes effect
-- immediately rather than at token expiry.
-- ============================================================================

PRAGMA foreign_keys = ON;

-- Externally-verified identity. `sub` is the IdP subject; `email` is a
-- convenience claim that is never used for authorisation.
CREATE TABLE identity_subjects (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issuer        TEXT NOT NULL,
  subject       TEXT NOT NULL,
  email         TEXT NOT NULL DEFAULT '',
  claims_json   TEXT NOT NULL DEFAULT '{}',
  last_login_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (issuer, subject)
);
CREATE INDEX idx_subjects_user ON identity_subjects(user_id);

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method        TEXT NOT NULL DEFAULT 'oidc' CHECK (method IN ('oidc','dev')),
  token_hash    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at  TEXT,
  revoked_at    TEXT,
  user_agent    TEXT,
  ip            TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id, revoked_at);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

-- Project-scoped access. Rows here extend (never replace) the global role:
-- absence of a grant means "no access", which is what makes cross-client
-- isolation a database fact rather than a UI convention.
CREATE TABLE project_members (
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access      TEXT NOT NULL DEFAULT 'member' CHECK (access IN ('admin','member','viewer')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX idx_project_members_user ON project_members(user_id);

-- Partner portal principals are separate from staff: a partner user may only
-- ever see its own partner tenant.
CREATE TABLE partner_invitations (
  id          TEXT PRIMARY KEY,
  partner_id  TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner','admin','viewer')),
  token_hash  TEXT NOT NULL,
  invited_by  TEXT REFERENCES users(id),
  accepted_at TEXT,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (partner_id, email)
);

-- Append-only record of authentication events (login, logout, failure, revoke).
CREATE TABLE auth_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT,
  session_id  TEXT,
  kind        TEXT NOT NULL,
  ip          TEXT,
  user_agent  TEXT,
  detail      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_auth_events_created ON auth_events(created_at);

-- Client-portal principals: which client an external user represents. This is
-- the boundary that keeps one client out of another client's workspace.
CREATE TABLE client_portal_users (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id   TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, client_id)
);
CREATE INDEX idx_client_portal_client ON client_portal_users(client_id);
