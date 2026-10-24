import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCloud, type CloudApp } from '../src/server.js';
import { TunnelRegistry } from '../src/tunnel.js';

let cloud: CloudApp;
let baseUrl: string;
let token = '';
let deviceId = '';

async function api(path: string, init?: RequestInit, auth = token) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(auth === '' ? {} : { authorization: `Bearer ${auth}` }),
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : (JSON.parse(text) as any) };
}

beforeAll(async () => {
  cloud = createCloud();
  const port = await cloud.listen(0);
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await cloud.close();
});

describe('pairing', () => {
  it('issues a 6-digit code', async () => {
    const { status, body } = await api('/v1/pair/start', { method: 'POST', body: JSON.stringify({ userId: 'u1' }) }, '');
    expect(status).toBe(201);
    expect(body.code).toMatch(/^\d{6}$/);
  });

  it('completes pairing and returns a device token', async () => {
    const start = await api('/v1/pair/start', { method: 'POST', body: JSON.stringify({ userId: 'u1' }) }, '');
    const done = await api(
      '/v1/pair/complete',
      {
        method: 'POST',
        body: JSON.stringify({ code: start.body.code, name: '本机', os: 'windows', capabilities: ['fs.read'] }),
      },
      '',
    );
    expect(done.status).toBe(201);
    expect(typeof done.body.token).toBe('string');
    token = done.body.token;
    deviceId = done.body.deviceId;
  });

  it('rejects a reused pairing code', async () => {
    const start = await api('/v1/pair/start', { method: 'POST', body: JSON.stringify({ userId: 'u1' }) }, '');
    await api('/v1/pair/complete', { method: 'POST', body: JSON.stringify({ code: start.body.code }) }, '');
    const again = await api('/v1/pair/complete', { method: 'POST', body: JSON.stringify({ code: start.body.code }) }, '');
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('PAIRING_INVALID');
  });

  it('rejects an expired code', async () => {
    const code = cloud.store.createPairingCode('u1', '', -1000);
    const response = await api('/v1/pair/complete', { method: 'POST', body: JSON.stringify({ code: code.code }) }, '');
    expect(response.status).toBe(400);
  });
});

describe('auth', () => {
  it('rejects a request without a token', async () => {
    const { status } = await api('/v1/me', {}, '');
    expect(status).toBe(401);
  });

  it('returns the device and plan for a valid token', async () => {
    expect(token).not.toBe('');
    const { status, body } = await api('/v1/me');
    expect(status).toBe(200);
    expect(body.deviceId).toBe(deviceId);
    expect(body.plan.priceCny).toBe(0);
  });

  it('rejects a revoked device', async () => {
    const created = cloud.store.createDevice({ userId: 'u2', name: 'x', os: 'linux', capabilities: [] });
    cloud.store.revokeDevice(created.device.id);
    const { status } = await api('/v1/me', {}, created.token);
    expect(status).toBe(401);
  });
});

describe('plan limits', () => {
  it('blocks runs once the free plan limit is hit', async () => {
    const { status, body } = await api('/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ projectId: 'p1', agentId: 'scriptwriter' }),
    });
    expect(status).toBe(402);
    expect(body.error.code).toBe('PLAN_LIMIT');
  });

  it('allows runs after upgrading', async () => {
    cloud.store.setPlan('u1', 'creator');
    const { status } = await api('/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ projectId: 'p1', agentId: 'scriptwriter' }),
    });
    expect(status).toBe(201);
  });

  it('counts runs in usage', async () => {
    const { body } = await api('/v1/usage');
    expect(body.runs).toBeGreaterThanOrEqual(1);
    expect(body.plan.monthlyRuns).toBe(30);
  });
});

describe('tunnel', () => {
  it('reports DEVICE_OFFLINE when no tunnel is attached', async () => {
    const { status, body } = await api('/v1/tool', {
      method: 'POST',
      body: JSON.stringify({ name: 'fs.read', args: { path: 'a.md' } }),
    });
    expect(status).toBe(409);
    expect(body.error.code).toBe('DEVICE_OFFLINE');
  });

  it('forwards a tool call to a connected device and returns its result', async () => {
    const port = Number.parseInt(baseUrl.split(':').pop() as string, 10);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/tunnel?deviceId=${deviceId}&token=${token}`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });

    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as { t: string; callId: string; name: string };
      if (frame.t !== 'tool.call') return;
      socket.send(
        JSON.stringify({
          t: 'tool.result',
          callId: frame.callId,
          ok: true,
          result: { echoed: frame.name, bytes: 42 },
        }),
      );
    });

    await new Promise((resolve) => setTimeout(resolve, 60));

    const { status, body } = await api('/v1/tool', {
      method: 'POST',
      body: JSON.stringify({ name: 'fs.read', args: { path: 'a.md' } }),
    });
    expect(status).toBe(200);
    expect(body.result).toEqual({ echoed: 'fs.read', bytes: 42 });

    socket.close();
  });

  it('rejects an in-flight call when the device reconnects with a new socket', async () => {
    // Register a device we control, then replace its tunnel while a call is pending.
    const created = cloud.store.createDevice({ userId: 'u3', name: 'reconnect', os: 'windows', capabilities: [] });
    const port = Number.parseInt(baseUrl.split(':').pop() as string, 10);
    const url = `ws://127.0.0.1:${port}/v1/tunnel?deviceId=${created.device.id}&token=${created.token}`;

    const first = new WebSocket(url);
    await new Promise<void>((resolve) => first.once('open', () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Start a call the device never answers. Attach the rejection handler before the
    // reconnect happens, otherwise the rejection lands with no listener.
    const pending = cloud.tunnel.call(
      created.device.id,
      { callId: 'call-pending', name: 'fs.read', args: {}, timeoutMs: 30_000 },
      30_000,
    );
    const expectation = expect(pending).rejects.toThrow(/DEVICE_RECONNECTED|DEVICE_OFFLINE/);

    // A second socket for the same device must evict the first and fail the call.
    const second = new WebSocket(url);
    await new Promise<void>((resolve) => second.once('open', () => resolve()));

    await expectation;
    expect(cloud.tunnel.isOnline(created.device.id)).toBe(true);

    first.close();
    second.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(cloud.tunnel.isOnline(created.device.id)).toBe(false);
  });
});

/** The server closes rejected tunnels after the handshake, so the client sees open → close. */
function waitForClose(socket: WebSocket, timeoutMs = 2_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`socket was not closed within ${timeoutMs}ms`)), timeoutMs);
    socket.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe('tunnel auth', () => {
  it('closes with 4001 when the token is missing', async () => {
    const port = Number.parseInt(baseUrl.split(':').pop() as string, 10);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/tunnel?deviceId=${deviceId}`);
    expect(await waitForClose(socket)).toBe(4001);
    expect(cloud.tunnel.isOnline(deviceId)).toBe(false);
  });

  it('closes with 4003 on an unknown token', async () => {
    const port = Number.parseInt(baseUrl.split(':').pop() as string, 10);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/tunnel?deviceId=${deviceId}&token=not-a-real-token`);
    expect(await waitForClose(socket)).toBe(4003);
    expect(cloud.tunnel.isOnline(deviceId)).toBe(false);
  });

  it('closes with 4003 when the token belongs to another device', async () => {
    const other = cloud.store.createDevice({ userId: 'u9', name: 'other', os: 'linux', capabilities: [] });
    const port = Number.parseInt(baseUrl.split(':').pop() as string, 10);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/tunnel?deviceId=${deviceId}&token=${other.token}`);
    expect(await waitForClose(socket)).toBe(4003);
    expect(cloud.tunnel.isOnline(deviceId)).toBe(false);
  });

  it('closes with 4003 when the device is revoked', async () => {
    const created = cloud.store.createDevice({ userId: 'u9', name: 'revoked', os: 'linux', capabilities: [] });
    cloud.store.revokeDevice(created.device.id);
    const port = Number.parseInt(baseUrl.split(':').pop() as string, 10);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/tunnel?deviceId=${created.device.id}&token=${created.token}`);
    expect(await waitForClose(socket)).toBe(4003);
    expect(cloud.tunnel.isOnline(created.device.id)).toBe(false);
  });

  it('drops the live tunnel when the device is revoked over HTTP', async () => {
    const created = cloud.store.createDevice({ userId: 'u1', name: 'drop-on-revoke', os: 'linux', capabilities: [] });
    const port = Number.parseInt(baseUrl.split(':').pop() as string, 10);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/tunnel?deviceId=${created.device.id}&token=${created.token}`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(cloud.tunnel.isOnline(created.device.id)).toBe(true);

    const { status } = await api(`/v1/devices/${created.device.id}`, { method: 'DELETE' });
    expect(status).toBe(200);

    const closeCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('tunnel was not closed after revocation')), 2_000);
      socket.once('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    expect(closeCode).toBe(4002);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(cloud.tunnel.isOnline(created.device.id)).toBe(false);
  });
});

/** Dials a tunnel for a device and auto-answers tool calls with an echo payload. */
async function dialEchoTunnel(deviceId: string, token: string): Promise<WebSocket> {
  const port = Number.parseInt(baseUrl.split(':').pop() as string, 10);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/tunnel?deviceId=${deviceId}&token=${token}`);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  socket.on('message', (raw) => {
    const frame = JSON.parse(String(raw)) as { t: string; callId: string; name: string };
    if (frame.t !== 'tool.call') return;
    socket.send(
      JSON.stringify({ t: 'tool.result', callId: frame.callId, ok: true, result: { echoed: frame.name } }),
    );
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  return socket;
}

describe('tool call ownership', () => {
  it('hides another user\'s device from tool targeting', async () => {
    const foreign = cloud.store.createDevice({ userId: 'u-foreign', name: 'foreign', os: 'linux', capabilities: [] });
    const socket = await dialEchoTunnel(foreign.device.id, foreign.token);
    const { status } = await api('/v1/tool', {
      method: 'POST',
      body: JSON.stringify({ name: 'fs.read', args: {}, deviceId: foreign.device.id }),
    });
    expect(status).toBe(404);
    socket.close();
  });

  it('still forwards to another device of the same user', async () => {
    const mine = cloud.store.createDevice({ userId: 'u1', name: 'second', os: 'linux', capabilities: [] });
    const socket = await dialEchoTunnel(mine.device.id, mine.token);
    const { status, body } = await api('/v1/tool', {
      method: 'POST',
      body: JSON.stringify({ name: 'fs.read', args: {}, deviceId: mine.device.id }),
    });
    expect(status).toBe(200);
    expect(body.result).toEqual({ echoed: 'fs.read' });
    socket.close();
  });

  it('returns 404 for an unknown device id', async () => {
    const { status } = await api('/v1/tool', {
      method: 'POST',
      body: JSON.stringify({ name: 'fs.read', args: {}, deviceId: 'no-such-device' }),
    });
    expect(status).toBe(404);
  });
});

describe('token rotation', () => {
  it('rotates a device token and invalidates the old one', async () => {
    const created = cloud.store.createDevice({ userId: 'u1', name: 'rotate-me', os: 'linux', capabilities: [] });
    const { status, body } = await api(`/v1/devices/${created.device.id}/rotate`, { method: 'POST' });
    expect(status).toBe(201);
    expect(typeof body.token).toBe('string');

    const oldMe = await api('/v1/me', {}, created.token);
    expect(oldMe.status).toBe(401);

    const newMe = await api('/v1/me', {}, body.token);
    expect(newMe.status).toBe(200);
    expect(newMe.body.deviceId).toBe(created.device.id);
  });

  it('refuses to rotate another user\'s device', async () => {
    const foreign = cloud.store.createDevice({ userId: 'u-foreign', name: 'foreign', os: 'linux', capabilities: [] });
    const { status } = await api(`/v1/devices/${foreign.device.id}/rotate`, { method: 'POST' });
    expect(status).toBe(404);
  });

  it('refuses to rotate a revoked device', async () => {
    const created = cloud.store.createDevice({ userId: 'u1', name: 'revoked', os: 'linux', capabilities: [] });
    cloud.store.revokeDevice(created.device.id);
    const { status } = await api(`/v1/devices/${created.device.id}/rotate`, { method: 'POST' });
    expect(status).toBe(409);
  });
});

describe('R8 multi-tenant isolation', () => {
  async function tenant(userId: string): Promise<{ token: string; deviceId: string }> {
    // Free is 0 runs/month by design; paid plans are what exercising runs needs.
    cloud.store.setPlan(userId, 'creator');
    const start = await api('/v1/pair/start', { method: 'POST', body: JSON.stringify({ userId }) }, '');
    const done = await api(
      '/v1/pair/complete',
      { method: 'POST', body: JSON.stringify({ code: start.body.code, name: userId, os: 'windows' }) },
      '',
    );
    return { token: done.body.token, deviceId: done.body.deviceId };
  }

  it('never lists another tenant\'s runs', async () => {
    const a = await tenant('tenant-a');
    const b = await tenant('tenant-b');
    await api('/v1/runs', { method: 'POST', body: JSON.stringify({ projectId: 'pa' }) }, a.token);
    const listed = await api('/v1/runs', {}, b.token);
    expect(listed.body.runs).toEqual([]);
  });

  it('hides another tenant\'s run behind 404 on read and write', async () => {
    const a = await tenant('tenant-c');
    const b = await tenant('tenant-d');
    const created = await api('/v1/runs', { method: 'POST', body: JSON.stringify({ projectId: 'pc' }) }, a.token);
    const runId = created.body.run.id;

    const read = await api(`/v1/runs/${runId}`, {}, b.token);
    expect(read.status).toBe(404);
    const patch = await api(`/v1/runs/${runId}`, { method: 'PATCH', body: JSON.stringify({ status: 'failed' }) }, b.token);
    expect(patch.status).toBe(404);

    const stillQueued = await api(`/v1/runs/${runId}`, {}, a.token);
    expect(stillQueued.body.run.status).toBe('queued');
  });

  it('records a security event for a denied cross-tenant read', async () => {
    const a = await tenant('tenant-e');
    const b = await tenant('tenant-f');
    const created = await api('/v1/runs', { method: 'POST', body: JSON.stringify({ projectId: 'pe' }) }, a.token);
    await api(`/v1/runs/${created.body.run.id}`, {}, b.token);

    const events = await api('/v1/security-events', {}, b.token);
    expect(events.status).toBe(200);
    expect(events.body.events.some((event: { kind: string }) => event.kind === 'cross-tenant-read')).toBe(true);
    // The victim sees none of the attacker's events.
    const none = await api('/v1/security-events', {}, a.token);
    expect(none.body.events).toEqual([]);
  });

  it('silently downgrades a run targeting a foreign device', async () => {
    const a = await tenant('tenant-g');
    const b = await tenant('tenant-h');
    const created = await api(
      '/v1/runs',
      { method: 'POST', body: JSON.stringify({ projectId: 'pg', deviceId: a.deviceId, executionMode: 'hybrid' }) },
      b.token,
    );
    expect(created.status).toBe(201);
    expect(created.body.run.deviceId).toBeNull();
  });

  it('keeps billing and usage per tenant', async () => {
    const a = await tenant('tenant-i');
    const b = await tenant('tenant-j');
    await api('/v1/runs', { method: 'POST', body: JSON.stringify({ projectId: 'pi' }) }, a.token);
    await api('/v1/runs', { method: 'POST', body: JSON.stringify({ projectId: 'pi' }) }, a.token);

    const usageA = await api('/v1/usage', {}, a.token);
    const usageB = await api('/v1/usage', {}, b.token);
    expect(usageA.body.runs).toBe(2);
    expect(usageB.body.runs).toBe(0);
    // Both tenants are on the same paid plan, so only the run count differs.
    expect(usageA.body.plan.monthlyRuns).toBe(usageB.body.plan.monthlyRuns);
    expect(usageA.body.plan.monthlyRuns).toBe(30);
  });
});
