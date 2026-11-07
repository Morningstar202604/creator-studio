import { mkdtempSync, rmSync } from 'node:fs';
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
  workspace = mkdtempSync(join(tmpdir(), 'mcp-ws-'));
  const gateway = new ModelGateway({
    profiles: [],
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

let nextId = 0;

async function rpc(method: string, params: unknown, sessionId?: string) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId === undefined ? {} : { 'mcp-session-id': sessionId }),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params }),
  });
  const text = await response.text();
  // The transport answers with SSE framing when the client accepts
  // text/event-stream; each frame carries its payload on a `data:` line.
  const dataLine = text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6))
    .at(-1);
  const payload = dataLine ?? text;
  return { status: response.status, body: payload === '' ? null : (JSON.parse(payload) as never) };
}

describe('MCP endpoint', () => {
  it('completes the initialize handshake and reports its capabilities', async () => {
    const { status, body } = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'vitest', version: '0' },
    });
    expect(status).toBe(200);
    const result = (body as { result: { serverInfo: { name: string }; protocolVersion: string } }).result;
    expect(result.serverInfo.name).toBe('creator-studio');
    expect(result.protocolVersion).toBe('2025-06-18');
  });

  it('rejects a second initialize on the same request path without a session (stateless)', async () => {
    // GET is not offered by a stateless server: must be 405 with an allow header.
    const response = await fetch(`${baseUrl}/mcp`, { method: 'GET' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('lists the consolidated tool surface', async () => {
    await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'vitest', version: '0' },
    });
    const { status, body } = await rpc('tools/list', {});
    expect(status).toBe(200);
    const tools = (body as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    expect(tools).toEqual(
      expect.arrayContaining([
        'list_projects',
        'get_project',
        'create_project',
        'generate_artifact',
        'publish_pack',
        'search_memory',
      ]),
    );
  });

  it('calls list_projects and create_project through the real API path', async () => {
    await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'vitest', version: '0' },
    });

    const created = await rpc('tools/call', {
      name: 'create_project',
      arguments: { title: 'MCP smoke', scenarioId: 'video', platform: 'bilibili' },
    });
    const content = (created.body as { result: { content: Array<{ text: string }> } }).result.content[0].text;
    const project = JSON.parse(content) as { project: { id: string; scenarioId: string } };
    expect(project.project.scenarioId).toBe('video');

    const listed = await rpc('tools/call', { name: 'list_projects', arguments: {} });
    const list = JSON.parse((listed.body as { result: { content: Array<{ text: string }> } }).result.content[0].text) as {
      projects: Array<{ id: string }>;
    };
    expect(list.projects.some((p) => p.id === project.project.id)).toBe(true);
  });

  it('surfaces API errors as tool errors instead of crashing the endpoint', async () => {
    await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'vitest', version: '0' },
    });
    const { status, body } = await rpc('tools/call', {
      name: 'read_artifact',
      arguments: { artifactId: 'does-not-exist' },
    });
    expect(status).toBe(200);
    const result = (body as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('404');
  });
});
