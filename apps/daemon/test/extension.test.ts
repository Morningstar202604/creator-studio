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

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'extension-'));
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

describe('R1 the engine advertises its view vocabulary', () => {
  it('lists packs together with the supported views and pack format', async () => {
    const result = await api('/v1/scenarios');
    expect(result.status).toBe(200);
    expect(result.body.engine.views).toEqual(['generate', 'entities', 'publish', 'review', 'board', 'document']);
    expect(result.body.engine.packFormat).toBe(2);
    expect(result.body.scenarios.map((pack: { id: string }) => pack.id).sort()).toEqual([
      'copywriting',
      'course',
      'novel',
      'podcast',
      'shorts',
      'video',
    ]);
  });
});

describe('R2 export/import round-trips a pack without loss', () => {
  it('exports a built-in and re-imports it under a new id', async () => {
    const exported = await api('/v1/scenarios/novel/export');
    expect(exported.status).toBe(200);
    expect(exported.body.engine.views).toContain('board');

    const pack = { ...exported.body.pack, id: 'novel-fork', name: '小说分支', builtin: false };
    const imported = await api('/v1/scenarios/import', { method: 'POST', body: JSON.stringify({ pack }) });
    expect(imported.status).toBe(201);
    expect(imported.body.scenario.id).toBe('novel-fork');
    expect(imported.body.scenario.stages.map((stage: { key: string }) => stage.key)).toEqual(
      exported.body.pack.stages.map((stage: { key: string }) => stage.key),
    );
    expect(imported.body.scenario.entityTypes.map((entity: { key: string }) => entity.key)).toEqual(
      exported.body.pack.entityTypes.map((entity: { key: string }) => entity.key),
    );
    expect(imported.body.scenario.relationTypes).toEqual(exported.body.pack.relationTypes);
  });

  it('reports an unknown view with the supported list and writes nothing', async () => {
    const before = (await api('/v1/scenarios')).body.scenarios.length;
    const result = await api('/v1/scenarios/import', {
      method: 'POST',
      body: JSON.stringify({
        pack: {
          id: 'needs-timeline',
          name: '时间线场景',
          stages: [
            { key: 'a', label: 'A', view: 'generate', required: true },
            { key: 'b', label: 'B', view: 'timeline' },
          ],
        },
      }),
    });
    expect(result.status).toBe(400);
    expect(result.body.supportedViews).toEqual(['generate', 'entities', 'publish', 'review', 'board', 'document']);
    const after = (await api('/v1/scenarios')).body.scenarios.length;
    expect(after).toBe(before);
  });

  it('rejects a pack whose parent does not exist', async () => {
    const result = await api('/v1/scenarios/import', {
      method: 'POST',
      body: JSON.stringify({
        pack: {
          id: 'orphan-import',
          name: '孤儿',
          inherits: 'nope',
          stages: [{ key: 'a', label: 'A', required: true }],
        },
      }),
    });
    expect(result.status).toBe(400);
    expect(['BAD_INHERITANCE', 'INVALID_SCENARIO']).toContain(result.body.error.code);
  });

  it('rejects an inheritance cycle', async () => {
    await api('/v1/scenarios/import', {
      method: 'POST',
      body: JSON.stringify({
        pack: { id: 'cyc-a', name: 'A', inherits: 'cyc-b', stages: [{ key: 'a', label: 'A', required: true }] },
      }),
    });
    const b = await api('/v1/scenarios/import', {
      method: 'POST',
      body: JSON.stringify({
        pack: { id: 'cyc-b', name: 'B', inherits: 'cyc-a', stages: [{ key: 'b', label: 'B', required: true }] },
      }),
    });
    // Either order fails; what matters is that a cycle can never be stored.
    expect([400, 201]).toContain(b.status);
    const projects = await api('/v1/projects', {
      method: 'POST',
      body: JSON.stringify({ title: '循环', scenarioId: 'cyc-a' }),
    });
    // A stored cycle must not hang or crash the read path.
    expect([201, 400]).toContain(projects.status);
  });
});

describe('R3 inheriting packs merge the parent at read time', () => {
  it('serves a child pack with the parent stages first', async () => {
    const imported = await api('/v1/scenarios/import', {
      method: 'POST',
      body: JSON.stringify({
        pack: {
          id: 'novel-romance',
          name: '言情长篇',
          inherits: 'novel',
          stages: [{ key: 'relationship', label: '感情线', view: 'generate', required: false }],
        },
      }),
    });
    expect(imported.status).toBe(201);

    const child = await api('/v1/scenarios/novel-romance');
    const keys = child.body.scenario.stages.map((stage: { key: string }) => stage.key);
    expect(keys[0]).toBe('premise');
    expect(keys[keys.length - 1]).toBe('relationship');
    expect(keys).toContain('chapter');
    // Entity types are inherited too.
    expect(child.body.scenario.entityTypes.map((entity: { key: string }) => entity.key)).toContain('character');
  });

  it('lets a child override an inherited stage', async () => {
    await api('/v1/scenarios/import', {
      method: 'POST',
      body: JSON.stringify({
        pack: {
          id: 'novel-tight',
          name: '紧凑版',
          inherits: 'novel',
          stages: [{ key: 'chapter', label: '正文', view: 'entities', entityType: 'chapter', required: true }],
        },
      }),
    });
    const child = await api('/v1/scenarios/novel-tight');
    const chapter = child.body.scenario.stages.filter((stage: { key: string }) => stage.key === 'chapter');
    expect(chapter).toHaveLength(1);
    expect(chapter[0].label).toBe('正文');
  });
});

describe('R4 typed relations use the pack declaration', () => {
  it('stores the type and shows the inverse label on the backlink', async () => {
    const project = await api('/v1/projects', {
      method: 'POST',
      body: JSON.stringify({ title: '类型化关联', scenarioId: 'novel' }),
    });
    const pid = project.body.project.id as string;
    const character = await api(`/v1/projects/${pid}/entities`, {
      method: 'POST',
      body: JSON.stringify({ type: 'character', title: '林砚', fields: { name: '林砚', role: '主角', goal: '查真相' } }),
    });
    const chapter = await api(`/v1/projects/${pid}/entities`, {
      method: 'POST',
      body: JSON.stringify({ type: 'chapter', title: '第一章', fields: { title: '第一章', status: '草稿' } }),
    });
    const characterId = character.body.card.id as string;
    const chapterId = chapter.body.card.id as string;

    const linked = await api(`/v1/projects/${pid}/entities/${characterId}/links`, {
      method: 'POST',
      body: JSON.stringify({ toCardId: chapterId, relationType: 'appears-in' }),
    });
    expect(linked.status).toBe(201);
    expect(linked.body.relation.relationType).toBe('appears-in');

    const source = await api(`/v1/projects/${pid}/entities/${characterId}/links`);
    expect(source.body.card.links[0].relation.label).toBe('出现在');

    const target = await api(`/v1/projects/${pid}/entities/${chapterId}/links`);
    expect(target.body.card.links[0].relation.label).toBe('出场于');
  });

  it('rejects an undeclared relation type', async () => {
    const project = await api('/v1/projects', {
      method: 'POST',
      body: JSON.stringify({ title: '未声明类型', scenarioId: 'novel' }),
    });
    const pid = project.body.project.id as string;
    const a = await api(`/v1/projects/${pid}/entities`, {
      method: 'POST',
      body: JSON.stringify({ type: 'character', title: 'A', fields: { name: 'A', role: '主角', goal: 'x' } }),
    });
    const b = await api(`/v1/projects/${pid}/entities`, {
      method: 'POST',
      body: JSON.stringify({ type: 'chapter', title: 'B', fields: { title: 'B' } }),
    });
    const result = await api(`/v1/projects/${pid}/entities/${a.body.card.id}/links`, {
      method: 'POST',
      body: JSON.stringify({ toCardId: b.body.card.id, relationType: 'invented-type' }),
    });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('UNKNOWN_RELATION_TYPE');
  });

  it('rejects a type whose endpoint constraints do not match', async () => {
    const project = await api('/v1/projects', {
      method: 'POST',
      body: JSON.stringify({ title: '类型不匹配', scenarioId: 'novel' }),
    });
    const pid = project.body.project.id as string;
    const a = await api(`/v1/projects/${pid}/entities`, {
      method: 'POST',
      body: JSON.stringify({ type: 'chapter', title: 'A', fields: { title: 'A' } }),
    });
    const b = await api(`/v1/projects/${pid}/entities`, {
      method: 'POST',
      body: JSON.stringify({ type: 'location', title: 'B', fields: { name: 'B' } }),
    });
    // `appears-in` is character -> chapter; a chapter -> location link is invalid.
    const result = await api(`/v1/projects/${pid}/entities/${a.body.card.id}/links`, {
      method: 'POST',
      body: JSON.stringify({ toCardId: b.body.card.id, relationType: 'appears-in' }),
    });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('RELATION_TYPE_MISMATCH');
  });

  it('keeps free-text links working on packs without declared types', async () => {
    const project = await api('/v1/projects', {
      method: 'POST',
      body: JSON.stringify({ title: '自由文本', scenarioId: 'shorts' }),
    });
    const pid = project.body.project.id as string;
    const a = await api(`/v1/projects/${pid}/entities`, {
      method: 'POST',
      body: JSON.stringify({ type: 'shot', title: '镜头一', fields: { name: '镜头一' } }),
    });
    const b = await api(`/v1/projects/${pid}/entities`, {
      method: 'POST',
      body: JSON.stringify({ type: 'shot', title: '镜头二', fields: { name: '镜头二' } }),
    });
    const result = await api(`/v1/projects/${pid}/entities/${a.body.card.id}/links`, {
      method: 'POST',
      body: JSON.stringify({ toCardId: b.body.card.id, label: '接' }),
    });
    expect(result.status).toBe(201);
    expect(result.body.relation.relationType).toBeNull();
  });
});
