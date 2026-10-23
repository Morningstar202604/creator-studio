import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ModelGateway } from '@creator-studio/model-gateway';
import { createDaemon, type Daemon } from '../src/server.js';

let workspace: string;
let daemon: Daemon;
let baseUrl: string;

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'settings-ws-'));
  const gateway = new ModelGateway({
    profiles: [
      {
        id: 'runtime-model',
        userId: 'local-user',
        name: 'runtime',
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1/v1',
        model: 'stub',
        apiKeyRef: 'env:MODEL_API_KEY',
        contextWindow: 8000,
        priceInPerM: 0,
        priceOutPerM: 0,
        isLocal: true,
      },
    ],
    resolveKey: async () => 'sk-stub',
    maxRetries: 0,
    sleep: async () => {},
  });

  daemon = await createDaemon({
    dbPath: join(workspace, 'db.sqlite'),
    workspaceRoot: join(workspace, 'project'),
    deviceId: 'dev-1',
    modelGateway: gateway,
  });
  await daemon.app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(daemon.app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await daemon.close();
  rmSync(workspace, { recursive: true, force: true });
});

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  // Only declare a JSON content-type when a body is actually sent; Fastify rejects
  // an empty body with content-type: application/json.
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : JSON.parse(text) };
}

describe('onboarding', () => {
  it('reports not completed on a fresh database', async () => {
    const { body } = await api('/v1/onboarding');
    expect(body.completed).toBe(false);
    expect(body.modelConfigured).toBe(true); // runtime profile present
    expect(body.tools).toBeGreaterThan(0);
  });

  it('records completion', async () => {
    const done = await api('/v1/onboarding/complete', { method: 'POST' });
    expect(done.body.completed).toBe(true);
    const again = await api('/v1/onboarding');
    expect(again.body.completed).toBe(true);
  });
});

describe('models', () => {
  it('falls back to the runtime profile before any model is stored', async () => {
    const { body } = await api('/v1/settings/models');
    expect(body.source).toBe('runtime');
    expect(body.models[0].id).toBe('runtime-model');
  });

  it('stores a model and switches the source to stored', async () => {
    const created = await api('/v1/settings/models', {
      method: 'POST',
      body: JSON.stringify({
        name: '我的 OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        contextWindow: 128000,
        priceInPerM: 1,
        priceOutPerM: 2,
      }),
    });
    expect(created.status).toBe(201);
    expect(created.body.model.name).toBe('我的 OpenAI');

    const listed = await api('/v1/settings/models');
    expect(listed.body.source).toBe('stored');
    expect(listed.body.models[0].name).toBe('我的 OpenAI');
  });

  it('rejects a model without a base url', async () => {
    const { status } = await api('/v1/settings/models', {
      method: 'POST',
      body: JSON.stringify({ name: 'x', model: 'y' }),
    });
    expect(status).toBe(400);
  });

  it('rejects a base url with embedded credentials', async () => {
    const { status } = await api('/v1/settings/models', {
      method: 'POST',
      body: JSON.stringify({ name: 'x', baseUrl: 'https://sk-live-abc@example.com/v1', model: 'y' }),
    });
    expect(status).toBe(400);
  });
});

describe('tool grants', () => {
  it('defaults every tool to deny when no grant exists', async () => {
    const { body } = await api('/v1/settings/grants');
    expect(body.deviceId).toBe('dev-1');
    for (const tool of body.tools) {
      expect(tool.mode).toBe('deny');
    }
  });

  it('persists a mode change', async () => {
    await api('/v1/settings/grants', {
      method: 'POST',
      body: JSON.stringify({ tool: 'fs.read', mode: 'auto' }),
    });
    const { body } = await api('/v1/settings/grants');
    const read = body.tools.find((tool: { name: string }) => tool.name === 'fs.read');
    expect(read.mode).toBe('auto');
  });

  it('rejects an unknown mode', async () => {
    const { status } = await api('/v1/settings/grants', {
      method: 'POST',
      body: JSON.stringify({ tool: 'fs.read', mode: 'allow' }),
    });
    expect(status).toBe(400);
  });
});

describe('budget', () => {
  it('returns defaults initially', async () => {
    const { body } = await api('/v1/settings/budget');
    expect(body.budget.monthlyCostCny).toBe(50);
    expect(body.budget.warnAtPercent).toBe(80);
  });

  it('persists a new budget', async () => {
    const updated = await api('/v1/settings/budget', {
      method: 'POST',
      body: JSON.stringify({ monthlyCostCny: 120, perProjectCostCny: 8, warnAtPercent: 70 }),
    });
    expect(updated.body.budget.monthlyCostCny).toBe(120);
    const read = await api('/v1/settings/budget');
    expect(read.body.budget.warnAtPercent).toBe(70);
  });

  it('rejects an out-of-range percentage', async () => {
    const { status } = await api('/v1/settings/budget', {
      method: 'POST',
      body: JSON.stringify({ warnAtPercent: 140 }),
    });
    expect(status).toBe(400);
  });
});
