import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ModelGateway } from '@creator-studio/model-gateway';
import { SqliteRunStore } from '@creator-studio/store-sqlite';
import { createDaemon, type Daemon } from '../src/server.js';

let workspace: string;
let daemon: Daemon;
let baseUrl: string;
let projectId: string;

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'usage-ws-'));
  const gateway = new ModelGateway({
    profiles: [
      {
        id: 'm1',
        userId: 'local-user',
        name: 'stub',
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1/v1',
        model: 'stub',
        apiKeyRef: 'k',
        contextWindow: 8000,
        priceInPerM: 0,
        priceOutPerM: 0,
        isLocal: true,
      },
    ],
    resolveKey: async () => 'k',
    maxRetries: 0,
    sleep: async () => {},
  });

  daemon = await createDaemon({
    dbPath: join(workspace, 'db.sqlite'),
    workspaceRoot: join(workspace, 'project'),
    deviceId: 'd1',
    modelGateway: gateway,
  });
  await daemon.app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(daemon.app.server.address() as AddressInfo).port}`;

  const created = await fetch(`${baseUrl}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '统计' }),
  });
  projectId = ((await created.json()) as { project: { id: string } }).project.id;

  const store = new SqliteRunStore(daemon.db);
  const started = new Date(Date.now() - 5000).toISOString();
  store.createRun({
    id: 'run-a',
    projectId,
    parentRunId: null,
    agentId: 'scriptwriter',
    executionMode: 'local',
    status: 'succeeded',
    modelProfileId: 'm1',
    budget: { maxTokens: 2000, maxCostCny: 5, usedTokens: 1200, usedCostCny: 0.42 },
    inputRef: null,
    outputRef: null,
    error: null,
    startedAt: started,
    endedAt: new Date().toISOString(),
    createdAt: started,
  });
  store.createRun({
    id: 'run-b',
    projectId,
    parentRunId: null,
    agentId: 'critic',
    executionMode: 'local',
    status: 'failed',
    modelProfileId: 'm1',
    budget: { maxTokens: 1000, maxCostCny: 5, usedTokens: 100, usedCostCny: 0.02 },
    inputRef: null,
    outputRef: null,
    error: { code: 'MODEL_AUTH', message: 'no key', retryable: false },
    startedAt: started,
    endedAt: new Date().toISOString(),
    createdAt: started,
  });
});

afterAll(async () => {
  await daemon.close();
  rmSync(workspace, { recursive: true, force: true });
});

describe('usage reporting', () => {
  it('aggregates totals across runs', async () => {
    const response = await fetch(`${baseUrl}/v1/usage`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      totals: { runs: number; tokens: number; cost: number };
      byAgent: Array<{ agentId: string; status: string; runs: number; tokens: number; costCny: number }>;
    };
    expect(body.totals.runs).toBe(2);
    expect(body.totals.tokens).toBe(1300);
    expect(body.totals.cost).toBeCloseTo(0.44, 5);
  });

  it('groups by agent and status', async () => {
    const response = await fetch(`${baseUrl}/v1/usage`);
    const body = (await response.json()) as {
      byAgent: Array<{ agentId: string; status: string; costCny: number; avgSeconds: number | null }>;
    };
    const script = body.byAgent.find((row) => row.agentId === 'scriptwriter');
    expect(script?.status).toBe('succeeded');
    expect(script?.costCny).toBeCloseTo(0.42, 4);
    expect(script?.avgSeconds).toBeGreaterThan(0);

    const critic = body.byAgent.find((row) => row.agentId === 'critic');
    expect(critic?.status).toBe('failed');
  });

  it('exposes counters on health', async () => {
    const response = await fetch(`${baseUrl}/health`);
    const body = (await response.json()) as {
      stats: { projects: number; runs: number; artifacts: number; events: number };
      uptimeMs: number;
    };
    expect(body.stats.projects).toBe(1);
    expect(body.stats.runs).toBe(2);
    expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
  });
});
