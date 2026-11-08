-- ============================================================================
-- Relay OSS · 0001_core.sql
-- Identity, clients, revenue pipeline and project delivery spine.
-- Every table is normalised 3NF, FK-enforced, and indexed. No JSON blobs are
-- used as a primary system of record (json1 is used only for immutable
-- audit payloads / event envelopes).
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- identity --
CREATE TABLE users (
  id                 TEXT PRIMARY KEY,
  email              TEXT NOT NULL UNIQUE,
  full_name          TEXT NOT NULL,
  title              TEXT NOT NULL DEFAULT '',
  role               TEXT NOT NULL DEFAULT 'member'
                     CHECK (role IN ('admin','lead','member','client','bot')),
  avatar_color       TEXT NOT NULL DEFAULT '#6366f1',
  initials           TEXT NOT NULL DEFAULT '',
  timezone           TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  capacity_hours_week REAL NOT NULL DEFAULT 32,
  cost_rate_cents    INTEGER NOT NULL DEFAULT 0,
  bill_rate_cents    INTEGER NOT NULL DEFAULT 0,
  skills_json        TEXT NOT NULL DEFAULT '[]',  -- immutable skill vector
  is_active          INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_users_role ON users(role);

CREATE TABLE teams (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  slug        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, user_id)
);

-- ----------------------------------------------------------------- clients --
CREATE TABLE clients (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  slug                  TEXT NOT NULL UNIQUE,
  industry              TEXT NOT NULL DEFAULT '',
  initials              TEXT NOT NULL DEFAULT '',
  accent_color          TEXT NOT NULL DEFAULT '#7c8cff',
  tier                  TEXT NOT NULL DEFAULT 'growth'
                        CHECK (tier IN ('strategic','enterprise','growth','starter')),
  health                TEXT NOT NULL DEFAULT 'healthy'
                        CHECK (health IN ('healthy','watch','at_risk','churn')),
  primary_contact_name  TEXT NOT NULL DEFAULT '',
  primary_contact_email TEXT NOT NULL DEFAULT '',
  primary_contact_role  TEXT NOT NULL DEFAULT '',
  notes                 TEXT NOT NULL DEFAULT '',
  mrr_cents             INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_clients_health ON clients(health);

CREATE TABLE client_contacts (
  id          TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL DEFAULT '',
  role        TEXT NOT NULL DEFAULT '',
  phone       TEXT NOT NULL DEFAULT '',
  is_primary  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_contacts_client ON client_contacts(client_id);

-- ---------------------------------------------------------------- pipeline --
-- The stage catalogue is *data*, not hardcoded: the delivery team can evolve
-- the pipeline without a deploy.
CREATE TABLE pipeline_stages (
  id                TEXT PRIMARY KEY,
  key               TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  phase             TEXT NOT NULL CHECK (phase IN ('origin','discovery','proposal','delivery','growth')),
  position          INTEGER NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  entry_criteria    TEXT NOT NULL DEFAULT '',
  exit_criteria     TEXT NOT NULL DEFAULT '',
  default_sla_days  INTEGER NOT NULL DEFAULT 7,
  default_value_cents INTEGER NOT NULL DEFAULT 0,
  color             TEXT NOT NULL DEFAULT '#6366f1',
  icon              TEXT NOT NULL DEFAULT 'circle'
);
CREATE INDEX idx_stages_position ON pipeline_stages(position);

CREATE TABLE deals (
  id               TEXT PRIMARY KEY,
  client_id        TEXT NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  title            TEXT NOT NULL,
  value_cents      INTEGER NOT NULL DEFAULT 0,
  currency         TEXT NOT NULL DEFAULT 'INR',
  status           TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','won','lost','paused')),
  stage_id         TEXT NOT NULL REFERENCES pipeline_stages(id),
  owner_id         TEXT REFERENCES users(id),
  source           TEXT NOT NULL DEFAULT 'inbound',
  probability      INTEGER NOT NULL DEFAULT 40 CHECK (probability BETWEEN 0 AND 100),
  expected_close_at TEXT,
  started_at       TEXT NOT NULL DEFAULT (datetime('now')),
  won_at           TEXT,
  lost_at          TEXT,
  lost_reason      TEXT NOT NULL DEFAULT '',
  next_step        TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_deals_stage ON deals(stage_id);
CREATE INDEX idx_deals_status ON deals(status);
CREATE INDEX idx_deals_owner ON deals(owner_id);

-- Delivery phases (the technical-consultation → handover spine).
CREATE TABLE phases (
  id          TEXT PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  position    INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sla_days    INTEGER NOT NULL DEFAULT 10,
  billable    INTEGER NOT NULL DEFAULT 1,
  color       TEXT NOT NULL DEFAULT '#6366f1',
  turnover_policy TEXT NOT NULL DEFAULT '',
  icon        TEXT NOT NULL DEFAULT 'circle'
);

CREATE TABLE deal_phase_runs (
  id            TEXT PRIMARY KEY,
  deal_id       TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  phase_id      TEXT NOT NULL REFERENCES phases(id),
  status        TEXT NOT NULL DEFAULT 'locked'
                CHECK (status IN ('locked','active','blocked','done')),
  position      INTEGER NOT NULL DEFAULT 0,
  started_at    TEXT,
  due_at        TEXT,
  completed_at  TEXT,
  approved_by   TEXT REFERENCES users(id),
  turnover_notes TEXT NOT NULL DEFAULT '',
  UNIQUE (deal_id, phase_id)
);
CREATE INDEX idx_phase_runs_deal ON deal_phase_runs(deal_id);

-- ---------------------------------------------------------------- projects --
CREATE TABLE projects (
  id             TEXT PRIMARY KEY,
  key            TEXT NOT NULL UNIQUE,           -- e.g. NRTH
  name           TEXT NOT NULL,
  client_id      TEXT NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  deal_id        TEXT REFERENCES deals(id) ON DELETE SET NULL,
  owner_id       TEXT REFERENCES users(id),
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('discovery','active','review','blocked','launched','archived')),
  health         TEXT NOT NULL DEFAULT 'on_track'
                 CHECK (health IN ('on_track','watch','at_risk','critical')),
  started_at     TEXT NOT NULL DEFAULT (datetime('now')),
  target_end_at  TEXT,
  budget_cents   INTEGER NOT NULL DEFAULT 0,
  hours_budget   REAL NOT NULL DEFAULT 0,
  description    TEXT NOT NULL DEFAULT '',
  repo_url       TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_projects_client ON projects(client_id);
CREATE INDEX idx_projects_status ON projects(status);
CREATE INDEX idx_projects_owner ON projects(owner_id);

CREATE TABLE project_phases (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  phase_id       TEXT NOT NULL REFERENCES phases(id),
  status         TEXT NOT NULL DEFAULT 'locked'
                 CHECK (status IN ('locked','active','blocked','done')),
  position       INTEGER NOT NULL DEFAULT 0,
  progress       INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  started_at     TEXT,
  due_at         TEXT,
  completed_at   TEXT,
  signoff_by     TEXT REFERENCES users(id),
  signoff_at     TEXT,
  turnover_passed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (project_id, phase_id)
);
CREATE INDEX idx_project_phases_project ON project_phases(project_id);

CREATE TABLE milestones (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_phase_id TEXT REFERENCES project_phases(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  due_at          TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','met','missed','cancelled')),
  completed_at    TEXT,
  position        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_milestones_project ON milestones(project_id);
