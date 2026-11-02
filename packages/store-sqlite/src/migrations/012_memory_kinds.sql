-- 012: memory index accepts the scenario-era content kinds.
--
-- 007 pinned `kind` to the video artifact list, so a novel outline or chapter was
-- silently dropped from the index (the insert threw inside a best-effort catch).
-- SQLite cannot alter a CHECK in place, so the table is rebuilt; the FTS index is
-- contentless-linked and must be rebuilt after the copy.
CREATE TABLE memory_chunks_new (
  id          TEXT PRIMARY KEY,
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
  scope       TEXT NOT NULL CHECK (scope IN ('user','project')),
  kind        TEXT NOT NULL CHECK (kind IN ('topic-card','research-notes','script','shot-list','publish-pack','review-report','outline','chapter','fact','decision','preference','style')),
  content     TEXT NOT NULL,
  source_ref  TEXT,
  source_hash TEXT NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  model       TEXT NOT NULL,
  dim         INTEGER NOT NULL CHECK (dim > 0),
  embedding   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (source_ref, chunk_index)
);
INSERT INTO memory_chunks_new (id, project_id, scope, kind, content, source_ref, source_hash,
                               chunk_index, model, dim, embedding, created_at)
SELECT id, project_id, scope, kind, content, source_ref, source_hash,
       chunk_index, model, dim, embedding, created_at
FROM memory_chunks;
DROP TABLE memory_chunks;
ALTER TABLE memory_chunks_new RENAME TO memory_chunks;
CREATE INDEX idx_memory_chunks_project ON memory_chunks (project_id, kind);
CREATE INDEX idx_memory_chunks_hash ON memory_chunks (source_hash);
INSERT INTO memory_chunks_fts(memory_chunks_fts) VALUES ('rebuild');

-- Dropping a table also drops the triggers attached to it, so the three FTS sync
-- triggers from 007 must be recreated here or new rows never reach the index.
CREATE TRIGGER memory_chunks_ai AFTER INSERT ON memory_chunks BEGIN
  INSERT INTO memory_chunks_fts (rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER memory_chunks_ad AFTER DELETE ON memory_chunks BEGIN
  INSERT INTO memory_chunks_fts (memory_chunks_fts, rowid, content)
  VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER memory_chunks_au AFTER UPDATE ON memory_chunks BEGIN
  INSERT INTO memory_chunks_fts (memory_chunks_fts, rowid, content)
  VALUES ('delete', old.rowid, old.content);
  INSERT INTO memory_chunks_fts (rowid, content) VALUES (new.rowid, new.content);
END;
