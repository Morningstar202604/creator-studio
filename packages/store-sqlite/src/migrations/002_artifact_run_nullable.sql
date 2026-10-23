-- 002: artifacts may be authored manually (editor saves) without a producing Run.
-- SQLite cannot drop NOT NULL in place, so rebuild the table and copy rows.
CREATE TABLE artifacts_new (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id      TEXT REFERENCES runs(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('topic-card','research-notes','script','shot-list','subtitle','publish-pack','review-report','image','audio','other')),
  path        TEXT NOT NULL,
  sha256      TEXT NOT NULL CHECK (length(sha256) = 64),
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL CHECK (size >= 0),
  visibility  TEXT NOT NULL CHECK (visibility IN ('local','synced')),
  created_at  TEXT NOT NULL
);

INSERT INTO artifacts_new (id, project_id, run_id, kind, path, sha256, mime, size, visibility, created_at)
SELECT id, project_id, run_id, kind, path, sha256, mime, size, visibility, created_at FROM artifacts;

DROP TABLE artifacts;
ALTER TABLE artifacts_new RENAME TO artifacts;
CREATE INDEX idx_artifacts_project ON artifacts (project_id, created_at DESC);
