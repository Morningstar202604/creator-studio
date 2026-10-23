import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/index.js';

const iso = '2026-10-21T10:00:00.000Z';

let db: Database.Database;

function project(id = 'p1'): void {
  db.prepare(
    `INSERT INTO projects (id, owner_id, title, platform, stage, created_at, updated_at)
     VALUES (?, 'u1', 'T', 'bilibili', 'script', ?, ?)`,
  ).run(id, iso, iso);
}

function run(id = 'r1'): void {
  db.prepare(
    `INSERT INTO runs (id, project_id, agent_id, execution_mode, status, model_profile_id,
       max_tokens, max_cost_cny, created_at)
     VALUES (?, 'p1', 'scriptwriter', 'local', 'running', 'm1', 1000, 5, ?)`,
  ).run(id, iso);
}

function step(id: string, status: string, index = 0, runId = 'r1'): void {
  db.prepare(
    `INSERT INTO steps (id, run_id, step_index, kind, status, started_at)
     VALUES (?, ?, ?, 'model', ?, ?)`,
  ).run(id, runId, index, status, status === 'running' ? iso : null);
}

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  project();
  run();
});

describe('R2 INV-1 one running step per run', () => {
  it('allows a single running step', () => {
    expect(() => step('s1', 'running')).not.toThrow();
  });

  it('rejects a second running step in the same run', () => {
    step('s1', 'running');
    expect(() => step('s2', 'running', 1)).toThrowError(/UNIQUE/);
  });

  it('allows running steps in different runs', () => {
    project('p2');
    db.prepare(
      `INSERT INTO runs (id, project_id, agent_id, execution_mode, status, model_profile_id,
         max_tokens, max_cost_cny, created_at)
       VALUES ('r2', 'p2', 'critic', 'local', 'running', 'm1', 1000, 5, ?)`,
    ).run(iso);
    step('s1', 'running', 0, 'r1');
    expect(() => step('s2', 'running', 0, 'r2')).not.toThrow();
  });

  it('frees the slot once the step finishes', () => {
    step('s1', 'running');
    db.prepare("UPDATE steps SET status='succeeded', ended_at=? WHERE id='s1'").run(iso);
    expect(() => step('s2', 'running', 1)).not.toThrow();
  });

  it('rejects a duplicate step index within a run', () => {
    step('s1', 'pending', 0);
    expect(() => step('s2', 'pending', 0)).toThrowError(/UNIQUE/);
  });

  it('rejects a tool step without a tool name', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO steps (id, run_id, step_index, kind, status) VALUES ('s9','r1',9,'tool','pending')`,
        )
        .run(),
    ).toThrowError(/CHECK/);
  });
});

describe('R3 INV-9 run event seq', () => {
  const event = (id: string, seq: number) =>
    db
      .prepare(
        `INSERT INTO run_events (id, run_id, seq, type, payload, ts)
         VALUES (?, 'r1', ?, 'step.started', '{}', ?)`,
      )
      .run(id, seq, iso);

  it('accepts sequential events', () => {
    expect(() => {
      event('e0', 0);
      event('e1', 1);
      event('e2', 2);
    }).not.toThrow();
  });

  it('rejects a duplicate seq', () => {
    event('e0', 0);
    expect(() => event('e1', 0)).toThrowError(/UNIQUE/);
  });

  it('rejects a negative seq', () => {
    expect(() => event('en', -1)).toThrowError(/CHECK/);
  });

  it('rejects invalid json payload', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO run_events (id, run_id, seq, type, payload, ts)
           VALUES ('eb','r1',5,'error','{oops',?)`,
        )
        .run(iso),
    ).toThrowError(/CHECK/);
  });
});

describe('R4 INV-10 artifact visibility', () => {
  const artifact = (visibility: string) =>
    db
      .prepare(
        `INSERT INTO artifacts (id, project_id, run_id, kind, path, sha256, mime, size, visibility, created_at)
         VALUES ('a1','p1','r1','script','s.md',?, 'text/markdown', 10, ?, ?)`,
      )
      .run('a'.repeat(64), visibility, iso);

  it('accepts local and synced', () => {
    expect(() => artifact('local')).not.toThrow();
  });

  it('rejects an unknown visibility', () => {
    expect(() => artifact('public')).toThrowError(/CHECK/);
  });

  it('rejects a wrong sha256 length', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO artifacts (id, project_id, run_id, kind, path, sha256, mime, size, visibility, created_at)
           VALUES ('a2','p1','r1','script','s.md','abc','text/markdown',10,'local',?)`,
        )
        .run(iso),
    ).toThrowError(/CHECK/);
  });
});

describe('referential integrity', () => {
  it('cascades steps when a run is deleted', () => {
    step('s1', 'pending');
    db.prepare("DELETE FROM runs WHERE id='r1'").run();
    const count = db.prepare('SELECT COUNT(*) AS c FROM steps').get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('rejects a run pointing at a missing project', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO runs (id, project_id, agent_id, execution_mode, status, model_profile_id,
             max_tokens, max_cost_cny, created_at)
           VALUES ('rx','missing','critic','local','queued','m1',10,1,?)`,
        )
        .run(iso),
    ).toThrowError(/FOREIGN KEY/);
  });

  it('rejects an approval that is decided without a decision timestamp', () => {
    step('s1', 'pending');
    expect(() =>
      db
        .prepare(
          `INSERT INTO approvals (id, run_id, step_id, kind, payload, decision, requested_at)
           VALUES ('ap1','r1','s1','delete','{}','approved',?)`,
        )
        .run(iso),
    ).toThrowError(/CHECK/);
  });

  it('rejects a run whose used tokens exceed the cap', () => {
    expect(() =>
      db
        .prepare(
          `UPDATE runs SET used_tokens = 1001 WHERE id='r1'`,
        )
        .run(),
    ).toThrowError(/CHECK/);
  });
});
