import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ModelGateway } from '@creator-studio/model-gateway';
import { createDaemon, type Daemon } from '../src/server.js';

let workspace: string;
let daemon: Daemon;
let baseUrl: string;

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }), ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : JSON.parse(text) };
}

async function novelProject(title: string): Promise<string> {
  const created = await api('/v1/projects', { method: 'POST', body: JSON.stringify({ title, scenarioId: 'novel' }) });
  return created.body.project.id as string;
}

async function card(projectId: string, type: string, title: string, fields: Record<string, string>): Promise<string> {
  const created = await api(`/v1/projects/${projectId}/entities`, {
    method: 'POST',
    body: JSON.stringify({ type, title, fields }),
  });
  return created.body.card.id as string;
}

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'relations-'));
  const unreachable = createServer();
  await new Promise<void>((resolve) => unreachable.listen(0, '127.0.0.1', resolve));
  const port = (unreachable.address() as AddressInfo).port;
  await new Promise<void>((resolve) => unreachable.close(() => resolve()));

  const gateway = new ModelGateway({
    profiles: [
      {
        id: 'm1',
        userId: 'u',
        name: 'stub',
        provider: 'openai-compatible',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'stub',
        apiKeyRef: 'k',
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
    deviceId: 'd1',
    modelGateway: gateway,
    scheduler: false,
  });
  await daemon.app.listen({ port: 0, host: '127.0.0.1' });
  const address = daemon.app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await daemon.close();
  rmSync(workspace, { recursive: true, force: true });
});

describe('R1 links are one-way edges with a derived backlink', () => {
  it('shows the link on the source and the backlink on the target', async () => {
    const pid = await novelProject('关联');
    const character = await card(pid, 'character', '林砚', { name: '林砚', role: '主角', goal: '查真相' });
    const chapter = await card(pid, 'chapter', '第一章', { title: '第一章' });

    const linked = await api(`/v1/projects/${pid}/entities/${character}/links`, {
      method: 'POST',
      body: JSON.stringify({ toCardId: chapter, label: '出现在' }),
    });
    expect(linked.status).toBe(201);

    const source = await api(`/v1/projects/${pid}/entities/${character}/links`);
    expect(source.body.card.links).toHaveLength(1);
    expect(source.body.card.links[0].direction).toBe('out');
    expect(source.body.card.links[0].relation.label).toBe('出现在');

    const target = await api(`/v1/projects/${pid}/entities/${chapter}/links`);
    expect(target.body.card.links).toHaveLength(1);
    expect(target.body.card.links[0].direction).toBe('in');
    expect(target.body.card.links[0].card.title).toBe('林砚');
  });

  it('refuses a self link', async () => {
    const pid = await novelProject('自指');
    const character = await card(pid, 'character', '林砚', { name: '林砚', role: '主角', goal: 'x' });
    const result = await api(`/v1/projects/${pid}/entities/${character}/links`, {
      method: 'POST',
      body: JSON.stringify({ toCardId: character }),
    });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('SELF_LINK');
  });

  it('refuses a card from another project as the target', async () => {
    const mine = await novelProject('我的');
    const other = await novelProject('别的');
    const character = await card(mine, 'character', '林砚', { name: '林砚', role: '主角', goal: 'x' });
    const foreign = await card(other, 'chapter', '别人的第一章', { title: '别人的第一章' });
    const result = await api(`/v1/projects/${mine}/entities/${character}/links`, {
      method: 'POST',
      body: JSON.stringify({ toCardId: foreign }),
    });
    expect(result.status).toBe(404);
  });

  it('unlinks and 404s an unknown relation', async () => {
    const pid = await novelProject('解除');
    const a = await card(pid, 'character', 'A', { name: 'A', role: '主角', goal: 'x' });
    const b = await card(pid, 'chapter', 'B', { title: 'B' });
    const linked = await api(`/v1/projects/${pid}/entities/${a}/links`, {
      method: 'POST',
      body: JSON.stringify({ toCardId: b }),
    });
    const relationId = linked.body.relation.id as string;
    expect((await api(`/v1/projects/${pid}/links/${relationId}`, { method: 'DELETE' })).status).toBe(200);
    expect((await api(`/v1/projects/${pid}/links/${relationId}`, { method: 'DELETE' })).status).toBe(404);
    const after = await api(`/v1/projects/${pid}/entities/${a}/links`);
    expect(after.body.card.links).toHaveLength(0);
  });

  it('drops links when the target card is deleted', async () => {
    const pid = await novelProject('级联');
    const a = await card(pid, 'character', 'A', { name: 'A', role: '主角', goal: 'x' });
    const b = await card(pid, 'chapter', 'B', { title: 'B' });
    await api(`/v1/projects/${pid}/entities/${a}/links`, {
      method: 'POST',
      body: JSON.stringify({ toCardId: b, label: '出现在' }),
    });
    await api(`/v1/projects/${pid}/entities/${b}`, { method: 'DELETE' });
    const after = await api(`/v1/projects/${pid}/entities/${a}/links`);
    expect(after.body.card.links).toHaveLength(0);
  });
});
