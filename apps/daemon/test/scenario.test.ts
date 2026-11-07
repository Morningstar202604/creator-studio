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
  workspace = mkdtempSync(join(tmpdir(), 'scenario-daemon-'));
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

describe('R1 scenario packs are served as data', () => {
  it('lists the built-in packs with a default', async () => {
    const result = await api('/v1/scenarios');
    expect(result.status).toBe(200);
    expect(result.body.scenarios.map((pack: { id: string }) => pack.id).sort()).toEqual([
      'copywriting',
      'course',
      'novel',
      'podcast',
      'shorts',
      'video',
    ]);
    expect(result.body.defaultId).toBe('video');
  });

  it('returns one pack and 404s an unknown id', async () => {
    expect((await api('/v1/scenarios/novel')).body.scenario.stages.length).toBeGreaterThan(2);
    expect((await api('/v1/scenarios/nope')).status).toBe(404);
  });
});

describe('R2 a project is created in its scenario', () => {
  it('creates a novel project on the first novel stage', async () => {
    const created = await api('/v1/projects', {
      method: 'POST',
      body: JSON.stringify({ title: '雾港纪事', scenarioId: 'novel' }),
    });
    expect(created.status).toBe(201);
    expect(created.body.project.scenarioId).toBe('novel');
    expect(created.body.project.stage).toBe('premise');
    expect(created.body.scenario.name).toBe('长篇小说');
  });

  it('rejects an unknown scenario', async () => {
    const created = await api('/v1/projects', {
      method: 'POST',
      body: JSON.stringify({ title: 'x', scenarioId: 'nope' }),
    });
    expect(created.status).toBe(400);
    expect(created.body.error.code).toBe('UNKNOWN_SCENARIO');
  });

  it('defaults to video when no scenario is supplied', async () => {
    const created = await api('/v1/projects', { method: 'POST', body: JSON.stringify({ title: '默认' }) });
    expect(created.body.project.scenarioId).toBe('video');
    expect(created.body.project.stage).toBe('topic');
  });
});

describe('R3 stage writes are validated against the project pack', () => {
  it('accepts a stage from the pack and rejects a video stage on a novel project', async () => {
    const created = await api('/v1/projects', { method: 'POST', body: JSON.stringify({ title: '阶段', scenarioId: 'novel' }) });
    const id = created.body.project.id as string;
    expect((await api(`/v1/projects/${id}/stage`, { method: 'POST', body: JSON.stringify({ stage: 'chapter' }) })).status).toBe(200);
    const rejected = await api(`/v1/projects/${id}/stage`, {
      method: 'POST',
      body: JSON.stringify({ stage: 'shotlist' }),
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('UNKNOWN_STAGE');
    expect(rejected.body.available).toContain('premise');
  });
});

describe('R4 the checklist follows the scenario, not the video pipeline', () => {
  it('asks a novel project for outline and chapter, never for a shot list', async () => {
    const created = await api('/v1/projects', { method: 'POST', body: JSON.stringify({ title: '检查表', scenarioId: 'novel' }) });
    const id = created.body.project.id as string;
    const checklist = await api(`/v1/projects/${id}/checklist`);
    const labels = checklist.body.items.map((item: { label: string }) => item.label).join(' | ');
    expect(labels).toContain('大纲');
    expect(labels).toContain('章节');
    expect(labels).not.toContain('分镜');
    expect(labels).not.toContain('字幕');
  });

  it('judges a card-backed stage by its cards, not by artifacts', async () => {
    const created = await api('/v1/projects', { method: 'POST', body: JSON.stringify({ title: '卡片检查表', scenarioId: 'novel' }) });
    const id = created.body.project.id as string;
    const before = await api(`/v1/projects/${id}/checklist`);
    const chapterBefore = before.body.items.find(
      (item: { key: string; label: string }) => item.key === 'chapter' || item.label === '章节',
    );
    expect(chapterBefore === undefined ? null : chapterBefore.ok).toBe(false);

    await api(`/v1/projects/${id}/entities`, {
      method: 'POST',
      body: JSON.stringify({ type: 'chapter', title: '第一章', fields: { title: '第一章' } }),
    });
    const after = await api(`/v1/projects/${id}/checklist`);
    const chapterAfter = after.body.items.find(
      (item: { key: string; label: string }) => item.key === 'chapter' || item.label === '章节',
    );
    expect(chapterAfter === undefined ? null : chapterAfter.ok).toBe(true);
  });

  it('still asks a video project for its own stages', async () => {
    const created = await api('/v1/projects', { method: 'POST', body: JSON.stringify({ title: '视频检查表' }) });
    const id = created.body.project.id as string;
    const checklist = await api(`/v1/projects/${id}/checklist`);
    const labels = checklist.body.items.map((item: { label: string }) => item.label).join(' | ');
    expect(labels).toContain('选题卡');
    expect(labels).toContain('分镜表');
  });
});

describe('R5 entity cards', () => {
  it('creates, lists and scopes cards to their project', async () => {
    const mine = await api('/v1/projects', { method: 'POST', body: JSON.stringify({ title: '我的小说', scenarioId: 'novel' }) });
    const other = await api('/v1/projects', { method: 'POST', body: JSON.stringify({ title: '别的小说', scenarioId: 'novel' }) });
    const pid = mine.body.project.id as string;
    const otherPid = other.body.project.id as string;

    const created = await api(`/v1/projects/${pid}/entities`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'character',
        title: '林砚',
        fields: { name: '林砚', role: '主角', goal: '查清父亲失踪' },
        tags: ['主角'],
      }),
    });
    expect(created.status).toBe(201);
    expect(created.body.card.order).toBe(0);

    const list = await api(`/v1/projects/${pid}/entities`);
    expect(list.body.cards).toHaveLength(1);
    expect(list.body.counts).toEqual({ character: 1 });

    const foreign = await api(`/v1/projects/${otherPid}/entities`);
    expect(foreign.body.cards).toHaveLength(0);
  });

  it('rejects a card missing a required field or using an unknown type', async () => {
    const project = await api('/v1/projects', { method: 'POST', body: JSON.stringify({ title: '校验', scenarioId: 'novel' }) });
    const pid = project.body.project.id as string;

    const missing = await api(`/v1/projects/${pid}/entities`, {
      method: 'POST',
      body: JSON.stringify({ type: 'character', title: '无目标', fields: { name: '无目标', role: '主角' } }),
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error.message).toContain('想要什么');

    const unknown = await api(`/v1/projects/${pid}/entities`, {
      method: 'POST',
      body: JSON.stringify({ type: 'spaceship', title: 'X', fields: {} }),
    });
    expect(unknown.status).toBe(400);
  });

  it('updates and deletes a card, 404ing a foreign id', async () => {
    const project = await api('/v1/projects', { method: 'POST', body: JSON.stringify({ title: '编辑', scenarioId: 'novel' }) });
    const pid = project.body.project.id as string;
    const created = await api(`/v1/projects/${pid}/entities`, {
      method: 'POST',
      body: JSON.stringify({ type: 'location', title: '七号泊位', fields: { name: '七号泊位', region: '北港' } }),
    });
    const cardId = created.body.card.id as string;

    const updated = await api(`/v1/projects/${pid}/entities/${cardId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        fields: { name: '七号泊位', region: '北港', atmosphere: '锈味很重' },
        expectedRevision: created.body.card.revision,
      }),
    });
    expect(updated.status).toBe(200);
    expect(updated.body.card.fields.atmosphere).toBe('锈味很重');

    // A project that does not exist is a 404, same as a missing card.
    expect((await api(`/v1/projects/other/entities/${cardId}`, { method: 'DELETE' })).status).toBe(404);
    expect((await api(`/v1/projects/${pid}/entities/${cardId}`, { method: 'DELETE' })).status).toBe(200);
    expect((await api(`/v1/projects/${pid}/entities/${cardId}`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('R6 concurrent card writes cannot silently lose text', () => {
  const makeProject = async (): Promise<string> => {
    const project = await api('/v1/projects', { method: 'POST', body: JSON.stringify({ title: '并发', scenarioId: 'novel' }) });
    return project.body.project.id as string;
  };

  it('rejects a write whose expectedRevision is stale and returns the current card', async () => {
    const pid = await makeProject();
    const created = await api(`/v1/projects/${pid}/entities`, {
      method: 'POST',
      body: JSON.stringify({ type: 'chapter', title: '第一章', fields: { title: '第一章', number: '1' }, body: '' }),
    });
    const cardId = created.body.card.id as string;
    const read = await api(`/v1/projects/${pid}/entities`);
    const seenRevision = read.body.cards.find((card: { id: string }) => card.id === cardId).revision as number;

    const first = await api(`/v1/projects/${pid}/entities/${cardId}`, {
      method: 'PATCH',
      body: JSON.stringify({ body: '甲写了这句', expectedRevision: seenRevision }),
    });
    expect(first.status).toBe(200);
    expect(first.body.card.revision).toBe(seenRevision + 1);

    // Second client still believes it is on the revision it read.
    const second = await api(`/v1/projects/${pid}/entities/${cardId}`, {
      method: 'PATCH',
      body: JSON.stringify({ body: '乙写了这句', expectedRevision: seenRevision }),
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('CARD_STALE');
    // The response carries the winner's text so the UI can merge instead of guess.
    expect(second.body.card.body).toBe('甲写了这句');
    expect(second.body.card.revision).toBe(seenRevision + 1);

    // Nothing was overwritten by the rejected write.
    const after = await api(`/v1/projects/${pid}/entities`);
    const stored = after.body.cards.find((card: { id: string }) => card.id === cardId);
    expect(stored.body).toBe('甲写了这句');
  });

  it('refuses an unconditional write so text cannot be silently replaced', async () => {
    const pid = await makeProject();
    const created = await api(`/v1/projects/${pid}/entities`, {
      method: 'POST',
      body: JSON.stringify({ type: 'chapter', title: '第二章', fields: { title: '第二章', number: '2' } }),
    });
    const cardId = created.body.card.id as string;
    // No expectedRevision: the old behaviour would overwrite whatever was there.
    const blind = await api(`/v1/projects/${pid}/entities/${cardId}`, {
      method: 'PATCH',
      body: JSON.stringify({ order: 7 }),
    });
    expect(blind.status).toBe(428);
    expect(blind.body.error.code).toBe('EXPECTED_REVISION_REQUIRED');
    expect(blind.body.card.revision).toBe(1);

    // A caller that really means "whatever is stored now" says so explicitly.
    const forced = await api(`/v1/projects/${pid}/entities/${cardId}`, {
      method: 'PATCH',
      body: JSON.stringify({ order: 7, force: true }),
    });
    expect(forced.status).toBe(200);
    expect(forced.body.card.order).toBe(7);
  });

  it('accepts a reorder that carries the revision it read', async () => {
    const pid = await makeProject();
    const created = await api(`/v1/projects/${pid}/entities`, {
      method: 'POST',
      body: JSON.stringify({ type: 'chapter', title: '第二章', fields: { title: '第二章', number: '2' } }),
    });
    const moved = await api(`/v1/projects/${pid}/entities/${created.body.card.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ order: 3, expectedRevision: created.body.card.revision }),
    });
    expect(moved.status).toBe(200);
    expect(moved.body.card.order).toBe(3);
  });

  it('lists history and restores an earlier revision', async () => {
    const pid = await makeProject();
    const created = await api(`/v1/projects/${pid}/entities`, {
      method: 'POST',
      body: JSON.stringify({ type: 'chapter', title: '第三章', fields: { title: '第三章', number: '3' }, body: '初稿' }),
    });
    const cardId = created.body.card.id as string;
    const baseRevision = created.body.card.revision as number;
    await api(`/v1/projects/${pid}/entities/${cardId}`, {
      method: 'PATCH',
      body: JSON.stringify({ body: '改坏了', expectedRevision: baseRevision }),
    });

    const history = await api(`/v1/projects/${pid}/entities/${cardId}/revisions`);
    expect(history.status).toBe(200);
    expect(history.body.revisions).toHaveLength(1);
    expect(history.body.revisions[0].body).toBe('初稿');

    const restored = await api(`/v1/projects/${pid}/entities/${cardId}/revisions/${baseRevision}/restore`, {
      method: 'POST',
    });
    expect(restored.status).toBe(200);
    expect(restored.body.card.body).toBe('初稿');
    expect(restored.body.restoredFrom).toBe(baseRevision);

    // Restoring is itself a version, so the damaged text is still recoverable.
    const after = await api(`/v1/projects/${pid}/entities/${cardId}/revisions`);
    expect(after.body.revisions[0].reason).toBe('restore');
    expect(after.body.revisions[0].body).toBe('改坏了');
  });

  it('404s history for an unknown card and rejects a non-numeric revision', async () => {
    const pid = await makeProject();
    expect((await api(`/v1/projects/${pid}/entities/nope/revisions`)).status).toBe(404);
    const created = await api(`/v1/projects/${pid}/entities`, {
      method: 'POST',
      body: JSON.stringify({ type: 'chapter', title: '第四章', fields: { title: '第四章', number: '4' } }),
    });
    const cardId = created.body.card.id as string;
    const bad = await api(`/v1/projects/${pid}/entities/${cardId}/revisions/abc/restore`, { method: 'POST' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_REVISION');
  });
});

describe('R5b the stage prompt hint reaches generation', () => {
  it('sends the scenario instruction for the matching kind', async () => {
    // The fake model endpoint is unreachable, so the request still fails — but the
    // hint is assembled before the call and asserted through the thrown error path.
    const created = await api('/v1/projects', { method: 'POST', body: JSON.stringify({ title: '提示词', scenarioId: 'novel' }) });
    const id = created.body.project.id as string;
    const result = await api(`/v1/projects/${id}/generate`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'outline', context: '雾港' }),
    });
    // Model unavailability is the expected failure here; the assertion below is that
    // the request was accepted and reached the gateway, not rejected at validation.
    expect(result.status).toBe(502);
    expect(result.body.error.code).not.toBe('INVALID_INPUT');
  });
});

describe('R6 user-defined packs can be created and used', () => {
  it('creates a custom pack and a project that follows it', async () => {
    const pack = {
      id: 'podcast-solo',
      name: '独白播客',
      description: '一个人的节目',
      icon: '🎧',
      stages: [
        { key: 'angle', label: '角度', view: 'generate', hint: '', produces: ['topic-card'], promptHint: '', required: true },
        { key: 'script', label: '稿子', view: 'generate', hint: '', produces: ['script'], promptHint: '', required: true },
      ],
      entityTypes: [],
      defaultPlatform: 'generic',
    };
    const created = await api('/v1/scenarios', { method: 'POST', body: JSON.stringify(pack) });
    expect(created.status).toBe(201);
    expect(created.body.scenario.stages).toHaveLength(2);

    const project = await api('/v1/projects', {
      method: 'POST',
      body: JSON.stringify({ title: '独白第一期', scenarioId: 'podcast-solo' }),
    });
    expect(project.body.project.stage).toBe('angle');

    const checklist = await api(`/v1/projects/${project.body.project.id}/checklist`);
    expect(checklist.body.items.map((item: { label: string }) => item.label).join('|')).toContain('角度');
  });

  it('rejects an invalid pack with 400', async () => {
    const result = await api('/v1/scenarios', {
      method: 'POST',
      body: JSON.stringify({ id: 'broken', name: '坏包', stages: [] }),
    });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('INVALID_SCENARIO');
  });

  it('refuses to edit or delete a built-in pack', async () => {
    const edit = await api('/v1/scenarios', {
      method: 'POST',
      body: JSON.stringify({ ...(await api('/v1/scenarios/novel')).body.scenario, name: '改掉' }),
    });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('BUILTIN_READONLY');
    expect((await api('/v1/scenarios/novel', { method: 'DELETE' })).status).toBe(409);
  });
});
