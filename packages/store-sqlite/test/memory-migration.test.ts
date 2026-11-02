import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMigrations, migrate, migrationsDir } from '../src/index.js';

/**
 * 012 rebuilds `memory_chunks` to widen the kind CHECK. A rebuild is the one kind of
 * migration that can silently lose data or break derived structures, so these cases
 * pin both: rows survive, and the FTS triggers still fire afterwards.
 */

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

/** Applies every migration except 012, then seeds one row the old schema accepts. */
function applyThrough011(): Database.Database {
  const db = freshDb();
  const before = loadMigrations().filter((migration) => migration.version < 12);
  db.exec(`CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
  )`);
  for (const migration of before) {
    db.exec(migration.sql);
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      migration.version,
      migration.name,
      '2026-10-27T00:00:00.000Z',
    );
  }
  db.prepare(
    `INSERT INTO projects (id, owner_id, title, platform, stage, created_at, updated_at)
     VALUES ('p1', 'u1', 'T', 'bilibili', 'script', '2026-10-27T00:00:00.000Z', '2026-10-27T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO memory_chunks (id, project_id, scope, kind, content, source_ref, source_hash,
       chunk_index, model, dim, embedding, created_at)
     VALUES ('c1', 'p1', 'project', 'script', '旧脚本内容', 'artifact:a1', 'h', 0, 'hash-ngram', 256, '[1]', '2026-10-27T00:00:00.000Z')`,
  ).run();
  return db;
}

describe('R1 012 keeps existing memory rows', () => {
  it('copies every row across the rebuild', () => {
    const db = applyThrough011();
    const applied = migrate(db);
    // 012 is the migration under test; later ones (013 onward) apply in the same
    // pass and are asserted by their own suites, so only the presence of 12 matters.
    expect(applied.applied.map((migration) => migration.version)).toContain(12);
    const row = db.prepare('SELECT content, kind FROM memory_chunks WHERE id = ?').get('c1') as
      | { content: string; kind: string }
      | undefined;
    expect(row?.content).toBe('旧脚本内容');
    expect(row?.kind).toBe('script');
    db.close();
  });

  it('keeps the copied row searchable through FTS after the rebuild', () => {
    const db = applyThrough011();
    migrate(db);
    const hits = db
      .prepare("SELECT rowid FROM memory_chunks_fts WHERE memory_chunks_fts MATCH ?")
      .all('旧脚本') as Array<{ rowid: number }>;
    expect(hits.length).toBe(1);
    db.close();
  });
});

describe('R2 012 accepts the scenario kinds and keeps the index in sync', () => {
  it('inserts an outline row and reaches FTS through the recreated trigger', () => {
    const db = freshDb();
    migrate(db);
    db.prepare(
      `INSERT INTO projects (id, owner_id, title, platform, stage, created_at, updated_at)
       VALUES ('p2', 'u1', 'T', 'generic', 'outline', '2026-10-27T00:00:00.000Z', '2026-10-27T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO memory_chunks (id, project_id, scope, kind, content, source_ref, source_hash,
         chunk_index, model, dim, embedding, created_at)
       VALUES ('c2', 'p2', 'project', 'outline', '三幕结构：第一幕建置', 'artifact:a2', 'h', 0, 'hash-ngram', 256, '[1]', '2026-10-27T00:00:00.000Z')`,
    ).run();
    const hits = db
      .prepare('SELECT rowid FROM memory_chunks_fts WHERE memory_chunks_fts MATCH ?')
      .all('三幕结构') as Array<{ rowid: number }>;
    expect(hits.length).toBe(1);

    // Deleting must remove the FTS entry too, otherwise stale text keeps matching.
    db.prepare('DELETE FROM memory_chunks WHERE id = ?').run('c2');
    const after = db
      .prepare('SELECT rowid FROM memory_chunks_fts WHERE memory_chunks_fts MATCH ?')
      .all('三幕结构') as Array<{ rowid: number }>;
    expect(after.length).toBe(0);
    db.close();
  });

  it('still rejects kinds that carry no quotable text', () => {
    const db = freshDb();
    migrate(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO memory_chunks (id, project_id, scope, kind, content, source_ref, source_hash,
             chunk_index, model, dim, embedding, created_at)
           VALUES ('c3', NULL, 'user', 'image', 'x', 'artifact:a3', 'h', 0, 'hash-ngram', 256, '[1]', '2026-10-27T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow();
    db.close();
  });
});

describe('R3 the shipped migration file is the one under test', () => {
  it('resolves migrations from the package directory', () => {
    const dir = migrationsDir();
    expect(readFileSync(join(dir, '012_memory_kinds.sql'), 'utf8')).toContain('memory_chunks_new');
  });
});
