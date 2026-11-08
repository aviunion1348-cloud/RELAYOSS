-- GENERATED from db/migrations/0002_work.sql — do not edit by hand.
-- Regenerate with: node scripts/gen-pg-migrations.mjs

-- ============================================================================
-- Relay OSS · 0002_work.sql
-- Boards, tasks, dependencies, collaboration, time tracking and the
-- turnover-gate ("definition of done") enforcement layer.
-- ============================================================================

CREATE TABLE boards (
  id          TEXT PRIMARY KEY,
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE, -- NULL = org board
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'delivery'
              CHECK (kind IN ('delivery','triage','roadmap','personal')),
  created_at  TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS'))
);
CREATE INDEX idx_boards_project ON boards(project_id);

CREATE TABLE columns (
  id        TEXT PRIMARY KEY,
  board_id  TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  key       TEXT NOT NULL,
  name      TEXT NOT NULL,
  position  INTEGER NOT NULL DEFAULT 0,
  wip_limit INTEGER,
  is_done   SMALLINT NOT NULL DEFAULT 0 CHECK (is_done IN (0,1)),
  color     TEXT NOT NULL DEFAULT '#64748b',
  UNIQUE (board_id, key)
);
CREATE INDEX idx_columns_board ON columns(board_id, position);

CREATE TABLE labels (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  color      TEXT NOT NULL DEFAULT '#64748b',
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE tasks (
  id             TEXT PRIMARY KEY,
  key            TEXT NOT NULL UNIQUE,               -- RLY-142
  project_id     TEXT REFERENCES projects(id) ON DELETE CASCADE,
  board_id       TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  column_id      TEXT NOT NULL REFERENCES columns(id),
  parent_id      TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  project_phase_id TEXT REFERENCES project_phases(id) ON DELETE SET NULL,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  type           TEXT NOT NULL DEFAULT 'feature'
                 CHECK (type IN ('feature','bug','research','design','ops','meeting','content')),
  priority       TEXT NOT NULL DEFAULT 'medium'
                 CHECK (priority IN ('urgent','high','medium','low')),
  status         TEXT NOT NULL DEFAULT 'todo'
                 CHECK (status IN ('backlog','todo','in_progress','review','blocked','done','cancelled')),
  assignee_id    TEXT REFERENCES users(id),
  reporter_id    TEXT REFERENCES users(id),
  story_points   INTEGER NOT NULL DEFAULT 0,
  estimate_hours DOUBLE PRECISION NOT NULL DEFAULT 0,
  logged_hours   DOUBLE PRECISION NOT NULL DEFAULT 0,
  position       DOUBLE PRECISION NOT NULL DEFAULT 1000,
  due_at         TEXT,
  sla_hours      INTEGER,
  sla_due_at     TEXT,
  sla_breached   INTEGER NOT NULL DEFAULT 0,
  started_at     TEXT,
  completed_at   TEXT,
  blocked_reason TEXT NOT NULL DEFAULT '',
  turnover_criteria TEXT NOT NULL DEFAULT '',
  turnover_state TEXT NOT NULL DEFAULT 'draft'
                 CHECK (turnover_state IN ('draft','in_review','passed','failed','waived')),
  turnover_approved_by TEXT REFERENCES users(id),
  turnover_approved_at TEXT,
  client_visible SMALLINT NOT NULL DEFAULT 0 CHECK (client_visible IN (0,1)),
  created_at     TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')),
  updated_at     TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS'))
);
CREATE INDEX idx_tasks_board ON tasks(board_id, column_id, position);
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_id, status);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_due ON tasks(due_at);
CREATE INDEX idx_tasks_parent ON tasks(parent_id);

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
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'blocks' CHECK (kind IN ('blocks','relates')),
  created_at   TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')),
  PRIMARY KEY (task_id, depends_on_id)
);
CREATE INDEX idx_deps_reverse ON task_dependencies(depends_on_id);

CREATE TABLE task_checklist (
  id       TEXT PRIMARY KEY,
  task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label    TEXT NOT NULL,
  done     SMALLINT NOT NULL DEFAULT 0 CHECK (done IN (0,1)),
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_checklist_task ON task_checklist(task_id);

CREATE TABLE task_comments (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id  TEXT NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')),
  edited_at  TEXT
);
CREATE INDEX idx_comments_task ON task_comments(task_id, created_at);

CREATE TABLE activity (
  id          BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  actor_id    TEXT REFERENCES users(id),
  verb        TEXT NOT NULL,
  summary     TEXT NOT NULL DEFAULT '',
  meta_json   TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS'))
);
CREATE INDEX idx_activity_entity ON activity(entity_type, entity_id, created_at DESC);
CREATE INDEX idx_activity_created ON activity(created_at DESC);

-- ------------------------------------------------------------ time & cost --
CREATE TABLE time_entries (
  id          TEXT PRIMARY KEY,
  task_id     TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id),
  minutes     INTEGER NOT NULL CHECK (minutes > 0),
  note        TEXT NOT NULL DEFAULT '',
  billable    SMALLINT NOT NULL DEFAULT 1 CHECK (billable IN (0,1)),
  approved    INTEGER NOT NULL DEFAULT 0,
  worked_on   TEXT NOT NULL DEFAULT (date('now')),
  created_at  TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS'))
);
CREATE INDEX idx_time_project ON time_entries(project_id, worked_on);
CREATE INDEX idx_time_user ON time_entries(user_id, worked_on);

-- -------------------------------------------------------- turnover gates --
-- A gate is a reusable, versioned policy. Checks record evidence per subject.
CREATE TABLE turnover_gates (
  id          TEXT PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  scope       TEXT NOT NULL CHECK (scope IN ('task','phase','project')),
  position    INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  required    SMALLINT NOT NULL DEFAULT 1 CHECK (required IN (0,1)),
  owner_role  TEXT NOT NULL DEFAULT 'lead',
  auto_rule   TEXT NOT NULL DEFAULT ''  -- machine-evaluable hint for the engine
);

CREATE TABLE turnover_checks (
  id               TEXT PRIMARY KEY,
  gate_id          TEXT NOT NULL REFERENCES turnover_gates(id) ON DELETE CASCADE,
  task_id          TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  project_phase_id TEXT REFERENCES project_phases(id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','pass','fail','waived')),
  evidence         TEXT NOT NULL DEFAULT '',
  checked_by       TEXT REFERENCES users(id),
  checked_at       TEXT,
  CHECK (task_id IS NOT NULL OR project_phase_id IS NOT NULL)
);
CREATE INDEX idx_checks_task ON turnover_checks(task_id);
CREATE INDEX idx_checks_phase ON turnover_checks(project_phase_id);

CREATE TABLE sla_policies (
  id             TEXT PRIMARY KEY,
  scope          TEXT NOT NULL DEFAULT 'task',
  priority       TEXT NOT NULL CHECK (priority IN ('urgent','high','medium','low')),
  response_hours INTEGER NOT NULL,
  resolve_hours  INTEGER NOT NULL,
  escalate_to    TEXT REFERENCES users(id)
);
CREATE UNIQUE INDEX idx_sla_scope_priority ON sla_policies(scope, priority);
