-- ============================================================================
-- Relay OSS · PostgreSQL 16 production schema
--
-- This is the production system of record. The SQLite schema under
-- db/migrations is generated from the same logical model for zero-dependency
-- local development, and both are exercised by the test suite.
--
-- Differences from SQLite are deliberate and listed at the bottom.
-- Apply with:  psql "$DATABASE_URL" -f db/postgres/schema.sql
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

CREATE TYPE user_role      AS ENUM ('admin','lead','member','client','bot');
CREATE TYPE client_tier    AS ENUM ('strategic','enterprise','growth','starter');
CREATE TYPE client_health  AS ENUM ('healthy','watch','at_risk','churn');
CREATE TYPE deal_status    AS ENUM ('open','won','lost','paused');
CREATE TYPE phase_stage    AS ENUM ('origin','discovery','proposal','delivery','growth');
CREATE TYPE run_status     AS ENUM ('locked','active','blocked','done');
CREATE TYPE project_status AS ENUM ('discovery','active','review','blocked','launched','archived');
CREATE TYPE task_type      AS ENUM ('feature','bug','research','design','ops','meeting','content');
CREATE TYPE task_priority  AS ENUM ('urgent','high','medium','low');
CREATE TYPE task_status    AS ENUM ('backlog','todo','in_progress','review','blocked','done','cancelled');
CREATE TYPE turnover_state AS ENUM ('draft','in_review','passed','failed','waived');
CREATE TYPE check_status   AS ENUM ('pending','pass','fail','waived');
CREATE TYPE acceptance_step AS ENUM ('dev_complete','qa_approved','lead_approved','client_accepted');
CREATE TYPE acceptance_state AS ENUM ('pending','passed','rejected','skipped');
CREATE TYPE timer_outcome  AS ENUM ('running','met','missed','paused','waived');
CREATE TYPE risk_band      AS ENUM ('low','medium','high','critical');

-- ------------------------------------------------------------- identity ----
CREATE TABLE users (
  id                  TEXT PRIMARY KEY DEFAULT ('usr_' || encode(gen_random_bytes(9),'hex')),
  email               CITEXT NOT NULL UNIQUE,
  full_name           TEXT NOT NULL,
  title               TEXT NOT NULL DEFAULT '',
  role                user_role NOT NULL DEFAULT 'member',
  avatar_color        TEXT NOT NULL DEFAULT '#6366f1',
  initials            TEXT NOT NULL DEFAULT '',
  timezone            TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  capacity_hours_week NUMERIC(5,2) NOT NULL DEFAULT 32 CHECK (capacity_hours_week BETWEEN 0 AND 80),
  cost_rate_cents     INTEGER NOT NULL DEFAULT 0,
  bill_rate_cents     INTEGER NOT NULL DEFAULT 0,
  skills              TEXT[] NOT NULL DEFAULT '{}',
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id          TEXT PRIMARY KEY DEFAULT ('tm_' || encode(gen_random_bytes(9),'hex')),
  name        TEXT NOT NULL UNIQUE,
  slug        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, user_id)
);

-- ---------------------------------------------------------------- clients --
CREATE TABLE clients (
  id                    TEXT PRIMARY KEY DEFAULT ('cl_' || encode(gen_random_bytes(9),'hex')),
  name                  TEXT NOT NULL,
  slug                  TEXT NOT NULL UNIQUE,
  industry              TEXT NOT NULL DEFAULT '',
  initials              TEXT NOT NULL DEFAULT '',
  accent_color          TEXT NOT NULL DEFAULT '#7c8cff',
  tier                  client_tier NOT NULL DEFAULT 'growth',
  health                client_health NOT NULL DEFAULT 'healthy',
  primary_contact_name  TEXT NOT NULL DEFAULT '',
  primary_contact_email CITEXT NOT NULL DEFAULT '',
  primary_contact_role  TEXT NOT NULL DEFAULT '',
  notes                 TEXT NOT NULL DEFAULT '',
  mrr_cents             BIGINT NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE client_contacts (
  id         TEXT PRIMARY KEY DEFAULT ('ct_' || encode(gen_random_bytes(9),'hex')),
  client_id  TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  email      CITEXT NOT NULL DEFAULT '',
  role       TEXT NOT NULL DEFAULT '',
  phone      TEXT NOT NULL DEFAULT '',
  is_primary BOOLEAN NOT NULL DEFAULT FALSE
);

-- --------------------------------------------------------------- pipeline --
CREATE TABLE pipeline_stages (
  id                  TEXT PRIMARY KEY DEFAULT ('st_' || encode(gen_random_bytes(9),'hex')),
  key                 TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  phase               phase_stage NOT NULL,
  position            INTEGER NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  entry_criteria      TEXT NOT NULL DEFAULT '',
  exit_criteria       TEXT NOT NULL DEFAULT '',
  default_sla_days    INTEGER NOT NULL DEFAULT 7,
  default_value_cents BIGINT NOT NULL DEFAULT 0,
  color               TEXT NOT NULL DEFAULT '#6366f1',
  icon                TEXT NOT NULL DEFAULT 'circle'
);

CREATE TABLE deals (
  id                TEXT PRIMARY KEY DEFAULT ('dl_' || encode(gen_random_bytes(9),'hex')),
  client_id         TEXT NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  title             TEXT NOT NULL,
  value_cents       BIGINT NOT NULL DEFAULT 0,
  currency          CHAR(3) NOT NULL DEFAULT 'INR',
  status            deal_status NOT NULL DEFAULT 'open',
  stage_id          TEXT NOT NULL REFERENCES pipeline_stages(id),
  owner_id          TEXT REFERENCES users(id) ON DELETE SET NULL,
  source            TEXT NOT NULL DEFAULT 'inbound',
  probability       SMALLINT NOT NULL DEFAULT 40 CHECK (probability BETWEEN 0 AND 100),
  expected_close_at DATE,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  won_at            TIMESTAMPTZ,
  lost_at           TIMESTAMPTZ,
  lost_reason       TEXT NOT NULL DEFAULT '',
  next_step         TEXT NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX deals_stage_idx  ON deals(stage_id) WHERE status = 'open';
CREATE INDEX deals_owner_idx  ON deals(owner_id);

CREATE TABLE phases (
  id              TEXT PRIMARY KEY DEFAULT ('ph_' || encode(gen_random_bytes(9),'hex')),
  key             TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  position        INTEGER NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  sla_days        INTEGER NOT NULL DEFAULT 10,
  billable        BOOLEAN NOT NULL DEFAULT TRUE,
  color           TEXT NOT NULL DEFAULT '#6366f1',
  turnover_policy TEXT NOT NULL DEFAULT '',
  icon            TEXT NOT NULL DEFAULT 'circle'
);

CREATE TABLE deal_phase_runs (
  id             TEXT PRIMARY KEY DEFAULT ('dpr_' || encode(gen_random_bytes(9),'hex')),
  deal_id        TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  phase_id       TEXT NOT NULL REFERENCES phases(id),
  status         run_status NOT NULL DEFAULT 'locked',
  position       INTEGER NOT NULL DEFAULT 0,
  started_at     TIMESTAMPTZ,
  due_at         TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  approved_by    TEXT REFERENCES users(id),
  turnover_notes TEXT NOT NULL DEFAULT '',
  UNIQUE (deal_id, phase_id)
);

-- --------------------------------------------------------------- projects --
CREATE TABLE projects (
  id                 TEXT PRIMARY KEY DEFAULT ('pr_' || encode(gen_random_bytes(9),'hex')),
  key                TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  client_id          TEXT NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  deal_id            TEXT REFERENCES deals(id) ON DELETE SET NULL,
  owner_id           TEXT REFERENCES users(id) ON DELETE SET NULL,
  status             project_status NOT NULL DEFAULT 'active',
  health             client_health NOT NULL DEFAULT 'healthy',
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  target_end_at      DATE,
  budget_cents       BIGINT NOT NULL DEFAULT 0,
  hours_budget       NUMERIC(9,2) NOT NULL DEFAULT 0,
  description        TEXT NOT NULL DEFAULT '',
  repo_url           TEXT NOT NULL DEFAULT '',
  edge_case_target   INTEGER NOT NULL DEFAULT 3500,
  branch_name        TEXT NOT NULL DEFAULT 'lear-backend',
  deploy_target      TEXT NOT NULL DEFAULT 'AWS',
  demo_cadence_days  INTEGER NOT NULL DEFAULT 14,
  retention_risk     TEXT NOT NULL DEFAULT 'medium',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX projects_client_idx ON projects(client_id) WHERE status <> 'archived';

CREATE TABLE project_phases (
  id              TEXT PRIMARY KEY DEFAULT ('pph_' || encode(gen_random_bytes(9),'hex')),
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  phase_id        TEXT NOT NULL REFERENCES phases(id),
  status          run_status NOT NULL DEFAULT 'locked',
  position        INTEGER NOT NULL DEFAULT 0,
  progress        SMALLINT NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  started_at      TIMESTAMPTZ,
  due_at          TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  signoff_by      TEXT REFERENCES users(id),
  signoff_at      TIMESTAMPTZ,
  turnover_passed BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (project_id, phase_id)
);

CREATE TABLE milestones (
  id               TEXT PRIMARY KEY DEFAULT ('ms_' || encode(gen_random_bytes(9),'hex')),
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_phase_id TEXT REFERENCES project_phases(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  due_at           TIMESTAMPTZ,
  status           TEXT NOT NULL DEFAULT 'pending',
  completed_at     TIMESTAMPTZ,
  position         INTEGER NOT NULL DEFAULT 0
);

-- ------------------------------------------------------------------- work --
CREATE TABLE boards (
  id          TEXT PRIMARY KEY DEFAULT ('bd_' || encode(gen_random_bytes(9),'hex')),
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'delivery',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE columns (
  id        TEXT PRIMARY KEY,
  board_id  TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  key       task_status NOT NULL,
  name      TEXT NOT NULL,
  position  INTEGER NOT NULL DEFAULT 0,
  wip_limit INTEGER,
  is_done   BOOLEAN NOT NULL DEFAULT FALSE,
  color     TEXT NOT NULL DEFAULT '#64748b',
  UNIQUE (board_id, key)
);

CREATE TABLE labels (
  id          TEXT PRIMARY KEY DEFAULT ('lb_' || encode(gen_random_bytes(9),'hex')),
  name        TEXT NOT NULL UNIQUE,
  color       TEXT NOT NULL DEFAULT '#64748b',
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE tasks (
  id                   TEXT PRIMARY KEY DEFAULT ('tsk_' || encode(gen_random_bytes(9),'hex')),
  key                  TEXT NOT NULL UNIQUE,
  project_id           TEXT REFERENCES projects(id) ON DELETE CASCADE,
  board_id             TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  column_id            TEXT NOT NULL REFERENCES columns(id),
  parent_id            TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  project_phase_id     TEXT REFERENCES project_phases(id) ON DELETE SET NULL,
  title                TEXT NOT NULL CHECK (length(title) >= 4),
  description          TEXT NOT NULL DEFAULT '',
  type                 task_type NOT NULL DEFAULT 'feature',
  priority             task_priority NOT NULL DEFAULT 'medium',
  status               task_status NOT NULL DEFAULT 'todo',
  assignee_id          TEXT REFERENCES users(id) ON DELETE SET NULL,
  reporter_id          TEXT REFERENCES users(id) ON DELETE SET NULL,
  story_points         SMALLINT NOT NULL DEFAULT 0,
  estimate_hours       NUMERIC(7,2) NOT NULL DEFAULT 0,
  logged_hours         NUMERIC(7,2) NOT NULL DEFAULT 0,
  position             DOUBLE PRECISION NOT NULL DEFAULT 1000,
  due_at               DATE,
  sla_hours            INTEGER,
  sla_due_at           TIMESTAMPTZ,
  sla_breached         BOOLEAN NOT NULL DEFAULT FALSE,
  started_at           TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  blocked_reason       TEXT NOT NULL DEFAULT '',
  turnover_criteria    TEXT NOT NULL DEFAULT '',
  turnover_state       turnover_state NOT NULL DEFAULT 'draft',
  turnover_approved_by TEXT REFERENCES users(id),
  turnover_approved_at TIMESTAMPTZ,
  acceptance_step      acceptance_step NOT NULL DEFAULT 'dev_complete',
  qa_verified_by       TEXT REFERENCES users(id),
  lead_approved_by     TEXT REFERENCES users(id),
  client_accepted_at   TIMESTAMPTZ,
  branch               TEXT NOT NULL DEFAULT '',
  pr_url               TEXT NOT NULL DEFAULT '',
  client_visible       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Governance invariants live in the database as well as the service layer.
  CONSTRAINT blocked_needs_reason CHECK (status <> 'blocked' OR length(btrim(blocked_reason)) >= 8),
  CONSTRAINT done_needs_completion CHECK (status <> 'done' OR completed_at IS NOT NULL)
);
CREATE INDEX tasks_board_idx    ON tasks(board_id, column_id, position);
CREATE INDEX tasks_assignee_idx ON tasks(assignee_id, status);
CREATE INDEX tasks_due_idx      ON tasks(due_at) WHERE status NOT IN ('done','cancelled');
CREATE INDEX tasks_sla_idx      ON tasks(sla_due_at) WHERE status NOT IN ('done','cancelled');
CREATE INDEX tasks_search_idx   ON tasks USING gin (to_tsvector('english', title || ' ' || description));

CREATE TABLE task_labels (
  task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, label_id)
);

CREATE TABLE task_watchers (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, user_id)
);

CREATE TABLE task_dependencies (
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'blocks',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, depends_on_id),
  CONSTRAINT no_self_dependency CHECK (task_id <> depends_on_id)
);

CREATE TABLE task_checklist (
  id       TEXT PRIMARY KEY DEFAULT ('chk_' || encode(gen_random_bytes(9),'hex')),
  task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label    TEXT NOT NULL,
  done     BOOLEAN NOT NULL DEFAULT FALSE,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE task_comments (
  id         TEXT PRIMARY KEY DEFAULT ('cmt_' || encode(gen_random_bytes(9),'hex')),
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id  TEXT NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at  TIMESTAMPTZ
);

CREATE TABLE activity (
  id          BIGSERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  actor_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  verb        TEXT NOT NULL,
  summary     TEXT NOT NULL DEFAULT '',
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX activity_entity_idx  ON activity(entity_type, entity_id, created_at DESC);
CREATE INDEX activity_created_idx ON activity(created_at DESC);

CREATE TABLE time_entries (
  id         TEXT PRIMARY KEY DEFAULT ('te_' || encode(gen_random_bytes(9),'hex')),
  task_id    TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id),
  minutes    INTEGER NOT NULL CHECK (minutes > 0),
  note       TEXT NOT NULL DEFAULT '',
  billable   BOOLEAN NOT NULL DEFAULT TRUE,
  approved   BOOLEAN NOT NULL DEFAULT FALSE,
  worked_on  DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX time_project_idx ON time_entries(project_id, worked_on);

-- --------------------------------------------------- turnover + acceptance --
CREATE TABLE turnover_gates (
  id          TEXT PRIMARY KEY DEFAULT ('tg_' || encode(gen_random_bytes(9),'hex')),
  key         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  scope       TEXT NOT NULL CHECK (scope IN ('task','phase','project')),
  position    INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  required    BOOLEAN NOT NULL DEFAULT TRUE,
  owner_role  user_role NOT NULL DEFAULT 'lead',
  auto_rule   TEXT NOT NULL DEFAULT ''
);

CREATE TABLE turnover_checks (
  id               TEXT PRIMARY KEY DEFAULT ('tchk_' || encode(gen_random_bytes(9),'hex')),
  gate_id          TEXT NOT NULL REFERENCES turnover_gates(id) ON DELETE CASCADE,
  task_id          TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  project_phase_id TEXT REFERENCES project_phases(id) ON DELETE CASCADE,
  status           check_status NOT NULL DEFAULT 'pending',
  evidence         TEXT NOT NULL DEFAULT '',
  checked_by       TEXT REFERENCES users(id),
  checked_at       TIMESTAMPTZ,
  CONSTRAINT check_has_subject CHECK (task_id IS NOT NULL OR project_phase_id IS NOT NULL),
  -- The gate is meaningless without evidence: enforce it in the database too.
  CONSTRAINT pass_requires_evidence CHECK (status <> 'pass' OR length(btrim(evidence)) > 0)
);
CREATE INDEX checks_task_idx  ON turnover_checks(task_id);
CREATE INDEX checks_phase_idx ON turnover_checks(project_phase_id);

CREATE TABLE acceptance_records (
  id         TEXT PRIMARY KEY DEFAULT ('acc_' || encode(gen_random_bytes(9),'hex')),
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step       acceptance_step NOT NULL,
  state      acceptance_state NOT NULL DEFAULT 'pending',
  actor_id   TEXT REFERENCES users(id),
  evidence   TEXT NOT NULL DEFAULT '',
  notes      TEXT NOT NULL DEFAULT '',
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (task_id, step)
);

-- ----------------------------------------------------------------- clocks --
CREATE TABLE sla_clocks (
  id            TEXT PRIMARY KEY DEFAULT ('ck_' || encode(gen_random_bytes(9),'hex')),
  key           TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  scope         TEXT NOT NULL CHECK (scope IN ('deal','project','phase','task','release','qa')),
  anchor_event  TEXT NOT NULL,
  target_hours  INTEGER NOT NULL CHECK (target_hours > 0),
  warn_hours    INTEGER NOT NULL DEFAULT 0,
  stretch_hours INTEGER,
  enforceable   BOOLEAN NOT NULL DEFAULT TRUE,
  escalation    user_role NOT NULL DEFAULT 'lead',
  policy_note   TEXT NOT NULL DEFAULT '',
  board_ref     TEXT NOT NULL DEFAULT ''
);

CREATE TABLE sla_timers (
  id             TEXT PRIMARY KEY DEFAULT ('tmr_' || encode(gen_random_bytes(9),'hex')),
  clock_key      TEXT NOT NULL REFERENCES sla_clocks(key),
  entity_type    TEXT NOT NULL CHECK (entity_type IN ('deal','project','phase','task','release','qa')),
  entity_id      TEXT NOT NULL,
  label          TEXT NOT NULL DEFAULT '',
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_at         TIMESTAMPTZ NOT NULL,
  warn_at        TIMESTAMPTZ NOT NULL,
  paused_at      TIMESTAMPTZ,
  met_at         TIMESTAMPTZ,
  missed_at      TIMESTAMPTZ,
  outcome        timer_outcome NOT NULL DEFAULT 'running',
  exception_note TEXT NOT NULL DEFAULT '',
  minutes_used   INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT outcome_consistency CHECK (
    (outcome = 'met' AND met_at IS NOT NULL)
    OR (outcome = 'missed' AND missed_at IS NOT NULL)
    OR outcome IN ('running','paused','waived')
  )
);
CREATE INDEX timers_entity_idx ON sla_timers(entity_type, entity_id);
CREATE INDEX timers_due_idx    ON sla_timers(outcome, due_at);

CREATE TABLE sla_policies (
  id             TEXT PRIMARY KEY DEFAULT ('sla_' || encode(gen_random_bytes(9),'hex')),
  scope          TEXT NOT NULL DEFAULT 'task',
  priority       task_priority NOT NULL,
  response_hours INTEGER NOT NULL,
  resolve_hours  INTEGER NOT NULL,
  escalate_to    TEXT REFERENCES users(id),
  UNIQUE (scope, priority)
);

-- --------------------------------------------------------------- QA + ship --
CREATE TABLE qa_reports (
  id           TEXT PRIMARY KEY DEFAULT ('qa_' || encode(gen_random_bytes(9),'hex')),
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id      TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  release_id   TEXT,
  kind         TEXT NOT NULL CHECK (kind IN ('bug','test','regression','security','a11y','perf')),
  severity     TEXT NOT NULL DEFAULT 'p3' CHECK (severity IN ('p0','p1','p2','p3','p4')),
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'open'
               CHECK (status IN ('open','triaged','in_progress','fixed','verified','wont_fix','duplicate')),
  reproduction TEXT NOT NULL DEFAULT '',
  evidence_url TEXT NOT NULL DEFAULT '',
  reporter_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  assignee_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  due_at       TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX qa_open_idx ON qa_reports(project_id, severity) WHERE status NOT IN ('verified','wont_fix','duplicate');

CREATE TABLE edge_cases (
  id          TEXT PRIMARY KEY DEFAULT ('edge_' || encode(gen_random_bytes(9),'hex')),
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  module      TEXT NOT NULL,
  code        TEXT NOT NULL,
  scenario    TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'functional',
  severity    TEXT NOT NULL DEFAULT 'medium',
  status      TEXT NOT NULL DEFAULT 'catalogued'
              CHECK (status IN ('catalogued','covered','verified','deferred','not_applicable')),
  automated   BOOLEAN NOT NULL DEFAULT FALSE,
  verified_by TEXT REFERENCES users(id),
  verified_at TIMESTAMPTZ,
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, code)
);

CREATE TABLE releases (
  id                  TEXT PRIMARY KEY DEFAULT ('rel_' || encode(gen_random_bytes(9),'hex')),
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version             TEXT NOT NULL,
  name                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'planning'
                      CHECK (status IN ('planning','in_qa','demo_ready','demo_done','approved','shipped','rolled_back')),
  demo_at             TIMESTAMPTZ,
  demo_approved_at    TIMESTAMPTZ,
  demo_feedback       TEXT NOT NULL DEFAULT '',
  exec_summary_due_at TIMESTAMPTZ,
  exec_summary_url    TEXT NOT NULL DEFAULT '',
  ship_planned_at     TIMESTAMPTZ,
  shipped_at          TIMESTAMPTZ,
  branch              TEXT NOT NULL DEFAULT 'lear-backend',
  deploy_target       TEXT NOT NULL DEFAULT 'AWS · ap-south-1',
  rollback_plan       TEXT NOT NULL DEFAULT '',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Shipping without a published executive summary is not allowed.
  CONSTRAINT ship_needs_exec_summary CHECK (status <> 'shipped' OR length(exec_summary_url) > 0)
);

-- ------------------------------------------------------- partner console ---
CREATE TABLE partners (
  id              TEXT PRIMARY KEY DEFAULT ('pa_' || encode(gen_random_bytes(9),'hex')),
  client_id       TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL UNIQUE,
  console_url     TEXT NOT NULL DEFAULT '',
  plan            TEXT NOT NULL DEFAULT 'growth' CHECK (plan IN ('starter','growth','enterprise')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','trial','suspended')),
  device_limit    INTEGER NOT NULL DEFAULT 50,
  api_quota_month INTEGER NOT NULL DEFAULT 100000,
  seat_limit      INTEGER NOT NULL DEFAULT 10,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE partner_iam_users (
  id             TEXT PRIMARY KEY DEFAULT ('iam_' || encode(gen_random_bytes(9),'hex')),
  partner_id     TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  email          CITEXT NOT NULL,
  display_name   TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner','admin','operator','viewer','service')),
  mfa_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  last_active_at TIMESTAMPTZ,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','invited','disabled')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (partner_id, email)
);

CREATE TABLE device_licenses (
  id           TEXT PRIMARY KEY DEFAULT ('dev_' || encode(gen_random_bytes(9),'hex')),
  partner_id   TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  device_id    TEXT NOT NULL,
  device_name  TEXT NOT NULL,
  platform     TEXT NOT NULL DEFAULT 'android',
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','unassigned')),
  assigned_to  TEXT NOT NULL DEFAULT '',
  activated_at TIMESTAMPTZ,
  UNIQUE (partner_id, device_id)
);

CREATE TABLE usage_metrics (
  id           TEXT PRIMARY KEY DEFAULT ('usg_' || encode(gen_random_bytes(9),'hex')),
  partner_id   TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  day          DATE NOT NULL,
  api_calls    INTEGER NOT NULL DEFAULT 0,
  active_users INTEGER NOT NULL DEFAULT 0,
  storage_mb   INTEGER NOT NULL DEFAULT 0,
  uptime_pct   NUMERIC(5,2) NOT NULL DEFAULT 100,
  UNIQUE (partner_id, day)
);
CREATE INDEX usage_partner_idx ON usage_metrics(partner_id, day DESC);

-- --------------------------------------------------------- knowledge + ops --
CREATE TABLE docs (
  id             TEXT PRIMARY KEY DEFAULT ('doc_' || encode(gen_random_bytes(9),'hex')),
  project_id     TEXT REFERENCES projects(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'note'
                 CHECK (kind IN ('runbook','adr','spec','note','retro','exec_summary','onboarding')),
  body           TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','approved','archived')),
  author_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  client_visible BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE handoffs (
  id               TEXT PRIMARY KEY DEFAULT ('hnd_' || encode(gen_random_bytes(9),'hex')),
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_phase_id TEXT REFERENCES project_phases(id) ON DELETE SET NULL,
  title            TEXT NOT NULL,
  type             TEXT NOT NULL DEFAULT 'excalidraw'
                   CHECK (type IN ('excalidraw','figma','loom','notion','drive','other')),
  url              TEXT NOT NULL,
  shared_with      TEXT NOT NULL DEFAULT 'client',
  status           TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','ready','shared','approved','changes_requested')),
  created_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  shared_at        TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE automation_rules (
  id          TEXT PRIMARY KEY DEFAULT ('aut_' || encode(gen_random_bytes(9),'hex')),
  name        TEXT NOT NULL,
  trigger_key TEXT NOT NULL,
  action_key  TEXT NOT NULL,
  config      JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  run_count   INTEGER NOT NULL DEFAULT 0,
  last_run_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id          TEXT PRIMARY KEY DEFAULT ('ntf_' || encode(gen_random_bytes(9),'hex')),
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  entity_type TEXT NOT NULL DEFAULT '',
  entity_id   TEXT NOT NULL DEFAULT '',
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notif_unread_idx ON notifications(user_id, created_at DESC) WHERE read_at IS NULL;

CREATE TABLE saved_views (
  id          TEXT PRIMARY KEY DEFAULT ('vw_' || encode(gen_random_bytes(9),'hex')),
  name        TEXT NOT NULL,
  owner_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
  surface     TEXT NOT NULL DEFAULT 'board',
  filters     JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_shared   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE capacity_snapshots (
  id             TEXT PRIMARY KEY DEFAULT ('cap_' || encode(gen_random_bytes(9),'hex')),
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start     DATE NOT NULL,
  capacity_hours NUMERIC(6,2) NOT NULL,
  planned_hours  NUMERIC(6,2) NOT NULL DEFAULT 0,
  logged_hours   NUMERIC(6,2) NOT NULL DEFAULT 0,
  UNIQUE (user_id, week_start)
);

CREATE TABLE schedule_runs (
  id            TEXT PRIMARY KEY DEFAULT ('run_' || encode(gen_random_bytes(9),'hex')),
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  algorithm     TEXT NOT NULL DEFAULT 'cpm+wspt',
  horizon_days  INTEGER NOT NULL DEFAULT 21,
  input_hash    TEXT NOT NULL DEFAULT '',
  stats         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE schedule_items (
  id            TEXT PRIMARY KEY DEFAULT ('si_' || encode(gen_random_bytes(9),'hex')),
  run_id        TEXT NOT NULL REFERENCES schedule_runs(id) ON DELETE CASCADE,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  assignee_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  sequence      INTEGER NOT NULL,
  planned_start DATE NOT NULL,
  planned_end   DATE NOT NULL,
  planned_hours NUMERIC(6,2) NOT NULL,
  risk_score    NUMERIC(5,2) NOT NULL DEFAULT 0,
  rationale     TEXT NOT NULL DEFAULT ''
);

CREATE TABLE risk_scores (
  id          TEXT PRIMARY KEY DEFAULT ('rsk_' || encode(gen_random_bytes(9),'hex')),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('task','project','deal')),
  entity_id   TEXT NOT NULL,
  score       NUMERIC(5,2) NOT NULL,
  band        risk_band NOT NULL,
  factors     JSONB NOT NULL DEFAULT '[]'::jsonb,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX risk_entity_idx ON risk_scores(entity_type, entity_id, computed_at DESC);

-- ----------------------------------------------------------------- audit ---
-- Append-only. A trigger rejects UPDATE/DELETE so the trail cannot be rewritten.
CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  actor_id    TEXT,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  before      JSONB,
  after       JSONB,
  request_id  TEXT NOT NULL DEFAULT '',
  ip          INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity_idx  ON audit_log(entity_type, entity_id);
CREATE INDEX audit_created_idx ON audit_log(created_at DESC);

CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (% not permitted)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

CREATE TABLE retention_policies (
  id          TEXT PRIMARY KEY DEFAULT ('ret_' || encode(gen_random_bytes(9),'hex')),
  table_name  TEXT NOT NULL UNIQUE,
  retain_days INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

-- Governance invariant: a task cannot be marked done while a required gate is
-- still pending or failed. Belt and braces alongside the service layer, so a
-- manual UPDATE or a future client cannot bypass turnover.
CREATE OR REPLACE FUNCTION enforce_turnover_before_done() RETURNS trigger AS $$
DECLARE
  outstanding INTEGER;
BEGIN
  IF NEW.status = 'done' AND OLD.status IS DISTINCT FROM 'done' THEN
    SELECT COUNT(*) INTO outstanding
    FROM turnover_checks c
    JOIN turnover_gates g ON g.id = c.gate_id
    WHERE c.task_id = NEW.id AND g.required AND c.status NOT IN ('pass','waived');
    IF outstanding > 0 THEN
      RAISE EXCEPTION 'Turnover gate blocked: % required check(s) outstanding for %', outstanding, NEW.key;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tasks_turnover_guard BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION enforce_turnover_before_done();

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tasks_touch BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER projects_touch BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER clients_touch BEFORE UPDATE ON clients FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

COMMIT;

-- ============================================================================
-- Deliberate differences from the SQLite development schema
--  1. Native ENUMs replace CHECK constraints, so invalid states cannot be
--     written at all.
--  2. TEXT[] for skills; JSONB for event envelopes (meta, filters, factors).
--  3. NUMERIC for hours (money-adjacent maths), BIGINT for paise/currency.
--  4. Constraints encode governance: pass_requires_evidence, blocked_needs_reason,
--     ship_needs_exec_summary, outcome_consistency.
--  5. Triggers: append-only audit_log, updated_at touch, and a hard
--     turnover-before-done guard.
--  6. Partial indexes on the hot "open work" predicates.
--  7. CITEXT for e-mail addresses; INET for audit source addresses.
-- ============================================================================
