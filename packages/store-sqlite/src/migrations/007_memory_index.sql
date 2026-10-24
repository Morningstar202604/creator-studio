-- 007: local memory index — chunked, hash-addressed, FTS5 + embedding columns.
-- Existing memory_records stays as the authoring surface; this table is derived,
-- so it can be rebuilt at any time without losing user-authored memories.
CREATE TABLE memory_chunks (
  id          TEXT PRIMARY KEY,
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
  scope       TEXT NOT NULL CHECK (scope IN ('user','project')),
  kind        TEXT NOT NULL CHECK (kind IN ('topic-card','research-notes','script','shot-list','publish-pack','review-report','fact','decision','preference','style')),
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
CREATE INDEX idx_memory_chunks_project ON memory_chunks (project_id, kind);
CREATE INDEX idx_memory_chunks_hash ON memory_chunks (source_hash);

-- Trigram tokenizer handles Chinese substring queries; unicode61 would treat a
-- whole CJK run as one token and match nothing.
CREATE VIRTUAL TABLE memory_chunks_fts USING fts5(
  content,
  content='memory_chunks',
  content_rowid='rowid',
  tokenize='trigram'
);

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
