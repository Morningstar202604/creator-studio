-- 014: chapter revisions and optimistic concurrency for entity cards.
--
-- Before this migration a PATCH replaced the whole card, so two clients editing
-- the same chapter both succeeded and the second write silently erased the first.
-- Two changes fix that:
--
--   entities.revision          the row's version, incremented on every write.
--                              A client sends the revision it read; a write whose
--                              WHERE clause misses means someone else got there
--                              first and the daemon answers 409 instead of
--                              overwriting.
--   entity_revisions           the previous state of each card, appended on every
--                              write. Cheap (one row per save, capped per card)
--                              and it makes "restore what it looked like" a read
--                              rather than a reconstruction from logs.
ALTER TABLE entities ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;

CREATE TABLE entity_revisions (
  id          TEXT PRIMARY KEY,
  entity_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision    INTEGER NOT NULL,
  title       TEXT NOT NULL,
  fields      TEXT NOT NULL CHECK (json_valid(fields)),
  body        TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
  created_at  TEXT NOT NULL,
  -- Distinguishes an ordinary autosave from a deliberate restore, so the history
  -- list can say why a version exists instead of showing two identical rows.
  reason      TEXT NOT NULL DEFAULT 'save' CHECK (reason IN ('save','restore','conflict'))
);

-- The history view always reads "newest first for one card".
CREATE INDEX idx_entity_revisions_card ON entity_revisions (entity_id, revision DESC);
CREATE INDEX idx_entity_revisions_project ON entity_revisions (project_id, created_at DESC);
