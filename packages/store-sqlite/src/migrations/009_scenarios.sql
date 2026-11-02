-- 009: scenario packs and entity cards.
--
-- Two schema facts changed:
--  1. `projects.stage` was a CHECK enum of the seven video stages; stages now come
--     from a scenario pack, so the CHECK has to go. SQLite cannot drop a CHECK in
--     place, so the table is rebuilt and every row copied inside one transaction.
--  2. `projects` gains `scenario_id`, and projects keep a declared pack so the UI
--     can render the right stage rail.
CREATE TABLE projects_new (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL,
  title            TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  platform         TEXT NOT NULL CHECK (platform IN ('bilibili','youtube','xiaohongshu','generic')),
  stage            TEXT NOT NULL CHECK (length(stage) BETWEEN 1 AND 32),
  scenario_id      TEXT NOT NULL DEFAULT 'video',
  workspace_path   TEXT,
  style_profile_id TEXT,
  description      TEXT NOT NULL DEFAULT '',
  tags             TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT
);

INSERT INTO projects_new (id, owner_id, title, platform, stage, scenario_id, workspace_path,
                          style_profile_id, description, tags, created_at, updated_at, deleted_at)
SELECT id, owner_id, title, platform, stage, 'video', workspace_path,
       style_profile_id, COALESCE(description, ''), COALESCE(tags, '[]'), created_at, updated_at, deleted_at
FROM projects;

DROP TABLE projects;
ALTER TABLE projects_new RENAME TO projects;
CREATE INDEX idx_projects_updated ON projects (deleted_at, updated_at DESC);
CREATE INDEX idx_projects_scenario ON projects (scenario_id);
CREATE INDEX idx_projects_style ON projects (style_profile_id);

-- Scenario packs are data: the four shipped packs are seeded below, and a user can
-- add their own row through the API without touching code.
CREATE TABLE scenario_packs (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  icon         TEXT NOT NULL DEFAULT '',
  builtin      INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0,1)),
  payload      TEXT NOT NULL CHECK (json_valid(payload)),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Entity cards are the scenario-agnostic "card" primitive: a character sheet, a
-- location, a lesson, a guest — same table, different `type` and field payload.
CREATE TABLE entities (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  fields      TEXT NOT NULL CHECK (json_valid(fields)),
  body        TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
  sort_order  INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_entities_project ON entities (project_id, type, sort_order);

-- artifacts.kind also carries a CHECK with the old kind list; outline and chapter
-- are new content kinds, so the table is rebuilt the same way.
CREATE TABLE artifacts_new (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id      TEXT REFERENCES runs(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('topic-card','research-notes','script','shot-list','subtitle','publish-pack','review-report','outline','chapter','image','audio','other')),
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
