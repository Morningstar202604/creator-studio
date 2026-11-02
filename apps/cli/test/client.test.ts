import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiError, DaemonClient } from '../src/client.js';

type Handler = (req: IncomingMessage, body: string) => { status: number; body: unknown };

let server: ReturnType<typeof createServer>;
let baseUrl: string;
const calls: Array<{ method: string; url: string; body: string }> = [];
let handler: Handler = () => ({ status: 200, body: {} });

beforeAll(async () => {
  server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString('utf8');
      calls.push({ method: req.method ?? 'GET', url: req.url ?? '/', body });
      const result = handler(req, body);
      const payload = JSON.stringify(result.body);
      res.writeHead(result.status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
      });
      res.end(payload);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function client(): DaemonClient {
  return new DaemonClient({ baseUrl });
}

describe('CLI client contract', () => {
  it('sends POST bodies as JSON and parses responses', async () => {
    handler = (_req, body) => {
      const parsed = JSON.parse(body) as { title: string };
      return {
        status: 201,
        body: {
          project: {
            id: 'p1',
            title: parsed.title,
            platform: 'bilibili',
            stage: 'topic',
            description: '',
            tags: [],
            createdAt: '',
            updatedAt: '',
          },
        },
      };
    };
    const result = await client().createProject({ title: '测试' });
    expect(result.project.title).toBe('测试');
    const call = calls.at(-1);
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe('/v1/projects');
  });

  it('does not send a content-type header on GET', async () => {
    handler = () => ({ status: 200, body: { ok: true, capabilities: ['runs'], workspaceRoot: '/w', apiVersion: 3 } });
    const health = await client().health();
    expect(health.apiVersion).toBe(3);
    expect(calls.at(-1)?.method).toBe('GET');
  });

  it('maps error envelopes to ApiError with the daemon code', async () => {
    handler = () => ({ status: 409, body: { error: { code: 'CHECKLIST_INCOMPLETE', message: 'missing script' } } });
    await expect(client().publish('p1')).rejects.toMatchObject({
      name: 'ApiError',
      code: 'CHECKLIST_INCOMPLETE',
      status: 409,
    });
  });

  it('posts an empty body when no script version is pinned for subtitle export', async () => {
    handler = () => ({ status: 201, body: { artifact: { id: 's1', path: 'subtitle/subtitle.v1.srt' }, cues: 12 } });
    const result = await client().subtitle('p1');
    expect(result.cues).toBe(12);
    const call = calls.at(-1);
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe('/v1/projects/p1/subtitle');
    expect(JSON.parse(call?.body ?? '{}')).toEqual({});
  });

  it('pins a specific script version for subtitle export', async () => {
    handler = () => ({ status: 201, body: { artifact: { id: 's2', path: 'subtitle/subtitle.v2.srt' }, cues: 9 } });
    await client().subtitle('p1', 'a1');
    expect(JSON.parse(calls.at(-1)?.body ?? '{}')).toEqual({ scriptArtifactId: 'a1' });
  });

  it('posts to the review endpoint and returns the report artifact', async () => {
    handler = () => ({
      status: 201,
      body: { artifact: { id: 'r1', path: 'review/review-report.v1.md' }, runId: 'run-1' },
    });
    const result = await client().review('p1');
    expect(result.artifact.path).toBe('review/review-report.v1.md');
    expect(calls.at(-1)?.url).toBe('/v1/projects/p1/review');
  });

  it('asks for history only when the flag is set', async () => {
    handler = () => ({ status: 201, body: { file: 'x.zip', absolutePath: 'x.zip', bytes: 1, entries: [], stage: 'published' } });
    await client().publish('p1');
    expect(JSON.parse(calls.at(-1)?.body ?? '{}')).toEqual({});
    await client().publish('p1', { includeHistory: true });
    expect(JSON.parse(calls.at(-1)?.body ?? '{}')).toEqual({ includeHistory: true });
  });

  it('creates a style profile with only the fields that were supplied', async () => {
    handler = () => ({ status: 201, body: { style: { id: 'st1', name: '理性分析' } } });
    const result = await client().saveStyle({ name: '理性分析', bannedWords: ['赋能'] });
    expect(result.style.id).toBe('st1');
    expect(JSON.parse(calls.at(-1)?.body ?? '{}')).toEqual({ name: '理性分析', bannedWords: ['赋能'] });
  });

  it('reports DAEMON_UNREACHABLE when the socket is closed', async () => {
    const dead = new DaemonClient({ baseUrl: 'http://127.0.0.1:1' });
    const error = await dead.health().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('DAEMON_UNREACHABLE');
  });

  it('treats a non-JSON body as BAD_RESPONSE instead of throwing', async () => {
    const raw = createServer((_req, res) => {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('gateway exploded');
    });
    await new Promise<void>((resolve) => raw.listen(0, '127.0.0.1', resolve));
    const port = (raw.address() as AddressInfo).port;
    const error = await new DaemonClient({ baseUrl: `http://127.0.0.1:${port}` })
      .health()
      .catch((cause: unknown) => cause);
    await new Promise<void>((resolve) => raw.close(() => resolve()));
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('BAD_RESPONSE');
  });
});
