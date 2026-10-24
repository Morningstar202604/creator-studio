import Database from 'better-sqlite3';
import { migrate } from './migrate.js';

export * from './migrate.js';
export * from './run-store.js';
export * from './project-store.js';
export * from './artifact-store.js';
export * from './settings-store.js';
export * from './automation-store.js';
export * from './metrics-store.js';
export { Database };

export type OpenOptions = {
  path: string;
  readonly?: boolean;
};

export function openDatabase({ path, readonly = false }: OpenOptions): Database.Database {
  const db = new Database(path, { readonly });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (!readonly) migrate(db);
  return db;
}
