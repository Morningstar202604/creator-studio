import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, SqliteArtifactStore, ArtifactCorruptError } from '../src/index.js';

let workspace: string;
let db: ReturnType<typeof openDatabase>;
let store: SqliteArtifactStore;
let sequence = 0;

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'artifact-ws-'));
  db = openDatabase({ path: join(workspace, 'db.sqlite') });
});

afterAll(() => {
  db.close();
  rmSync(workspace, { recursive: true, force: true });
});

beforeEach(() => {
  const projectId = `project-${++sequence}`;
  db.prepare(
    `INSERT INTO projects (id, owner_id, title, platform, stage, created_at, updated_at)
     VALUES (?, 'u1', 'T', 'bilibili', 'script', '2026-10-21T10:00:00.000Z', '2026-10-21T10:00:00.000Z')`,
  ).run(projectId);
  db.prepare(
    `INSERT INTO runs (id, project_id, agent_id, execution_mode, status, model_profile_id,
       max_tokens, max_cost_cny, created_at)
     VALUES (?, ?, 'scriptwriter', 'local', 'succeeded', 'm1', 1000, 5, '2026-10-21T10:00:00.000Z')`,
  ).run(`run-${sequence}`, projectId);
  store = new SqliteArtifactStore(db, workspace);
});

describe('R1 versions are append-only', () => {
  it('keeps every saved version and never mutates the first', () => {
    const projectId = `project-${sequence}`;
    const runId = `run-${sequence}`;

    const v1 = store.save({
      id: 'a1',
      projectId,
      runId,
      kind: 'script',
      path: 'script/script.v1.md',
      content: '第一版',
      mime: 'text/markdown',
    });
    const v2 = store.save({
      id: 'a2',
      projectId,
      runId,
      kind: 'script',
      path: 'script/script.v2.md',
      content: '第二版',
      mime: 'text/markdown',
    });

    expect(v1.id).not.toBe(v2.id);
    const readBack = store.read('a1');
    expect(readBack?.content).toBe('第一版');
    expect(store.list(projectId)).toHaveLength(2);
    expect(readFileSync(join(workspace, 'script/script.v1.md'), 'utf8')).toBe('第一版');
  });

  it('computes the next version number from existing paths', () => {
    const projectId = `project-${sequence}`;
    const runId = `run-${sequence}`;
    expect(store.nextVersion(projectId, 'script', 'script')).toBe(1);
    store.save({ id: 'b1', projectId, runId, kind: 'script', path: 'script/script.v1.md', content: 'a', mime: 'text/markdown' });
    expect(store.nextVersion(projectId, 'script', 'script')).toBe(2);
    store.save({ id: 'b2', projectId, runId, kind: 'script', path: 'script/script.v2.md', content: 'b', mime: 'text/markdown' });
    expect(store.nextVersion(projectId, 'script', 'script')).toBe(3);
  });

  it('returns the latest version of a kind', () => {
    const projectId = `project-${sequence}`;
    const runId = `run-${sequence}`;
    store.save({ id: 'c1', projectId, runId, kind: 'script', path: 'script/script.v1.md', content: 'old', mime: 'text/markdown' });
    store.save({ id: 'c2', projectId, runId, kind: 'script', path: 'script/script.v2.md', content: 'new', mime: 'text/markdown' });
    expect(store.latest(projectId, 'script')?.content).toBe('new');
  });
});

describe('R1b manual saves without a run', () => {
  it('accepts a null runId for editor-authored artifacts', () => {
    const projectId = `project-${sequence}`;
    const artifact = store.save({
      id: 'manual-1',
      projectId,
      runId: null,
      kind: 'script',
      path: 'script/manual.v1.md',
      content: '手写稿',
      mime: 'text/markdown',
    });
    expect(artifact.runId).toBeNull();
    expect(store.read('manual-1')?.content).toBe('手写稿');
  });
});

describe('R2 sha256 matches disk', () => {
  it('stores a hash equal to the bytes on disk', () => {
    const projectId = `project-${sequence}`;
    const runId = `run-${sequence}`;
    const artifact = store.save({
      id: 'd1',
      projectId,
      runId,
      kind: 'script',
      path: 'script/hash.md',
      content: '中文内容 with ascii',
      mime: 'text/markdown',
    });
    const onDisk = readFileSync(join(workspace, artifact.path), 'utf8');
    expect(artifact.sha256).toHaveLength(64);
    expect(artifact.size).toBe(Buffer.byteLength(onDisk, 'utf8'));
    const reread = store.read(artifact.id);
    expect(reread?.artifact.sha256).toBe(artifact.sha256);
  });

  it('detects corruption when the file changes on disk', () => {
    const projectId = `project-${sequence}`;
    const runId = `run-${sequence}`;
    const artifact = store.save({
      id: 'e1',
      projectId,
      runId,
      kind: 'script',
      path: 'script/corrupt.md',
      content: 'original',
      mime: 'text/markdown',
    });
    writeFileSync(join(workspace, artifact.path), 'tampered', 'utf8');
    expect(() => store.read(artifact.id)).toThrowError(ArtifactCorruptError);
  });
});

describe('R5 path confinement', () => {
  it('rejects traversal in the artifact path', () => {
    const projectId = `project-${sequence}`;
    const runId = `run-${sequence}`;
    expect(() =>
      store.save({
        id: 'f1',
        projectId,
        runId,
        kind: 'script',
        path: '../../etc/passwd',
        content: 'x',
        mime: 'text/markdown',
      }),
    ).toThrowError(/PATH_ESCAPE/);
  });

  it('rejects an absolute path', () => {
    const projectId = `project-${sequence}`;
    const runId = `run-${sequence}`;
    const absolute = process.platform === 'win32' ? 'C:/Windows/win.ini' : '/etc/passwd';
    expect(() =>
      store.save({
        id: 'f2',
        projectId,
        runId,
        kind: 'script',
        path: absolute,
        content: 'x',
        mime: 'text/markdown',
      }),
    ).toThrowError(/PATH_ESCAPE/);
  });
});
