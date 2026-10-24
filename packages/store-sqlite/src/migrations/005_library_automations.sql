-- 005: project metadata, scheduled automations and review metrics.
ALTER TABLE projects ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';

CREATE TABLE automations (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('topic-card','research-notes','publish-pack')),
  prompt           TEXT NOT NULL,
  interval_minutes INTEGER NOT NULL CHECK (interval_minutes BETWEEN 15 AND 10080),
  enabled          INTEGER NOT NULL CHECK (enabled IN (0,1)),
  last_run_at      TEXT,
  next_run_at      TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_automations_due ON automations (enabled, next_run_at);

CREATE TABLE automation_runs (
  id          TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  status      TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  artifact_id TEXT,
  error       TEXT,
  started_at  TEXT NOT NULL,
  ended_at    TEXT
);
CREATE INDEX idx_automation_runs ON automation_runs (automation_id, started_at DESC);

CREATE TABLE project_metrics (
  id                 TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  recorded_at         TEXT NOT NULL,
  views               INTEGER NOT NULL CHECK (views >= 0),
  likes               INTEGER NOT NULL CHECK (likes >= 0),
  comments            INTEGER NOT NULL CHECK (comments >= 0),
  shares              INTEGER NOT NULL CHECK (shares >= 0),
  retention_percent   REAL NOT NULL CHECK (retention_percent BETWEEN 0 AND 100),
  revenue_cny         REAL NOT NULL CHECK (revenue_cny >= 0),
  note                TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_metrics_project ON project_metrics (project_id, recorded_at DESC);
