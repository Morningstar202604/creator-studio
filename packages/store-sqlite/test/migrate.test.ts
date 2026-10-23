import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '../src/index.js';

function fresh(): Database.Database {
  return new Database(':memory:');
}

describe('R1 migrations are idempotent', () => {
  it('applies all migrations on an empty database', () => {
    const db = fresh();
    const result = migrate(db);
    expect(result.applied.length).toBeGreaterThan(0);
    expect(result.alreadyApplied).toBe(0);
    db.close();
  });

  it('applies nothing on the second run', () => {
    const db = fresh();
    migrate(db);
    const first = db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number };
    const second = migrate(db);
    const after = db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number };
    expect(second.applied).toEqual([]);
    expect(after.c).toBe(first.c);
    db.close();
  });

  it('records version and name for each migration', () => {
    const db = fresh();
    const files = loadMigrations();
    migrate(db);
    const rows = db
      .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number; name: string }>;
    expect(rows.map((row) => row.version)).toEqual(files.map((file) => file.version));
    expect(rows.map((row) => row.name)).toEqual(files.map((file) => file.name));
    db.close();
  });

  it('rejects duplicate migration versions', () => {
    expect(() => {
      loadMigrations(fileURLToPath(new URL('./fixtures/dup', import.meta.url)));
    }).toThrowError(/DUPLICATE_MIGRATION_VERSION/);
  });

  it('creates all expected tables', () => {
    const db = fresh();
    migrate(db);
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    ).map((row) => row.name);
    for (const table of [
      'projects',
      'runs',
      'steps',
      'artifacts',
      'approvals',
      'devices',
      'tool_grants',
      'model_profiles',
      'memory_records',
      'run_events',
      'schema_migrations',
    ]) {
      expect(names).toContain(table);
    }
    db.close();
  });
});
