import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ModelGateway } from '@creator-studio/model-gateway';
import { createDaemon, type Daemon } from '../src/server.js';

let workspace: string;
let daemon: Daemon;
let baseUrl: string;
let projectId: string;

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'script-ws-'));

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
    workspaceRoot: join(workspace, 'project'),
    deviceId: 'd1',
    modelGateway: gateway,
  });
  await daemon.app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(daemon.app.server.address() as AddressInfo).port}`;

  const created = await fetch(`${baseUrl}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '脚本页测试' }),
  });
  const body = (await created.json()) as { project: { id: string } };
  projectId = body.project.id;
});

afterAll(async () => {
  await daemon.close();
  rmSync(workspace, { recursive: true, force: true });
});

async function save(path: string, content: string): Promise<{ id: string; sha256: string }> {
  const response = await fetch(`${baseUrl}/v1/projects/${projectId}/artifacts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'script', path, content }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { artifact: { id: string; sha256: string } };
  return body.artifact;
}

describe('artifact routes', () => {
  it('saves a version and reads it back with matching content', async () => {
    const saved = await save('script/script.v1.md', '第一版正文');
    const response = await fetch(`${baseUrl}/v1/artifacts/${saved.id}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { artifact: { sha256: string }; content: string };
    expect(body.content).toBe('第一版正文');
    expect(body.artifact.sha256).toBe(saved.sha256);
    expect(readFileSync(join(workspace, 'project', 'projects', saved.projectId, 'script', 'script.v1.md'), 'utf8')).toBe('第一版正文');
  });

  it('keeps both versions in the project listing', async () => {
    await save('script/script.v2.md', '第二版正文');
    const response = await fetch(`${baseUrl}/v1/projects/${projectId}/artifacts`);
    const body = (await response.json()) as { artifacts: Array<{ path: string }> };
    const paths = body.artifacts.map((artifact) => artifact.path);
    expect(paths).toContain('script/script.v1.md');
    expect(paths).toContain('script/script.v2.md');
  });

  it('rejects a traversal path with PATH_ESCAPE', async () => {
    const response = await fetch(`${baseUrl}/v1/projects/${projectId}/artifacts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'script', path: '../../etc/passwd', content: 'x' }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PATH_ESCAPE');
  });

  it('returns 404 for an unknown artifact', async () => {
    const response = await fetch(`${baseUrl}/v1/artifacts/does-not-exist`);
    expect(response.status).toBe(404);
  });
});

describe('R4 rewrite failure handling', () => {
  it('returns MODEL_AUTH without touching stored artifacts when the model is unreachable', async () => {
    const before = await fetch(`${baseUrl}/v1/projects/${projectId}/artifacts`);
    const beforeBody = (await before.json()) as { artifacts: unknown[] };

    const response = await fetch(`${baseUrl}/v1/rewrite`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '这是一段需要改写的正文', instruction: '更口语' }),
    });
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: { code: string } };
    expect(['MODEL_NETWORK', 'MODEL_AUTH', 'MODEL_UNAVAILABLE']).toContain(body.error.code);

    const after = await fetch(`${baseUrl}/v1/projects/${projectId}/artifacts`);
    const afterBody = (await after.json()) as { artifacts: unknown[] };
    expect(afterBody.artifacts.length).toBe(beforeBody.artifacts.length);
  });

  it('rejects an empty rewrite request', async () => {
    const response = await fetch(`${baseUrl}/v1/rewrite`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    });
    expect(response.status).toBe(400);
  });
});
