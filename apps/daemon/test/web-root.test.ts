import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ModelGateway } from '@creator-studio/model-gateway';
import { createDaemon, type Daemon } from '../src/server.js';

/**
 * The installed app must serve the UI from the staged runtime.
 *
 * Regression: the packaged layout puts the bundle at `daemon-runtime/dist/web`,
 * but the lookup only knew the repo layout and a `web/` sibling — so a user who
 * installed the exe and opened http://127.0.0.1:7878 got a 404. The desktop
 * shell hides this because it loads its own assets; the web entry point is the
 * one that breaks.
 */

let workspace: string;
let daemon: Daemon;
let baseUrl: string;

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'webroot-'));
  const webRoot = join(workspace, 'webroot');
  mkdirSync(webRoot, { recursive: true });
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>稿台</title><div id="root"></div>');
  writeFileSync(join(webRoot, 'app.js'), 'console.log("ui")');

  const unreachable = createServer();
  await new Promise<void>((resolve) => unreachable.listen(0, '127.0.0.1', resolve));
  const port = (unreachable.address() as AddressInfo).port;
  await new Promise<void>((resolve) => unreachable.close(() => resolve()));

  const gateway = new ModelGateway({
    profiles: [
      {
        id: 'm1',
        userId: 'u',
        name: 'stub',
        provider: 'openai-compatible',
        baseUrl: `http://127.0.0.1:${port}/v1`,
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
    webRoot,
  });
  await daemon.app.listen({ port: 0, host: '127.0.0.1' });
  const address = daemon.app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await daemon.close();
  rmSync(workspace, { recursive: true, force: true });
});

describe('R1 the web entry point serves the built UI', () => {
  it('returns index.html at the root', async () => {
    const response = await fetch(baseUrl + '/');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('<div id="root">');
  });

  it('serves a real asset from the bundle', async () => {
    const response = await fetch(baseUrl + '/app.js');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('console.log');
  });

  it('falls back to index.html for a hash-router deep link', async () => {
    // Hash routes never reach the server, but a pasted path should not 404 either.
    const response = await fetch(baseUrl + '/settings');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<div id="root">');
  });

  it('still answers API 404s as JSON, not as the SPA', async () => {
    const response = await fetch(baseUrl + '/v1/nope');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
  });
});
