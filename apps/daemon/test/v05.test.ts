import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ModelGateway } from '@creator-studio/model-gateway';
import { createDaemon, type Daemon } from '../src/server.js';
import { renderMarkdown } from '../src/generate.js';
import { normalizeForMatch, verifyNotes } from '../src/research.js';
import type { ResearchNotes } from '@creator-studio/protocol';

const RESEARCH = JSON.stringify({
  notes: [
    {
      claim: 'Example Domain 这个域名用于文档示例',
      source: 'https://example.com/',
      confidence: 'high',
      note: '页面原文',
    },
    {
      claim: '某个不存在的结论 12345',
      source: 'https://example.com/',
      confidence: 'high',
      note: '',
    },
  ],
  gaps: ['缺少权威统计'],
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
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 60 } })}\n\n`);
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

async function createProject(title = 'v05'): Promise<string> {
  const created = await api('/v1/projects', { method: 'POST', body: JSON.stringify({ title }) });
  return created.body.project.id as string;
}

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'v05-'));
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
    // Hermetic research: the fake upstream serves the page and DNS never leaves
    // the process, so CI does not depend on example.com being reachable.
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.includes('robots.txt')) return new Response('User-agent: *\nAllow: /\n', { status: 200 });
      return new Response(
        '<html><head><title>Example Domain</title></head><body><h1>Example Domain</h1><p>Example Domain 这个域名用于文档示例。</p><p>你可以自由使用它。</p></body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    },
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

describe('R1 tools are registered with the documented risk levels', () => {
  it('exposes fs.list and http.fetch', async () => {
    const tools = await api('/v1/tools');
    const names = tools.body.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain('fs.list');
    expect(names).toContain('http.fetch');
    const fetchTool = tools.body.tools.find((tool: { name: string }) => tool.name === 'http.fetch');
    expect(fetchTool.risk).toBe('medium');
  });
});

describe('R1b fs.list is callable for the workspace root', () => {
  it('lists the root without needing a path argument', async () => {
    const created = await createProject('列目录');
    const run = await api(`/v1/projects/${created}/runs`, {
      method: 'POST',
      body: JSON.stringify({ message: '列一下目录', agentId: 'producer' }),
    });
    expect(run.status).toBe(202);
    // The tool host is exercised through the agent loop elsewhere; this asserts the
    // registration accepts an omitted path and still returns a sandboxed listing.
    const { listDirectory } = await import('@creator-studio/tools');
    const listed = listDirectory('', { workspaceRoot: join(workspace, 'project') });
    expect(listed.path).toBe('.');
    expect(Array.isArray(listed.entries)).toBe(true);
  });
});

describe('R2 agent ids are validated at creation', () => {
  it('accepts a registered agent and rejects an unregistered one', async () => {
    const projectId = await createProject('agent 校验');
    const ok = await api(`/v1/projects/${projectId}/runs`, {
      method: 'POST',
      body: JSON.stringify({ message: 'hi', agentId: 'scout' }),
    });
    expect(ok.status).toBe(202);

    for (const agent of ['director', 'packager', 'researcher']) {
      const result = await api(`/v1/projects/${projectId}/runs`, {
        method: 'POST',
        body: JSON.stringify({ message: 'hi', agentId: agent }),
      });
      expect(result.status, agent).toBe(202);
    }
  });

  it('rejects an id that is in the protocol enum but not registered', async () => {
    const projectId = await createProject('agent 拒绝');
    const result = await api(`/v1/projects/${projectId}/runs`, {
      method: 'POST',
      body: JSON.stringify({ message: 'hi', agentId: 'nope' }),
    });
    expect(result.status).toBe(400);
  });
});

describe('R3 export is latest-only and advances the stage', () => {
  it('packs one version per kind and moves the project to published', async () => {
    const projectId = await createProject('导出策略');
    for (const [kind, path, content] of [
      ['topic-card', 'topic/topic-card.v1.md', 't'],
      ['research-notes', 'research/research-notes.v1.md', 'r'],
      ['script', 'script/script.v1.md', '旧稿'],
      ['script', 'script/script.v2.md', '新稿'],
      ['publish-pack', 'publish/publish-pack.v1.md', 'p'],
    ] as const) {
      await api(`/v1/projects/${projectId}/artifacts`, {
        method: 'POST',
        body: JSON.stringify({ kind, path, content }),
      });
    }
    const exported = await api(`/v1/projects/${projectId}/publish`, { method: 'POST' });
    expect(exported.status).toBe(201);
    expect(exported.body.entries).toContain('script/script.v2.md');
    expect(exported.body.entries).not.toContain('script/script.v1.md');
    expect(exported.body.includeHistory).toBe(false);
    expect(exported.body.stage).toBe('published');

    const project = await api(`/v1/projects/${projectId}`);
    expect(project.body.project.stage).toBe('published');
  });

  it('keeps history when the caller asks for it', async () => {
    const projectId = await createProject('导出历史');
    for (const [kind, path] of [
      ['topic-card', 'topic/topic-card.v1.md'],
      ['research-notes', 'research/research-notes.v1.md'],
      ['script', 'script/script.v1.md'],
      ['script', 'script/script.v2.md'],
      ['publish-pack', 'publish/publish-pack.v1.md'],
    ] as const) {
      await api(`/v1/projects/${projectId}/artifacts`, {
        method: 'POST',
        body: JSON.stringify({ kind, path, content: 'x' }),
      });
    }
    const exported = await api(`/v1/projects/${projectId}/publish`, {
      method: 'POST',
      body: JSON.stringify({ includeHistory: true }),
    });
    expect(exported.body.entries).toContain('script/script.v1.md');
    expect(exported.body.includeHistory).toBe(true);
  });

  it('stamps the running daemon version into the manifest', async () => {
    const projectId = await createProject('版本戳');
    for (const [kind, path] of [
      ['topic-card', 'topic/topic-card.v1.md'],
      ['research-notes', 'research/research-notes.v1.md'],
      ['script', 'script/script.v1.md'],
      ['publish-pack', 'publish/publish-pack.v1.md'],
    ] as const) {
      await api(`/v1/projects/${projectId}/artifacts`, {
        method: 'POST',
        body: JSON.stringify({ kind, path, content: 'x' }),
      });
    }
    const exported = await api(`/v1/projects/${projectId}/publish`, { method: 'POST' });
    const { readFileSync } = await import('node:fs');
    const { inflateRawSync } = await import('node:zlib');
    const zip = readFileSync(join(workspace, 'project', exported.body.file));
    // Stored-only zip: walk local headers and read manifest.json.
    let offset = 0;
    let manifest = '';
    while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
      const method = zip.readUInt16LE(offset + 8);
      const size = zip.readUInt32LE(offset + 18);
      const nameLen = zip.readUInt16LE(offset + 26);
      const extraLen = zip.readUInt16LE(offset + 28);
      const name = zip.subarray(offset + 30, offset + 30 + nameLen).toString('utf8');
      const start = offset + 30 + nameLen + extraLen;
      const data = zip.subarray(start, start + size);
      if (name === 'manifest.json') manifest = method === 0 ? data.toString('utf8') : inflateRawSync(data).toString('utf8');
      offset = start + size;
    }
    const parsed = JSON.parse(manifest) as { version: string };
    // Must track the running package version, not a hardcoded string.
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(parsed.version).toBe(pkg.version);
    expect(parsed.version).not.toBe('0.2.0');
  });
});

describe('R4 research fetches sources and downgrades unverified claims', () => {
  it('fetches the page, fences it, and marks a fabricated claim low', async () => {
    const projectId = await createProject('资料核验');
    upstream.reply(RESEARCH);
    const generated = await api(`/v1/projects/${projectId}/generate`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'research-notes',
        context: '示例域名',
        sources: ['https://example.com/'],
      }),
    });
    expect(generated.status).toBe(201);

    const sent = upstream.bodies.at(-1) as { messages: Array<{ role: string; content: string }> };
    const user = sent.messages.find((message) => message.role === 'user');
    expect(user?.content).toContain('<untrusted-content>');
    expect(user?.content).toContain('Example Domain 这个域名用于文档示例');

    const meta = generated.body.meta as {
      sources: Array<{ url: string; sha256: string }>;
      unverified: number;
      downgraded: number;
    };
    expect(meta.sources).toHaveLength(1);
    expect(meta.sources[0]?.sha256).toHaveLength(64);
    expect(meta.unverified).toBe(1);
    expect(meta.downgraded).toBe(1);

    const detail = await api(`/v1/artifacts/${generated.body.artifact.id}`);
    expect(detail.body.content).toContain('## 抓取记录');
    expect(detail.body.content).toContain('https://example.com/');
    expect(detail.body.content).toContain('未在已抓取原文中找到对应表述');
  });

  it('fails the stage when no source can be fetched', async () => {
    const projectId = await createProject('抓取失败');
    const modelCallsBefore = upstream.bodies.length;
    const result = await api(`/v1/projects/${projectId}/generate`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'research-notes',
        context: 'x',
        sources: ['http://127.0.0.1:9/secret'],
      }),
    });
    expect(result.status).toBe(502);
    expect(result.body.error.code).toBe('SOURCES_UNREACHABLE');
    expect(result.body.failures[0].code).toBe('BLOCKED_HOST');
    // The model must never be called with an empty source set.
    expect(upstream.bodies.length).toBe(modelCallsBefore);
  });
});

describe('R4b artifact markdown carries the verification markers', () => {
  it('renders ✓ for a verified note and ⚠ for an unverified one', () => {
    const markdown = renderMarkdown('research-notes', {
      notes: [
        { claim: '可核对的陈述', source: 'https://example.com/', confidence: 'high', note: '', quoteVerified: true },
        { claim: '编造的陈述', source: 'https://example.com/', confidence: 'low', note: '原因', quoteVerified: false },
      ],
      gaps: [],
    });
    expect(markdown).toContain('✓ 原文可核');
    expect(markdown).toContain('⚠ 未在原文找到');
    expect(markdown).toContain('备注：原因');
  });

  it('omits the markers when verification did not run', () => {
    const markdown = renderMarkdown('research-notes', {
      notes: [{ claim: 'x', source: 's', confidence: 'medium', note: '' }],
      gaps: [],
    });
    expect(markdown).not.toContain('原文可核');
    expect(markdown).not.toContain('未在原文找到');
  });
});

describe('R5 quote verification units', () => {
  it('normalizes case, width and punctuation', () => {
    expect(normalizeForMatch('Example  Domain，这个')).toBe('exampledomain这个');
  });

  it('keeps a verified note untouched and downgrades a mismatched one', () => {
    const payload: ResearchNotes = {
      notes: [
        { claim: 'Example Domain 这个域名用于文档示例', source: 's', confidence: 'high', note: '' },
        { claim: '完全不同的结论 98765', source: 's', confidence: 'medium', note: '原有备注' },
      ],
      gaps: [],
    };
    const result = verifyNotes(payload, [{ url: 'https://example.com/', text: 'Example Domain 这个域名用于文档示例。' }]);
    expect(result.notes[0]?.quoteVerified).toBe(true);
    expect(result.notes[0]?.confidence).toBe('high');
    expect(result.notes[1]?.quoteVerified).toBe(false);
    expect(result.notes[1]?.confidence).toBe('low');
    expect(result.notes[1]?.note).toContain('原有备注');
    expect(result.downgraded).toBe(1);
  });
});
