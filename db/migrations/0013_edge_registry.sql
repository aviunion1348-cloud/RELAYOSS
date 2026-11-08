-- ---------------------------------------------------------------------------
-- 0013 — Edge-case registry at the level the brief requires (R34, R38).
--
-- `edge_cases` already held a code, a scenario and a status. That is a list, not
-- a registry: it cannot express preconditions, steps, expected vs actual, who
-- executed it and when, what evidence exists, which defect it found, or whether
-- a pass was waived and by whom. Those are the fields that let a reviewer trust
-- a "3,500 executed" claim, so they are the fields added here.
--
-- Nothing is seeded. A registry filled with invented rows would be worse than an
-- empty one, so the runner writes real results and the gate fails closed until
-- they exist.
-- ---------------------------------------------------------------------------
ALTER TABLE edge_cases ADD COLUMN preconditions TEXT NOT NULL DEFAULT '';
ALTER TABLE edge_cases ADD COLUMN steps TEXT NOT NULL DEFAULT '';
ALTER TABLE edge_cases ADD COLUMN expected TEXT NOT NULL DEFAULT '';
ALTER TABLE edge_cases ADD COLUMN actual TEXT NOT NULL DEFAULT '';
ALTER TABLE edge_cases ADD COLUMN executed_by TEXT REFERENCES users(id);
ALTER TABLE edge_cases ADD COLUMN executed_at TEXT;
ALTER TABLE edge_cases ADD COLUMN duration_ms INTEGER;
ALTER TABLE edge_cases ADD COLUMN evidence TEXT NOT NULL DEFAULT '';
ALTER TABLE edge_cases ADD COLUMN related_bug TEXT NOT NULL DEFAULT '';
ALTER TABLE edge_cases ADD COLUMN waived_by TEXT REFERENCES users(id);
ALTER TABLE edge_cases ADD COLUMN waiver_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE edge_cases ADD COLUMN release_id TEXT REFERENCES releases(id) ON DELETE SET NULL;
ALTER TABLE edge_cases ADD COLUMN fingerprint TEXT NOT NULL DEFAULT '';

-- Execution status is a separate axis from catalogue status: a case can be
-- catalogued for a year and executed only in the release it ships with.
--   not_executed | passed | failed | waived | blocked
ALTER TABLE edge_cases ADD COLUMN execution TEXT NOT NULL DEFAULT 'not_executed'
  CHECK (execution IN ('not_executed','passed','failed','waived','blocked'));

-- Every distinct case has a fingerprint (module + normalised scenario + inputs)
-- so the catalogue cannot be padded with near-duplicates.
CREATE INDEX idx_edge_fingerprint ON edge_cases(project_id, fingerprint);
CREATE INDEX idx_edge_execution ON edge_cases(project_id, execution);
CREATE INDEX idx_edge_release ON edge_cases(release_id, execution);

-- Immutable per-run results. `edge_cases` holds the current truth; this table is
-- the history, so "executed and passed" can be evidenced per release rather than
-- inferred from a mutable column.
CREATE TABLE edge_runs (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  release_id   TEXT REFERENCES releases(id) ON DELETE SET NULL,
  case_id      TEXT NOT NULL REFERENCES edge_cases(id) ON DELETE CASCADE,
  result       TEXT NOT NULL CHECK (result IN ('passed','failed','waived','blocked','not_executed')),
  runner       TEXT NOT NULL DEFAULT '',
  executed_by  TEXT REFERENCES users(id),
  duration_ms  INTEGER,
  detail       TEXT NOT NULL DEFAULT '',
  evidence     TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_edge_runs_project ON edge_runs(project_id, created_at);
CREATE INDEX idx_edge_runs_case ON edge_runs(case_id, created_at);

-- Coverage is recorded per module so a gap is visible as a number, not a feeling.
CREATE TABLE edge_module_coverage (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  module      TEXT NOT NULL,
  endpoint    TEXT NOT NULL DEFAULT '',
  target      INTEGER NOT NULL DEFAULT 0,
  actual      INTEGER NOT NULL DEFAULT 0,
  notes       TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, module)
);
