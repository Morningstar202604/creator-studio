import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from 'better-sqlite3';

export type MigrationFile = {
  version: number;
  name: string;
  sql: string;
  sha256: string;
};

export type MigrateResult = {
  applied: MigrationFile[];
  alreadyApplied: number;
};

const MIGRATION_PATTERN = /^(\d{3})_([a-z0-9_]+)\.sql$/;

export function migrationsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'migrations');
}

export function loadMigrations(dir = migrationsDir()): MigrationFile[] {
  const files = readdirSync(dir).filter((name) => MIGRATION_PATTERN.test(name)).sort();
  const seen = new Set<number>();
  const migrations: MigrationFile[] = [];
  for (const file of files) {
    const match = MIGRATION_PATTERN.exec(file);
    if (match === null) continue;
    const version = Number.parseInt(match[1] as string, 10);
    if (seen.has(version)) {
      throw new Error(`DUPLICATE_MIGRATION_VERSION: ${version}`);
    }
    seen.add(version);
    const sql = readFileSync(join(dir, file), 'utf8');
    migrations.push({
      version,
      name: match[2] as string,
      sql,
      sha256: createHash('sha256').update(sql).digest('hex'),
    });
  }
  return migrations.sort((a, b) => a.version - b.version);
}

export function migrate(db: Database, dir = migrationsDir()): MigrateResult {
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{
    version: number;
  }>;
  const appliedVersions = new Set(appliedRows.map((row) => row.version));

  const migrations = loadMigrations(dir);
  const pending = migrations.filter((migration) => !appliedVersions.has(migration.version));

  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );

  const applied: MigrationFile[] = [];
  for (const migration of pending) {
    const run = db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, new Date().toISOString());
    });
    run();
    applied.push(migration);
  }

  return { applied, alreadyApplied: appliedVersions.size };
}
