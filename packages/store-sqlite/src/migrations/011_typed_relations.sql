-- 011: typed relations. `label` stays as free text so v0.8 links keep working;
-- `relation_type` records which declared type a link used, and the inverse label is
-- derived on read from the pack rather than stored twice.
ALTER TABLE entity_relations ADD COLUMN relation_type TEXT;
CREATE INDEX idx_entity_relations_type ON entity_relations (project_id, relation_type);
