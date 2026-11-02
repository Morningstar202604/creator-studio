import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ModelGateway } from '@creator-studio/model-gateway';
import { createDaemon, type Daemon } from '../src/server.js';

const SCRIPT_BODY = JSON.stringify({
  hook: '开场钩子',
  sections: [
    { heading: '一、先看数据', content: '2026 年春招，初级开发岗位同比下降 18%。' },
    { heading: '二、原因', content: '企业需要能直接交付的人。' },
  ],
  cta: '先把一个完整项目做深。',
  estimatedMinutes: 9,
});

const REVIEW_BODY = JSON.stringify({
  summary: '本期完播率高于上期，标题命中了具体数字。',
  findings: [{ title: '标题具体', evidence: '播放环比上升', action: '下一期继续用数字标题' }],
  nextTopics: ['AI 面试题变化'],
  score: 82,
});

class Upstream {
  private server = createServer((req, res) => void this.handle(req, res));
  private queue: string[] = [];
  port = 0;
  readonly bodies: Array<Record<string, unknown>> = [];

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
    this.bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
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

async function createProject(title = '风格测试'): Promise<string> {
  const created = await api('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({ title, platform: 'bilibili' }),
  });
  return created.body.project.id as string;
}

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'style-daemon-'));
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
    scheduler: false,
  });
  await daemon.app.listen({ port: 0, host: '127.0.0.1' });
  const address = daemon.app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await daemon.close();
  await upstream.stop();
  rmSync(workspace, { recursive: true, force: true });
});

describe('R1 style profiles API', () => {
  it('creates, lists, updates and deletes a profile', async () => {
    const created = await api('/v1/styles', {
      method: 'POST',
      body: JSON.stringify({
        name: '理性分析',
        tone: '先结论后证据',
        audience: 'B 站知识区',
        bannedWords: ['赋能', '抓手'],
      }),
    });
    expect(created.status).toBe(201);
    expect(created.body.style.bannedWords).toEqual(['赋能', '抓手']);

    const listed = await api('/v1/styles');
    expect(listed.body.styles.length).toBeGreaterThanOrEqual(1);

    const updated = await api('/v1/styles', {
      method: 'POST',
      body: JSON.stringify({ id: created.body.style.id, name: '理性分析 v2' }),
    });
    expect(updated.status).toBe(201);
    expect(updated.body.style.id).toBe(created.body.style.id);

    const removed = await api(`/v1/styles/${created.body.style.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(removed.body.detached).toBe(true);
    expect((await api(`/v1/styles/${created.body.style.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('rejects a blank name and an unknown id', async () => {
    expect((await api('/v1/styles', { method: 'POST', body: JSON.stringify({ name: '  ' }) })).status).toBe(400);
    expect(
      (await api('/v1/styles', { method: 'POST', body: JSON.stringify({ id: 'nope', name: 'x' }) })).status,
    ).toBe(404);
  });

  it('attaches a profile to a project and rejects a bogus style id', async () => {
    const projectId = await createProject('挂载风格');
    const style = await api('/v1/styles', { method: 'POST', body: JSON.stringify({ name: '冷静' }) });
    const attached = await api(`/v1/projects/${projectId}`, {
      method: 'PATCH',
      body: JSON.stringify({ styleProfileId: style.body.style.id }),
    });
    expect(attached.status).toBe(200);
    expect(attached.body.project.styleProfileId).toBe(style.body.style.id);

    const bogus = await api(`/v1/projects/${projectId}`, {
      method: 'PATCH',
      body: JSON.stringify({ styleProfileId: 'missing' }),
    });
    expect(bogus.status).toBe(400);

    const detached = await api(`/v1/projects/${projectId}`, {
      method: 'PATCH',
      body: JSON.stringify({ styleProfileId: null }),
    });
    expect(detached.body.project.styleProfileId).toBeNull();
  });
});

describe('R2 style is injected into generation and surfaced by lint', () => {
  it('includes the attached profile in the model prompt', async () => {
    const projectId = await createProject('风格注入');
    const style = await api('/v1/styles', {
      method: 'POST',
      body: JSON.stringify({ name: '我的口播', tone: '短句、有数据', bannedWords: ['赋能'] }),
    });
    await api(`/v1/projects/${projectId}`, {
      method: 'PATCH',
      body: JSON.stringify({ styleProfileId: style.body.style.id }),
    });

    upstream.reply(SCRIPT_BODY);
    const generated = await api(`/v1/projects/${projectId}/generate`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'script', context: 'AI 与就业' }),
    });
    expect(generated.status).toBe(201);

    const sent = upstream.bodies.at(-1) as { messages: Array<{ role: string; content: string }> };
    const user = sent.messages.find((message) => message.role === 'user');
    expect(user?.content).toContain('作者风格偏好');
    expect(user?.content).toContain('短句、有数据');
    expect(user?.content).toContain('赋能');
    expect(sent.messages[0]?.content).toContain('只输出一个 JSON 对象');
  });

  it('reports banned words in the latest script and keeps export unblocked', async () => {
    const projectId = await createProject('禁用词');
    const style = await api('/v1/styles', {
      method: 'POST',
      body: JSON.stringify({ name: '禁词', bannedWords: ['赋能'] }),
    });
    await api(`/v1/projects/${projectId}`, {
      method: 'PATCH',
      body: JSON.stringify({ styleProfileId: style.body.style.id }),
    });
    await api(`/v1/projects/${projectId}/artifacts`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'script', path: 'script/script.v1.md', content: '我们要赋能每一个创作者。' }),
    });
    // A publish pack is also audience-facing, so it must feed the same lint.
    await api(`/v1/projects/${projectId}/artifacts`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'publish-pack',
        path: 'publish/publish-pack.v1.md',
        content: '## 标题候选\n\n1. 赋能创作者（90）',
      }),
    });

    const lint = await api(`/v1/projects/${projectId}/style-lint`);
    expect(lint.status).toBe(200);
    expect(lint.body.lint.hits).toEqual([{ word: '赋能', count: 2 }]);

    const checklist = await api(`/v1/projects/${projectId}/checklist`);
    const styleItem = checklist.body.items.find((item: { key: string }) => item.key === 'style');
    expect(styleItem.ok).toBe(false);
    expect(styleItem.required).toBe(false);
    expect(checklist.body.missing).not.toContain('style');
  });

  it('does not report a clean style check before any audience-facing artifact exists', async () => {
    const projectId = await createProject('未生成');
    const style = await api('/v1/styles', { method: 'POST', body: JSON.stringify({ name: '未查' }) });
    await api(`/v1/projects/${projectId}`, {
      method: 'PATCH',
      body: JSON.stringify({ styleProfileId: style.body.style.id }),
    });
    const checklist = await api(`/v1/projects/${projectId}/checklist`);
    const styleItem = checklist.body.items.find((item: { key: string }) => item.key === 'style');
    expect(styleItem.ok).toBe(false);
    expect(styleItem.detail).toContain('尚无脚本可查');
  });

  it('reports no style when the project has no profile', async () => {
    const projectId = await createProject('无风格');
    const lint = await api(`/v1/projects/${projectId}/style-lint`);
    expect(lint.body.lint).toBeNull();
  });
});

describe('R3 subtitle export', () => {
  it('turns the latest script into a persisted SRT artifact', async () => {
    const projectId = await createProject('字幕导出');
    await api(`/v1/projects/${projectId}/artifacts`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'script',
        path: 'script/script.v1.md',
        content: '# 开场\n\n这是第一句话。这是第二句话，里面有逗号。',
      }),
    });
    const exported = await api(`/v1/projects/${projectId}/subtitle`, { method: 'POST' });
    expect(exported.status).toBe(201);
    expect(exported.body.artifact.kind).toBe('subtitle');
    expect(exported.body.artifact.path).toBe('subtitle/subtitle.v1.srt');
    expect(exported.body.cues).toBeGreaterThan(0);

    const detail = await api(`/v1/artifacts/${exported.body.artifact.id}`);
    expect(detail.body.content).toContain('-->');
    expect(detail.body.artifact.mime).toBe('application/x-subrip');

    // A second export must not overwrite v1: SRT is a non-markdown extension.
    const second = await api(`/v1/projects/${projectId}/subtitle`, { method: 'POST' });
    expect(second.body.artifact.path).toBe('subtitle/subtitle.v2.srt');
  });

  it('refuses to export without a script', async () => {
    const projectId = await createProject('空字幕');
    const response = await api(`/v1/projects/${projectId}/subtitle`, { method: 'POST' });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('NO_SCRIPT');
  });

  it('rejects a script artifact id from another project', async () => {
    const projectId = await createProject('跨项目字幕');
    const other = await createProject('另一个项目');
    const otherScript = await api(`/v1/projects/${other}/artifacts`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'script', path: 'script/script.v1.md', content: '别人的脚本。' }),
    });
    const response = await api(`/v1/projects/${projectId}/subtitle`, {
      method: 'POST',
      body: JSON.stringify({ scriptArtifactId: otherScript.body.artifact.id }),
    });
    expect(response.status).toBe(400);
  });
});

describe('R4 review report from recorded metrics', () => {
  it('generates a review report and advances the project to review', async () => {
    const projectId = await createProject('复盘生成');
    await api(`/v1/projects/${projectId}/metrics`, {
      method: 'POST',
      body: JSON.stringify({ views: 1000, likes: 50, comments: 10, retentionPercent: 42 }),
    });
    upstream.reply(REVIEW_BODY);
    const generated = await api(`/v1/projects/${projectId}/review`, { method: 'POST' });
    expect(generated.status).toBe(201);
    expect(generated.body.artifact.kind).toBe('review-report');

    const project = await api(`/v1/projects/${projectId}`);
    expect(project.body.project.stage).toBe('review');

    const sent = upstream.bodies.at(-1) as { messages: Array<{ role: string; content: string }> };
    const user = sent.messages.find((message) => message.role === 'user');
    expect(user?.content).toContain('播放 1000');
  });

  it('refuses when no metrics exist', async () => {
    const projectId = await createProject('无复盘数据');
    const response = await api(`/v1/projects/${projectId}/review`, { method: 'POST' });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('NO_METRICS');
  });
});
