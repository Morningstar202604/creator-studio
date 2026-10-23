import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ModelGateway } from '@creator-studio/model-gateway';
import { openDatabase, SqliteRunStore } from '@creator-studio/store-sqlite';
import { createDaemon, type Daemon } from '../src/server.js';

let workspace: string;
let dbPath: string;

const profile = {
  id: 'm1',
  userId: 'local-user',
  name: 'stub',
  provider: 'openai-compatible' as const,
  baseUrl: 'http://127.0.0.1:1/v1',
  model: 'stub',
  apiKeyRef: 'k',
  contextWindow: 8000,
  priceInPerM: 0,
  priceOutPerM: 0,
  isLocal: true,
};

function gateway(): ModelGateway {
  return new ModelGateway({
    profiles: [profile],
    resolveKey: async () => 'sk-stub',
    maxRetries: 0,
    sleep: async () => {},
  });
}

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'recovery-ws-'));
  dbPath = join(workspace, 'db.sqlite');
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('crash recovery', () => {
  it('marks runs left in running/queued as INTERRUPTED on the next boot', async () => {
    // First boot: create a project and a run, then abandon it mid-flight.
    const first: Daemon = await createDaemon({
      dbPath,
      workspaceRoot: join(workspace, 'project'),
      deviceId: 'd1',
      modelGateway: gateway(),
    });
    await first.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (first.app.server.address() as AddressInfo).port;

    const created = await fetch(`http://127.0.0.1:${port}/v1/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '崩溃恢复' }),
    });
    const projectId = ((await created.json()) as { project: { id: string } }).project.id;

    const store = new SqliteRunStore(first.db);
    store.createRun({
      id: 'run-stuck',
      projectId,
      parentRunId: null,
      agentId: 'scriptwriter',
      executionMode: 'local',
      status: 'running',
      modelProfileId: 'm1',
      budget: { maxTokens: 1000, maxCostCny: 5, usedTokens: 10, usedCostCny: 0 },
      inputRef: null,
      outputRef: null,
      error: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      createdAt: new Date().toISOString(),
    });

    await first.close();

    // Second boot against the same database: the sweep must repair the stale row.
    const second: Daemon = await createDaemon({
      dbPath,
      workspaceRoot: join(workspace, 'project'),
      deviceId: 'd1',
      modelGateway: gateway(),
    });

    const repaired = new SqliteRunStore(second.db).getRun('run-stuck');
    expect(repaired?.status).toBe('failed');
    expect(repaired?.error?.code).toBe('INTERRUPTED');
    expect(repaired?.error?.retryable).toBe(true);
    expect(repaired?.endedAt).not.toBeNull();

    const events = new SqliteRunStore(second.db).listEvents('run-stuck');
    expect(events.some((event) => event.type === 'error')).toBe(true);

    await second.close();
  });

  it('leaves succeeded runs untouched', async () => {
    const db = openDatabase({ path: dbPath });
    db.prepare("UPDATE runs SET status = 'succeeded', error_code = NULL, error_message = NULL WHERE id = 'run-stuck'").run();
    db.close();

    const third: Daemon = await createDaemon({
      dbPath,
      workspaceRoot: join(workspace, 'project'),
      deviceId: 'd1',
      modelGateway: gateway(),
    });
    const run = new SqliteRunStore(third.db).getRun('run-stuck');
    expect(run?.status).toBe('succeeded');
    await third.close();
  });
});
