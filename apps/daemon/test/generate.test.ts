import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ModelGateway } from '@creator-studio/model-gateway';
import { createDaemon, type Daemon } from '../src/server.js';

type Reply = { status?: number; body: string };

class Upstream {
  private server = createServer((req, res) => this.handle(req, res));
  private queue: Reply[] = [];
  readonly requests: Array<Record<string, unknown>> = [];
  port = 0;

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())));
  }

  reply(body: string, status = 200): void {
    this.queue.push({ body, status });
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    this.requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);

    const next = this.queue.shift();
    if (next === undefined) {
      res.writeHead(500).end('no queued reply');
      return;
    }
    if (next.status !== 200) {
      res.writeHead(next.status, { 'content-type': 'application/json' });
      res.end(next.body);
      return;
    }

    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const piece of split(next.body)) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 200, completion_tokens: 100 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  }
}

function split(text: string): string[] {
  const size = Math.max(1, Math.ceil(text.length / 4));
  const parts: string[] = [];
  for (let index = 0; index < text.length; index += size) parts.push(text.slice(index, index + size));
  return parts;
}

let workspace: string;
let upstream: Upstream;
let daemon: Daemon;
let baseUrl: string;
let projectId: string;

const validTopic = JSON.stringify({
  cards: [
    {
      title: 'AI 正在杀死初级岗位吗',
      angle: '用招聘数据讲结构性变化',
      scores: { demand: 82, competition: 45, differentiation: 71, speakability: 76 },
      composite: 76,
      rationale: '搜索上升但头部内容少',
      risks: ['数据来源较旧'],
    },
  ],
});

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'gen-ws-'));
  upstream = new Upstream();
  await upstream.start();

  const gateway = new ModelGateway({
    profiles: [
      {
        id: 'm1',
        userId: 'local-user',
        name: 'up',
        provider: 'openai-compatible',
        baseUrl: upstream.baseUrl,
        model: 'fake',
        apiKeyRef: 'keychain:test',
        contextWindow: 8000,
        priceInPerM: 0,
        priceOutPerM: 0,
        isLocal: true,
      },
    ],
    resolveKey: async () => 'sk-test',
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
    body: JSON.stringify({ title: '生成测试' }),
  });
  projectId = ((await created.json()) as { project: { id: string } }).project.id;
});

afterAll(async () => {
  await daemon.close();
  await upstream.stop();
  rmSync(workspace, { recursive: true, force: true });
});

async function generate(kind: string, context = 'AI 与就业'): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}/v1/projects/${projectId}/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, context }),
  });
  return { status: response.status, body: await response.json() };
}

describe('R1 schema gate', () => {
  it('rejects output that fails the contract and persists nothing', async () => {
    const before = await fetch(`${baseUrl}/v1/projects/${projectId}/artifacts`);
    const beforeCount = ((await before.json()) as { artifacts: unknown[] }).artifacts.length;

    upstream.reply(JSON.stringify({ cards: [{ title: 'x' }] }));
    // The pipeline retries once with a literal example, so queue the same bad shape twice.
    upstream.reply(JSON.stringify({ cards: [{ title: 'x' }] }));
    const result = await generate('topic-card');

    expect(result.status).toBe(502);
    expect(result.body.error.code).toBe('MODEL_BAD_OUTPUT');

    const after = await fetch(`${baseUrl}/v1/projects/${projectId}/artifacts`);
    expect(((await after.json()) as { artifacts: unknown[] }).artifacts.length).toBe(beforeCount);
  });

  it('repairs a contract failure with one corrective retry', async () => {
    const cards = JSON.stringify({
      cards: [
        {
          title: '修复后的选题',
          angle: '角度',
          scores: { demand: 80, competition: 40, differentiation: 70, speakability: 60 },
          composite: 70,
          rationale: '理由',
          risks: [],
        },
      ],
    });
    upstream.reply(JSON.stringify({ cards: 'not-an-array' }));
    upstream.reply(cards);
    const result = await generate('topic-card');
    expect(result.status).toBe(201);
    expect((result.body.payload as { cards: Array<{ title: string }> }).cards[0]?.title).toBe('修复后的选题');
  });

  it('rejects a non-JSON response', async () => {
    upstream.reply('抱歉，我无法完成这个请求。');
    upstream.reply('抱歉，我仍然无法完成这个请求。');
    const result = await generate('topic-card');
    expect(result.status).toBe(502);
    expect(result.body.error.code).toBe('MODEL_BAD_OUTPUT');
  });

  it('rejects an unknown kind before calling the model', async () => {
    const callsBefore = upstream.requests.length;
    const result = await generate('not-a-kind');
    expect(result.status).toBe(400);
    expect(upstream.requests.length).toBe(callsBefore);
  });

  it('rejects an empty context', async () => {
    const response = await fetch(`${baseUrl}/v1/projects/${projectId}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'topic-card', context: '  ' }),
    });
    expect(response.status).toBe(400);
  });
});

describe('R2 fenced output', () => {
  it('accepts json wrapped in a code fence', async () => {
    upstream.reply('```json\n' + validTopic + '\n```');
    const result = await generate('topic-card');
    expect(result.status).toBe(201);
    expect(result.body.artifact.kind).toBe('topic-card');
  });
});

describe('R4 persisted artifact is readable', () => {
  it('stores markdown that can be read back through the artifact API', async () => {
    upstream.reply(validTopic);
    const result = await generate('topic-card');
    expect(result.status).toBe(201);

    const artifactId = result.body.artifact.id as string;
    const readBack = await fetch(`${baseUrl}/v1/artifacts/${artifactId}`);
    expect(readBack.status).toBe(200);
    const body = (await readBack.json()) as { content: string };
    expect(body.content).toContain('AI 正在杀死初级岗位吗');
    expect(body.content).toContain('综合分');
  });

  it('increments the version on a second generation', async () => {
    upstream.reply(validTopic);
    const first = await generate('topic-card');
    upstream.reply(validTopic);
    const second = await generate('topic-card');
    expect(first.body.artifact.path).not.toBe(second.body.artifact.path);
  });

  it('generates research notes and a publish pack', async () => {
    upstream.reply(
      JSON.stringify({
        notes: [{ claim: '校招名额下降', source: 'example.com', confidence: 'medium', note: '二手' }],
        gaps: ['缺官方统计'],
      }),
    );
    const notes = await generate('research-notes');
    expect(notes.status).toBe(201);

    upstream.reply(
      JSON.stringify({
        titles: [
          { title: 'A', score: 90, reason: 'r' },
          { title: 'B', score: 85, reason: 'r' },
          { title: 'C', score: 80, reason: 'r' },
        ],
        description: '简介',
        tags: ['AI'],
        chapters: [{ time: '00:00', label: '开场' }],
        coverBrief: 'brief',
        compliance: [],
      }),
    );
    const pack = await generate('publish-pack');
    expect(pack.status).toBe(201);
    expect(pack.body.artifact.kind).toBe('publish-pack');
  });
});

describe('upstream failure mapping', () => {
  it('maps an upstream 401 to MODEL_AUTH without persisting', async () => {
    upstream.reply('{"error":"bad key"}', 401);
    const result = await generate('topic-card');
    expect(result.status).toBe(502);
    expect(result.body.error.code).toBe('MODEL_AUTH');
  });
});

describe('R1 generation carries upstream artifacts', () => {
  it('includes the script text in the publish-pack prompt', async () => {
    const projectId = `proj-up-${Date.now()}`;
    const created = await fetch(`${baseUrl}/v1/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: projectId }),
    });
    const pid = ((await created.json()) as { project: { id: string } }).project.id;

    await fetch(`${baseUrl}/v1/projects/${pid}/artifacts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'script',
        path: 'script/script.v1.md',
        content: '这是一段独一无二的脚本正文标记 SCRIPT_MARKER_42',
      }),
    });

    upstream.reply(
      JSON.stringify({
        titles: [
          { title: 'A', score: 90, reason: 'r' },
          { title: 'B', score: 85, reason: 'r' },
          { title: 'C', score: 80, reason: 'r' },
        ],
        description: '简介',
        tags: ['AI'],
        chapters: [],
        coverBrief: 'b',
        compliance: [],
      }),
    );

    const response = await fetch(`${baseUrl}/v1/projects/${pid}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'publish-pack', context: '做一期视频', includeUpstream: true }),
    });
    expect(response.status).toBe(201);

    const sent = upstream.requests.at(-1) as { messages: Array<{ role: string; content: string }> };
    const userMessage = sent.messages.find((message) => message.role === 'user');
    expect(userMessage?.content).toContain('SCRIPT_MARKER_42');
    expect(userMessage?.content).toContain('上游产物');
  });

  it('does not add upstream text when includeUpstream is false', async () => {
    const created = await fetch(`${baseUrl}/v1/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'no-upstream' }),
    });
    const pid = ((await created.json()) as { project: { id: string } }).project.id;

    await fetch(`${baseUrl}/v1/projects/${pid}/artifacts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'script', path: 'script/script.v1.md', content: 'MARKER_OFF_7' }),
    });

    upstream.reply(validTopic);
    const response = await fetch(`${baseUrl}/v1/projects/${pid}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'topic-card', context: 'x', includeUpstream: false }),
    });
    expect(response.status).toBe(201);

    const sent = upstream.requests.at(-1) as { messages: Array<{ role: string; content: string }> };
    const userMessage = sent.messages.find((message) => message.role === 'user');
    expect(userMessage?.content).not.toContain('MARKER_OFF_7');
  });
});
