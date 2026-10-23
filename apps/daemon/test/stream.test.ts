import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ModelGateway } from '@creator-studio/model-gateway';
import { createDaemon, type Daemon } from '../src/server.js';

let workspace: string;
let daemon: Daemon;
let baseUrl: string;

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'sse-ws-'));
  writeFileSync(join(workspace, 'ref.md'), 'x');

  const gateway = new ModelGateway({
    profiles: [
      {
        id: 'm1',
        userId: 'local-user',
        name: 'stub',
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1/v1',
        model: 'stub',
        apiKeyRef: 'keychain:stub',
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
    workspaceRoot: workspace,
    deviceId: 'd1',
    modelGateway: gateway,
  });
  await daemon.app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(daemon.app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await daemon.close();
  rmSync(workspace, { recursive: true, force: true });
});

async function createProjectWithRun(): Promise<{ projectId: string; runId: string }> {
  const projectResponse = await fetch(`${baseUrl}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: `SSE ${Math.random().toString(36).slice(2, 8)}` }),
  });
  const project = (await projectResponse.json()) as { project: { id: string } };

  const runResponse = await fetch(`${baseUrl}/v1/projects/${project.project.id}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'hi', agentId: 'scriptwriter' }),
  });
  const run = (await runResponse.json()) as { run: { id: string } };
  return { projectId: project.project.id, runId: run.run.id };
}

const iso = '2026-10-21T10:00:00.000Z';

function seedEvents(runId: string, count: number): void {
  const db = daemon.db;
  for (let index = 0; index < count; index += 1) {
    db.prepare('INSERT INTO run_events (id, run_id, seq, type, payload, ts) VALUES (?, ?, ?, ?, ?, ?)').run(
      `${runId}_e${index}`,
      runId,
      index,
      'step.started',
      '{}',
      iso,
    );
  }
}

type ParsedEvent = { type: string; data: { seq: number; runId: string } };

async function readStream(
  url: string,
  opts: { stopAfter: number; onOpen?: () => Promise<void> | void },
): Promise<ParsedEvent[]> {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal, headers: { accept: 'text/event-stream' } });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: ParsedEvent[] = [];
  let buffer = '';

  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    while (events.length < opts.stopAfter) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const typeLine = block.split('\n').find((line) => line.startsWith('event: '));
        const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
        if (typeLine !== undefined && dataLine !== undefined) {
          events.push({
            type: typeLine.slice(7),
            data: JSON.parse(dataLine.slice(6)) as { seq: number; runId: string },
          });
        }
        boundary = buffer.indexOf('\n\n');
      }
      if (events.length >= opts.stopAfter) break;
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return events;
}

describe('R1 replay on subscribe', () => {
  it('replays persisted events in ascending order', async () => {
    const { runId } = await createProjectWithRun();
    seedEvents(runId, 3);

    const events = await readStream(`${baseUrl}/v1/runs/${runId}/stream`, { stopAfter: 3 });
    expect(events.map((event) => event.data.seq)).toEqual([0, 1, 2]);
    expect(events.every((event) => event.data.runId === runId)).toBe(true);
  });
});

describe('R4 after cursor', () => {
  it('skips events at or below the cursor', async () => {
    const { runId } = await createProjectWithRun();
    seedEvents(runId, 4);

    const events = await readStream(`${baseUrl}/v1/runs/${runId}/stream?after=1`, { stopAfter: 2 });
    expect(events.map((event) => event.data.seq)).toEqual([2, 3]);
  });

  it('rejects a non-numeric cursor', async () => {
    const { runId } = await createProjectWithRun();
    const response = await fetch(`${baseUrl}/v1/runs/${runId}/stream?after=nope`);
    expect(response.status).toBe(400);
  });
});

describe('R2 live push', () => {
  it('delivers events produced by a real run after subscription', async () => {
    const { runId } = await createProjectWithRun();

    const received: ParsedEvent[] = [];
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/v1/runs/${runId}/stream`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let resolveLive: (value: ParsedEvent) => void = () => {};
    const live = new Promise<ParsedEvent>((resolve) => {
      resolveLive = resolve;
    });

    const pump = (async () => {
      while (received.length < 6) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const typeLine = block.split('\n').find((l) => l.startsWith('event: '));
          const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
          if (typeLine !== undefined && dataLine !== undefined) {
            const parsed = {
              type: typeLine.slice(7),
              data: JSON.parse(dataLine.slice(6)) as { seq: number; runId: string },
            };
            received.push(parsed);
            resolveLive(parsed);
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 250));
    const execute = await fetch(`${baseUrl}/v1/runs/${runId}/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'trigger' }),
    });
    expect(execute.status).toBe(200);

    const pushed = await Promise.race([
      live,
      new Promise<ParsedEvent>((_, reject) => setTimeout(() => reject(new Error('live event timed out')), 4000)),
    ]);

    expect(['step.started', 'error']).toContain(pushed.type);
    expect(pushed.data.runId).toBe(runId);

    controller.abort();
    await pump.catch(() => {});
    expect(received.length).toBeGreaterThan(0);
  });
});

describe('R3 disconnect cleanup', () => {
  it('ends the stream cleanly when the client aborts', async () => {
    const { runId } = await createProjectWithRun();
    seedEvents(runId, 1);
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/v1/runs/${runId}/stream`, { signal: controller.signal });
    expect(response.status).toBe(200);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 120));

    // A second subscription on the same run must still work.
    const events = await readStream(`${baseUrl}/v1/runs/${runId}/stream`, { stopAfter: 1 });
    expect(events).toHaveLength(1);
  });

  it('returns 404 for a missing run', async () => {
    const response = await fetch(`${baseUrl}/v1/runs/nope/stream`);
    expect(response.status).toBe(404);
  });
});

describe('CORS on the hijacked SSE response', () => {
  it('echoes an allowed tauri origin', async () => {
    const { runId } = await createProjectWithRun();
    seedEvents(runId, 1);
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/v1/runs/${runId}/stream`, {
      headers: { origin: 'http://tauri.localhost' },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://tauri.localhost');
    controller.abort();
  });

  it('omits the header for a foreign origin', async () => {
    const { runId } = await createProjectWithRun();
    seedEvents(runId, 1);
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/v1/runs/${runId}/stream`, {
      headers: { origin: 'http://evil.example' },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    controller.abort();
  });
});

describe('SSE event naming', () => {
  it('renames the domain error event so it cannot be confused with a transport failure', async () => {
    const { runId } = await createProjectWithRun();
    const db = daemon.db;
    db.prepare('INSERT INTO run_events (id, run_id, seq, type, payload, ts) VALUES (?, ?, ?, ?, ?, ?)').run(
      `${runId}_e0`,
      runId,
      0,
      'error',
      '{"code":"MODEL_AUTH"}',
      iso,
    );

    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/v1/runs/${runId}/stream`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let found = '';

    while (found === '') {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const match = /event: (\S+)/.exec(buffer);
      if (match !== null) found = match[1] ?? '';
    }
    controller.abort();
    expect(found).toBe('run.error');
  });
});
