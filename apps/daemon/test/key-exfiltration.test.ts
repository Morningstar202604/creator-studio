import { describe, expect, it } from 'vitest';

/**
 * Regression for two credential-exfiltration paths found in review:
 *
 * 1. A client could create a model profile with `apiKeyRef: 'env:PATH'` or
 *    `'vault:default'` and then call /test against its own baseUrl, receiving the
 *    environment variable or stored key as a Bearer token.
 * 2. A client could point a "remote" profile at a loopback or private address,
 *    turning the daemon into a courier for whatever key it holds.
 *
 * Both are checked at the settings API surface, so the tests drive that surface.
 */
import { createServer } from 'node:http';
import { createDaemon } from '../src/server.js';
import { ModelGateway } from '@creator-studio/model-gateway';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workspace = mkdtempSync(join(tmpdir(), 'cs-key-exfil-'));

async function boot() {
  const daemon = await createDaemon({
    dbPath: join(workspace, 'db.sqlite'),
    workspaceRoot: workspace,
    deviceId: 'dev-test',
    scheduler: false,
    modelGateway: new ModelGateway({ profiles: [] }),
    logger: false,
  });
  await daemon.app.listen({ port: 0, host: '127.0.0.1' });
  const address = daemon.app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  return { daemon, base };
}

async function post(base: string, path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

describe('model profile cannot be used to exfiltrate credentials', () => {
  it('refuses an apiKeyRef supplied by the client', async () => {
    const { daemon, base } = await boot();
    try {
      await post(base, '/v1/settings/models', {
        name: 'exfil',
        baseUrl: 'https://api.example.com/v1',
        model: 'gpt-4o-mini',
        apiKeyRef: 'env:PATH',
      });
      const list = await (await fetch(`${base}/v1/settings/models`)).json();
      const created = list.models.find((model: { name: string }) => model.name === 'exfil');
      // If the profile was created at all, its ref must not be the one we sent.
      if (created !== undefined) {
        expect(created.apiKeyRef).not.toBe('env:PATH');
      }
    } finally {
      await daemon.close();
    }
  });

  it('refuses a private baseUrl on a profile that is not declared local', async () => {
    const { daemon, base } = await boot();
    try {
      const res = await post(base, '/v1/settings/models', {
        name: 'internal',
        baseUrl: 'http://192.168.1.10:8080/v1',
        model: 'x',
      });
      expect(res.status).toBe(400);
    } finally {
      await daemon.close();
    }
  });

  it('allows a private baseUrl when the profile is declared local', async () => {
    const { daemon, base } = await boot();
    try {
      const res = await post(base, '/v1/settings/models', {
        name: 'ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'llama3',
        isLocal: true,
      });
      expect(res.status).toBe(201);
    } finally {
      await daemon.close();
    }
  });

  it('rejects a non-http scheme and embedded credentials', async () => {
    const { daemon, base } = await boot();
    try {
      expect((await post(base, '/v1/settings/models', { name: 'a', baseUrl: 'file:///etc/passwd', model: 'x' })).status).toBe(400);
      expect(
        (await post(base, '/v1/settings/models', { name: 'b', baseUrl: 'https://user:pass@api.example.com/v1', model: 'x' }))
          .status,
      ).toBe(400);
    } finally {
      await daemon.close();
    }
  });
});

// Keep the unused import out of the graph when the suite is skipped.
void createServer;
void rmSync;
