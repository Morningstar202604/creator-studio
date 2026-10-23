import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ModelGateway } from '@creator-studio/model-gateway';
import { createDaemon, type Daemon } from '../src/server.js';

const iso = '2026-10-21T10:00:00.000Z';

type Scripted = { text?: string; tool?: { id: string; name: string; args: unknown } };

class Upstream {
  private server = createServer((req, res) => this.handle(req, res));
  private turns: Scripted[] = [];
  private cursor = 0;
  readonly requests: Array<{ body: Record<string, unknown> }> = [];
  port = 0;

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())));
  }

  script(turns: Scripted[]): void {
    this.turns = turns;
    this.cursor = 0;
    this.requests.length = 0;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    this.requests.push({ body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> });

    const turn = this.turns[this.cursor];
    this.cursor += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });

    if (turn === undefined) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '?' }, finish_reason: 'stop' }] })}\n\n`);
    } else if (turn.text !== undefined) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: turn.text }, finish_reason: 'stop' }] })}\n\n`);
    } else if (turn.tool !== undefined) {
      res.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: turn.tool.id,
                    type: 'function',
                    function: { name: turn.tool.name, arguments: JSON.stringify(turn.tool.args) },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
      );
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 8 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  }
}

let workspace: string;
let upstream: Upstream;
let daemon: Daemon;
let baseUrl: string;

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'daemon-ws-'));
  upstream = new Upstream();
  await upstream.start();

  const gateway = new ModelGateway({
    profiles: [
      {
        id: 'm1',
        userId: 'local-user',
        name: 'upstream',
        provider: 'openai-compatible',
        baseUrl: upstream.baseUrl,
        model: 'fake',
        apiKeyRef: 'keychain:test',
        contextWindow: 128_000,
        priceInPerM: 1,
        priceOutPerM: 1,
        isLocal: true,
      },
    ],
    resolveKey: async () => 'sk-test',
    sleep: async () => {},
  });

  daemon = await createDaemon({
    dbPath: join(workspace, 'daemon.db'),
    workspaceRoot: join(workspace, 'project'),
    deviceId: 'd1',
    modelGateway: gateway,
  });
  await daemon.app.listen({ port: 0, host: '127.0.0.1' });
  const address = daemon.app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  writeFileSync(join(workspace, 'project', 'ref.md'), '参考资料 X');
});

afterAll(async () => {
  await daemon.close();
  await upstream.stop();
  rmSync(workspace, { recursive: true, force: true });
});

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : JSON.parse(text) };
}

describe('daemon HTTP surface', () => {
  it('answers health with workspace info', async () => {
    const { status, body } = await api('/health');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.os).toBe(process.platform);
  });

  it('lists the registered tools', async () => {
    const { body } = await api('/v1/tools');
    expect(body.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
      'fs.delete',
      'fs.read',
      'fs.write',
    ]);
  });

  it('creates, lists and fetches a project', async () => {
    const created = await api('/v1/projects', {
      method: 'POST',
      body: JSON.stringify({ title: '为什么 AI 编程正在杀死初级开发者', platform: 'bilibili' }),
    });
    expect(created.status).toBe(201);
    const projectId = created.body.project.id as string;
    expect(created.body.project.stage).toBe('topic');

    const listed = await api('/v1/projects');
    expect(listed.body.projects.map((project: { id: string }) => project.id)).toContain(projectId);

    const fetched = await api(`/v1/projects/${projectId}`);
    expect(fetched.body.project.title).toBe('为什么 AI 编程正在杀死初级开发者');
  });

  it('rejects a project without a title', async () => {
    const { status, body } = await api('/v1/projects', { method: 'POST', body: JSON.stringify({}) });
    expect(status).toBe(400);
    expect(body.error.code).toBe('INVALID_INPUT');
  });

  it('advances the stage and persists it', async () => {
    const created = await api('/v1/projects', { method: 'POST', body: JSON.stringify({ title: 'T' }) });
    const id = created.body.project.id as string;
    const advanced = await api(`/v1/projects/${id}/stage`, {
      method: 'POST',
      body: JSON.stringify({ stage: 'script' }),
    });
    expect(advanced.body.project.stage).toBe('script');
    const refetched = await api(`/v1/projects/${id}`);
    expect(refetched.body.project.stage).toBe('script');
  });

  it('rejects an unknown stage', async () => {
    const created = await api('/v1/projects', { method: 'POST', body: JSON.stringify({ title: 'T' }) });
    const id = created.body.project.id as string;
    const { status } = await api(`/v1/projects/${id}/stage`, {
      method: 'POST',
      body: JSON.stringify({ stage: 'editing' }),
    });
    expect(status).toBe(400);
  });
});

describe('daemon run pipeline', () => {
  it('runs a full model turn and exposes the events', async () => {
    const created = await api('/v1/projects', { method: 'POST', body: JSON.stringify({ title: 'R1' }) });
    const projectId = created.body.project.id as string;

    const run = await api(`/v1/projects/${projectId}/runs`, {
      method: 'POST',
      body: JSON.stringify({ message: '写一段开场', agentId: 'scriptwriter' }),
    });
    expect(run.status).toBe(202);
    const runId = run.body.run.id as string;

    upstream.script([{ text: '这是开场。' }]);

    const executed = await api(`/v1/runs/${runId}/execute`, {
      method: 'POST',
      body: JSON.stringify({ message: '写一段开场' }),
    });
    expect(executed.status).toBe(200);
    expect(executed.body.outcome.status).toBe('succeeded');
    expect(executed.body.run.status).toBe('succeeded');

    const events = await api(`/v1/runs/${runId}/events`);
    const types = events.body.events.map((event: { type: string }) => event.type);
    expect(types).toContain('step.started');
    expect(types).toContain('run.finished');

    const detail = await api(`/v1/runs/${runId}`);
    expect(detail.body.steps).toHaveLength(1);
    expect(detail.body.steps[0].status).toBe('succeeded');
  });

  it('executes a tool call that writes a real file', async () => {
    const created = await api('/v1/projects', { method: 'POST', body: JSON.stringify({ title: 'R2' }) });
    const projectId = created.body.project.id as string;
    const run = await api(`/v1/projects/${projectId}/runs`, {
      method: 'POST',
      body: JSON.stringify({ message: '写文件' }),
    });
    const runId = run.body.run.id as string;

    upstream.script([
      { tool: { id: 'c1', name: 'fs.write', args: { path: 'out/daemon.md', text: '来自 daemon 的正文' } } },
      { text: '写完了' },
    ]);

    const executed = await api(`/v1/runs/${runId}/execute`, {
      method: 'POST',
      body: JSON.stringify({ message: '写文件' }),
    });

    expect(executed.body.outcome.status).toBe('succeeded');
    expect(readFileSync(join(workspace, 'project', 'out', 'daemon.md'), 'utf8')).toBe('来自 daemon 的正文');

    const audit = await api('/v1/audit');
    expect(audit.body.records.some((record: { tool: string; ok: boolean }) => record.tool === 'fs.write' && record.ok)).toBe(true);
  });

  it('parks a destructive tool behind an approval and can approve it', async () => {
    const created = await api('/v1/projects', { method: 'POST', body: JSON.stringify({ title: 'R3' }) });
    const projectId = created.body.project.id as string;
    const run = await api(`/v1/projects/${projectId}/runs`, {
      method: 'POST',
      body: JSON.stringify({ message: '删文件', agentId: 'editor' }),
    });
    const runId = run.body.run.id as string;

    upstream.script([{ tool: { id: 'c1', name: 'fs.delete', args: { path: 'ref.md' } } }]);

    const executed = await api(`/v1/runs/${runId}/execute`, {
      method: 'POST',
      body: JSON.stringify({ message: '删文件', agentId: 'editor' }),
    });

    expect(executed.body.outcome.status).toBe('waiting_approval');
    expect(executed.body.run.status).toBe('waiting_approval');

    const pending = await api('/v1/approvals?status=pending');
    const approval = pending.body.approvals.find((item: { runId: string }) => item.runId === runId);
    expect(approval).toBeDefined();
    expect(approval.kind).toBe('delete');

    // File still exists because nothing executed.
    expect(readFileSync(join(workspace, 'project', 'ref.md'), 'utf8')).toBe('参考资料 X');

    const decided = await api(`/v1/approvals/${approval.id}`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approved' }),
    });
    expect(decided.status).toBe(200);
    expect(decided.body.approval.decision).toBe('approved');

    const twice = await api(`/v1/approvals/${approval.id}`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approved' }),
    });
    expect(twice.status).toBe(409);
  });

  it('rejects an unknown agent before touching the model', async () => {
    const created = await api('/v1/projects', { method: 'POST', body: JSON.stringify({ title: 'R4' }) });
    const projectId = created.body.project.id as string;
    const { status } = await api(`/v1/projects/${projectId}/runs`, {
      method: 'POST',
      body: JSON.stringify({ message: 'x', agentId: 'not-an-agent' }),
    });
    expect(status).toBe(400);
  });

  it('returns 404 for a missing run', async () => {
    const { status } = await api('/v1/runs/does-not-exist');
    expect(status).toBe(404);
  });
});
