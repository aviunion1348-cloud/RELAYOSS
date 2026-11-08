-- GENERATED from db/migrations/0004_delivery_os.sql — do not edit by hand.
-- Regenerate with: node scripts/gen-pg-migrations.mjs

-- ============================================================================
-- Relay OSS · 0004_delivery_os.sql
-- Everything extracted from the delivery-ops Excaliboard:
--   • named operational clocks with hard turnovers (3d consult→plan, 12–32h
--     revisions, 24h module turnover, 7d milestone, ≤2w client turnover,
--     14d first demo, 5d ship-after-approval, 12h QA report, 48h exec summary)
--   • the four-step acceptance ladder (dev → QA → lead → client)
--   • QA reports, edge-case ledger with the 3,500 gate
--   • releases (demo → approval → ship) with exec-summary enforcement
--   • partner console: IAM users, device licences, usage metering
--   • knowledge base: runbooks, ADRs, docs
-- ============================================================================

-- --------------------------------------------------------- operational SLA --
-- A clock *definition* is data: policy can change without a deploy.
CREATE TABLE sla_clocks (
  id            TEXT PRIMARY KEY,
  key           TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  scope         TEXT NOT NULL CHECK (scope IN ('deal','project','phase','task','release','qa')),
  anchor_event  TEXT NOT NULL,          -- what starts the clock
  target_hours  INTEGER NOT NULL,       -- hard limit
  warn_hours    INTEGER NOT NULL DEFAULT 0, -- amber threshold
  stretch_hours INTEGER,                -- the aggressive internal target
  enforceable   SMALLINT NOT NULL DEFAULT 1 CHECK (enforceable IN (0,1)),
  escalation    TEXT NOT NULL DEFAULT 'lead',
  policy_note   TEXT NOT NULL DEFAULT '',
  board_ref     TEXT NOT NULL DEFAULT ''
);

-- A clock *instance* running against a real entity.
CREATE TABLE sla_timers (
  id           TEXT PRIMARY KEY,
  clock_key    TEXT NOT NULL REFERENCES sla_clocks(key),
  entity_type  TEXT NOT NULL CHECK (entity_type IN ('deal','project','phase','task','release','qa')),
  entity_id    TEXT NOT NULL,
  label        TEXT NOT NULL DEFAULT '',
  started_at   TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')),
  due_at       TEXT NOT NULL,
  warn_at      TEXT NOT NULL,
  paused_at    TEXT,
  met_at       TEXT,
  missed_at    TEXT,
  outcome      TEXT NOT NULL DEFAULT 'running'
               CHECK (outcome IN ('running','met','missed','paused','waived')),
  exception_note TEXT NOT NULL DEFAULT '',
  minutes_used INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS'))
);
CREATE INDEX idx_timers_entity ON sla_timers(entity_type, entity_id);
CREATE INDEX idx_timers_due ON sla_timers(outcome, due_at);

-- ------------------------------------------------------- acceptance ladder --
-- "A task marked complete is not a feature accepted for turnover."
CREATE TABLE acceptance_records (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step          TEXT NOT NULL CHECK (step IN ('dev_complete','qa_approved','lead_approved','client_accepted')),
  state         TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','passed','rejected','skipped')),
  actor_id      TEXT REFERENCES users(id),
  evidence      TEXT NOT NULL DEFAULT '',
  notes         TEXT NOT NULL DEFAULT '',
  decided_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')),
  UNIQUE (task_id, step)
);
CREATE INDEX idx_acceptance_task ON acceptance_records(task_id);

-- --------------------------------------------------------------- QA centre --
CREATE TABLE qa_reports (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id       TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  release_id    TEXT,
  kind          TEXT NOT NULL CHECK (kind IN ('bug','test','regression','security','a11y','perf')),
  severity      TEXT NOT NULL DEFAULT 'p3' CHECK (severity IN ('p0','p1','p2','p3','p4')),
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','triaged','in_progress','fixed','verified','wont_fix','duplicate')),
  reproduction  TEXT NOT NULL DEFAULT '',
  evidence_url  TEXT NOT NULL DEFAULT '',
  reporter_id   TEXT REFERENCES users(id),
  assignee_id   TEXT REFERENCES users(id),
  due_at        TEXT,   -- 12h turnover clock
  submitted_at  TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')),
  resolved_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS'))
);
CREATE INDEX idx_qa_project ON qa_reports(project_id, status);
CREATE INDEX idx_qa_due ON qa_reports(status, due_at);

-- The 3,500 edge-case ledger is an explicit shipping gate.
CREATE TABLE edge_cases (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  module        TEXT NOT NULL,
  code          TEXT NOT NULL,
  scenario      TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT 'functional'
                CHECK (category IN ('functional','data','network','permission','concurrency','i18n','security','device')),
  severity      TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high','critical')),
  status        TEXT NOT NULL DEFAULT 'catalogued'
                CHECK (status IN ('catalogued','covered','verified','deferred','not_applicable')),
  automated     INTEGER NOT NULL DEFAULT 0,
  verified_by   TEXT REFERENCES users(id),
  verified_at   TEXT,
  notes         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')),
  UNIQUE (project_id, code)
);
CREATE INDEX idx_edge_project ON edge_cases(project_id, status);

-- ------------------------------------------------------------ releases -----
CREATE TABLE releases (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version         TEXT NOT NULL,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'planning'
                  CHECK (status IN ('planning','in_qa','demo_ready','demo_done','approved','shipped','rolled_back')),
  demo_at         TEXT,
  demo_approved_at TEXT,
  demo_feedback   TEXT NOT NULL DEFAULT '',
  exec_summary_due_at TEXT,
  exec_summary_url TEXT NOT NULL DEFAULT '',
  ship_planned_at TEXT,
  shipped_at      TEXT,
  branch          TEXT NOT NULL DEFAULT 'lear-backend',
  deploy_target   TEXT NOT NULL DEFAULT 'AWS · ap-south-1',
  rollback_plan   TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS'))
);
CREATE INDEX idx_releases_project ON releases(project_id, status);

-- ------------------------------------------------------- partner console ---
CREATE TABLE partners (
  id             TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  slug           TEXT NOT NULL UNIQUE,
  console_url    TEXT NOT NULL DEFAULT '',
  plan           TEXT NOT NULL DEFAULT 'growth' CHECK (plan IN ('starter','growth','enterprise')),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','trial','suspended')),
  device_limit   INTEGER NOT NULL DEFAULT 50,
  api_quota_month INTEGER NOT NULL DEFAULT 100000,
  seat_limit     INTEGER NOT NULL DEFAULT 10,
  created_at     TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS'))
);

CREATE TABLE partner_iam_users (
  id          TEXT PRIMARY KEY,
  partner_id  TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner','admin','operator','viewer','service')),
  mfa_enabled INTEGER NOT NULL DEFAULT 0,
  last_active_at TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','invited','disabled')),
  created_at  TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')),
  UNIQUE (partner_id, email)
);

CREATE TABLE device_licenses (
  id          TEXT PRIMARY KEY,
  partner_id  TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  device_id   TEXT NOT NULL,
  device_name TEXT NOT NULL,
  platform    TEXT NOT NULL DEFAULT 'android',
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','unassigned')),
  assigned_to TEXT NOT NULL DEFAULT '',
  activated_at TEXT,
  UNIQUE (partner_id, device_id)
);

CREATE TABLE usage_metrics (
  id          TEXT PRIMARY KEY,
  partner_id  TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  day         TEXT NOT NULL,
  api_calls   INTEGER NOT NULL DEFAULT 0,
  active_users INTEGER NOT NULL DEFAULT 0,
  storage_mb  INTEGER NOT NULL DEFAULT 0,
  uptime_pct  DOUBLE PRECISION NOT NULL DEFAULT 100,
  UNIQUE (partner_id, day)
);
CREATE INDEX idx_usage_partner ON usage_metrics(partner_id, day);

-- ------------------------------------------------------- knowledge base ----
CREATE TABLE docs (
  id          TEXT PRIMARY KEY,
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'note'
              CHECK (kind IN ('runbook','adr','spec','note','retro','exec_summary','onboarding')),
  body        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','approved','archived')),
  author_id   TEXT REFERENCES users(id),
  client_visible SMALLINT NOT NULL DEFAULT 0 CHECK (client_visible IN (0,1)),
  updated_at  TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')),
  created_at  TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS'))
);
CREATE INDEX idx_docs_project ON docs(project_id, kind);

-- Ship-gate counters live on the project so the board can render the gate
-- without aggregating 3,500 rows on every paint.
ALTER TABLE projects ADD COLUMN edge_case_target INTEGER NOT NULL DEFAULT 3500;
ALTER TABLE projects ADD COLUMN branch_name TEXT NOT NULL DEFAULT 'lear-backend';
ALTER TABLE projects ADD COLUMN deploy_target TEXT NOT NULL DEFAULT 'AWS';
ALTER TABLE projects ADD COLUMN demo_cadence_days INTEGER NOT NULL DEFAULT 14;
ALTER TABLE projects ADD COLUMN retention_risk TEXT NOT NULL DEFAULT 'medium'
  CHECK (retention_risk IN ('low','medium','high'));

-- Task-level acceptance ladder summary (denormalised for board rendering;
-- the source of truth remains acceptance_records).
ALTER TABLE tasks ADD COLUMN acceptance_step TEXT NOT NULL DEFAULT 'dev_complete'
  CHECK (acceptance_step IN ('dev_complete','qa_approved','lead_approved','client_accepted'));
ALTER TABLE tasks ADD COLUMN qa_verified_by TEXT REFERENCES users(id);
ALTER TABLE tasks ADD COLUMN lead_approved_by TEXT REFERENCES users(id);
ALTER TABLE tasks ADD COLUMN client_accepted_at TEXT;
ALTER TABLE tasks ADD COLUMN branch TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN pr_url TEXT NOT NULL DEFAULT '';
