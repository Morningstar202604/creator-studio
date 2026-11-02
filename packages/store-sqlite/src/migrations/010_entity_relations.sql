-- 010: card relations. One row per directed edge; the reverse direction is derived
-- on read so a link never has to be stored twice (and can never disagree with itself).
CREATE TABLE entity_relations (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_card_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_card_id    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  /** Free-form label such as 出现在 / 隶属于 / 回收于. */
  label         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  UNIQUE (from_card_id, to_card_id, label),
  CHECK (from_card_id <> to_card_id)
);
CREATE INDEX idx_entity_relations_from ON entity_relations (project_id, from_card_id);
CREATE INDEX idx_entity_relations_to ON entity_relations (project_id, to_card_id);
