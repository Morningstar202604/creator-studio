-- 013: an automation run may end in `interrupted`.
--
-- The original CHECK allowed only running/succeeded/failed. That assumed every run
-- reaches a terminal state in the same process that started it, which is false: a
-- daemon killed mid-generation leaves the row at `running` forever, and the UI then
-- shows a run that will never finish. Startup now corrects those rows, and it needs
-- a status to write. SQLite cannot alter a CHECK in place, so the table is rebuilt.
CREATE TABLE automation_runs_new (
  id            TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  status        TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','interrupted')),
  artifact_id   TEXT,
  error         TEXT,
  started_at    TEXT NOT NULL,
  ended_at      TEXT
);

INSERT INTO automation_runs_new (id, automation_id, status, artifact_id, error, started_at, ended_at)
  SELECT id, automation_id, status, artifact_id, error, started_at, ended_at FROM automation_runs;

DROP TABLE automation_runs;
ALTER TABLE automation_runs_new RENAME TO automation_runs;

CREATE INDEX idx_automation_runs ON automation_runs (automation_id, started_at DESC);
