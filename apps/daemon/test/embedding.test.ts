import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ModelGateway } from '@creator-studio/model-gateway';
import { createDaemon, type Daemon } from '../src/server.js';

/**
 * A provider that serves both `/chat/completions` (SSE) and `/embeddings`.
 * The embedding is a tiny hand-built concept vector so the test can assert the
 * *neural* path is used without depending on a real vendor.
 */
class BilingualUpstream {
  private server = createServer((req, res) => void this.handle(req, res));
  port = 0;
  embeddingCalls = 0;

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())));
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
      input?: string | string[];
    };

    if ((req.url ?? '').endsWith('/embeddings')) {
      this.embeddingCalls += 1;
      const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ''];
      const data = inputs.map((text, index) => ({ index, embedding: conceptVector(text) }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data }));
      return;
    }

    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const payload = JSON.stringify({
      cards: [
        {
          title: 'AI 与初级岗位',
          angle: '数据角度',
          scores: { demand: 80, competition: 40, differentiation: 70, speakability: 75 },
          composite: 74,
          rationale: '需求上升',
          risks: [],
        },
      ],
    });
    for (const piece of [payload.slice(0, 40), payload.slice(40)]) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  }
}

/**
 * Two dimensions: "jobs/employment" vs "finance". Text mentioning employment maps
 * to [1, 0]; finance to [0, 1]. That makes a paraphrase query ("求职") match a
 * document about "招聘" even though they share no substring.
 */
function conceptVector(text: string): number[] {
  const jobs = /(求职|就业|招聘|工作|岗位|程序员|job|hire|employ)/i.test(text) ? 1 : 0;
  const finance = /(财政|土地|基金|finance|budget)/i.test(text) ? 1 : 0;
  if (jobs === 0 && finance === 0) return [0.01, 0.01];
  return [jobs, finance];
}

let workspace: string;
let upstream: BilingualUpstream;
let daemon: Daemon;
let baseUrl: string;

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'embed-ws-'));
  upstream = new BilingualUpstream();
  await upstream.start();

  const gateway = new ModelGateway({
    profiles: [
      {
        id: 'm-embed',
        userId: 'local-user',
        name: 'with-embeddings',
        provider: 'openai-compatible',
        baseUrl: upstream.baseUrl,
        model: 'fake-chat',
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
    scheduler: false,
    remoteEmbeddings: true,
  });
  await daemon.app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(daemon.app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await daemon.close();
  await upstream.stop();
  rmSync(workspace, { recursive: true, force: true });
});

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
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

describe('R11 neural embedding path', () => {
  it('switches to the remote embedder when the provider serves /embeddings', async () => {
    const created = await api('/v1/projects', { method: 'POST', body: JSON.stringify({ title: '向量' }) });
    const projectId = created.body.project.id as string;
    await api(`/v1/projects/${projectId}/artifacts`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'research-notes',
        path: 'research/r.md',
        content: '招聘岗位数量与程序员薪资的历史变化。',
      }),
    });

    const status = await api('/v1/settings/embedding');
    expect(status.body.mode).toBe('neural');
    expect(status.body.neural).toBe(true);
    expect(status.body.active).toBe('remote');
    expect(upstream.embeddingCalls).toBeGreaterThan(0);
  });

  it('finds a paraphrase that shares no literal substring', async () => {
    const created = await api('/v1/projects', { method: 'POST', body: JSON.stringify({ title: '语义' }) });
    const projectId = created.body.project.id as string;
    await api(`/v1/projects/${projectId}/artifacts`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'script',
        path: 'script/s.md',
        content: '招聘岗位数量与程序员薪资的历史变化。',
      }),
    });

    // "求职" is not a substring of the document; only the embedding can match it.
    const found = await api(`/v1/memory/search?q=${encodeURIComponent('求职')}&projectId=${projectId}`);
    expect(found.status).toBe(200);
    expect(found.body.neural).toBe(true);
    expect(found.body.hits.length).toBeGreaterThan(0);
    expect(found.body.hits[0].via === 'vector' || found.body.hits[0].via === 'hybrid').toBe(true);
  });
});
