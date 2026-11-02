import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ModelGateway } from '@creator-studio/model-gateway';
import { createDaemon, type Daemon } from '../src/server.js';

const REVIEW_BODY = JSON.stringify({
  summary: '构图稳定，节奏偏慢。',
  findings: [{ title: '开场太慢', evidence: '前 30 秒无冲突', action: '把冲突提到第 10 秒' }],
  nextTopics: ['雾港前传'],
  score: 74,
});

class Upstream {
  private server = createServer((req, res) => void this.handle(req, res));
  private queue: string[] = [];
  port = 0;

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())));
  }

  reply(body: string): void {
    this.queue.push(body);
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const next = this.queue.shift() ?? '{}';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: next } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 50 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  }
}

let workspace: string;
let daemon: Daemon;
let baseUrl: string;
const upstream = new Upstream();

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }), ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : JSON.parse(text) };
}

async function createProject(title: string, scenarioId: string): Promise<string> {
  const created = await api('/v1/projects', { method: 'POST', body: JSON.stringify({ title, scenarioId }) });
  return created.body.project.id as string;
}

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'consistency-'));
  await upstream.start();
  const gateway = new ModelGateway({
    profiles: [
      {
        id: 'm1',
        userId: 'u',
        name: 'stub',
        provider: 'openai-compatible',
        baseUrl: upstream.baseUrl,
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
  });
  await daemon.app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(daemon.app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await daemon.close();
  await upstream.stop();
  rmSync(workspace, { recursive: true, force: true });
});

describe('R1 novel chapters are indexed into memory', () => {
  it('returns a saved chapter from memory search', async () => {
    const projectId = await createProject('索引测试', 'novel');
    const saved = await api(`/v1/projects/${projectId}/artifacts`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'chapter',
        path: 'chapter/chapter.v1.md',
        content: '# 第一章 雾\n\n海雾压着航道，林砚攥着父亲的海图。',
      }),
    });
    expect(saved.status).toBe(201);

    const search = await api(`/v1/memory/search?q=${encodeURIComponent('海雾压着航道')}&projectId=${projectId}`);
    expect(search.status).toBe(200);
    expect(search.body.hits.length).toBeGreaterThan(0);
    expect(search.body.hits[0].kind).toBe('chapter');
  });

  it('still refuses to index a derived subtitle', async () => {
    const projectId = await createProject('字幕不索引', 'video');
    await api(`/v1/projects/${projectId}/artifacts`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'subtitle', path: 'script/subtitle.v1.srt', content: '1\n00:00:01,000 --> 00:00:02,000\n字幕' }),
    });
    const search = await api(`/v1/memory/search?q=${encodeURIComponent('字幕')}&projectId=${projectId}`);
    expect(search.body.hits).toEqual([]);
  });
});

describe('R2 review advances to the stage the pack declares', () => {
  it('moves a novel project to revision, not a video-only review stage', async () => {
    const projectId = await createProject('复盘阶段', 'novel');
    await api(`/v1/projects/${projectId}/metrics`, {
      method: 'POST',
      body: JSON.stringify({ views: 100, likes: 10, comments: 2, shares: 1, retentionPercent: 40, revenueCny: 0 }),
    });
    upstream.reply(REVIEW_BODY);
    const generated = await api(`/v1/projects/${projectId}/review`, { method: 'POST' });
    expect(generated.status).toBe(201);

    const project = await api(`/v1/projects/${projectId}`);
    expect(project.body.project.stage).toBe('revision');
    const stages = (await api('/v1/scenarios/novel')).body.scenario.stages.map((stage: { key: string }) => stage.key);
    expect(stages).toContain(project.body.project.stage);
  });
});

describe('R3 a card-backed stage produces the artifact its pack declares', () => {
  it('shorts shot cards map to the shot-list pipeline', async () => {
    const projectId = await createProject('镜头生成', 'shorts');
    const scenario = (await api('/v1/scenarios/shorts')).body.scenario;
    const stage = scenario.stages.find((candidate: { entityType?: string }) => candidate.entityType === 'shot');
    expect(stage.key).toBe('shots');
    expect(stage.produces[0]).toBe('shot-list');

    const card = await api(`/v1/projects/${projectId}/entities`, {
      method: 'POST',
      body: JSON.stringify({ type: 'shot', title: '特写', fields: { name: '特写', duration: '3', status: '待拍' } }),
    });
    expect(card.status).toBe(201);
    // The stage lookup the UI performs: entityType first, key second.
    const byEntity = scenario.stages.find((candidate: { entityType?: string }) => candidate.entityType === 'shot');
    expect(byEntity).toBeDefined();
  });
});
