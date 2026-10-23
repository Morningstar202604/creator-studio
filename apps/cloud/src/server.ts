import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { TunnelRegistry, attachTunnelServer } from './tunnel.js';
import { MemoryStore, PLANS, type CloudRun } from './store.js';

export type CloudOptions = {
  port?: number;
  store?: MemoryStore;
  tunnel?: TunnelRegistry;
  now?: () => Date;
};

export type CloudApp = {
  server: Server;
  store: MemoryStore;
  tunnel: TunnelRegistry;
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
};

type Json = Record<string, unknown>;

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw) as Json;
  } catch {
    return {};
  }
}

function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  return header.slice(7);
}

/**
 * Local-first cloud control plane. Uses in-memory state so it runs on a laptop with
 * no Postgres/Redis; the store and tunnel interfaces are the seams where the real
 * infrastructure plugs in.
 */
export function createCloud(options: CloudOptions = {}): CloudApp {
  const store = options.store ?? new MemoryStore();
  const tunnel = options.tunnel ?? new TunnelRegistry();
  const clock = options.now ?? (() => new Date());

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (path === '/health') {
      return send(res, 200, {
        ok: true,
        service: 'creator-studio-cloud',
        devices: tunnel.online().length,
        runs: store.runs.size,
      });
    }

    // --- device pairing (no auth: the pairing code IS the credential) ---
    if (path === '/v1/pair/start' && method === 'POST') {
      const body = await readJson(req);
      const userId = typeof body.userId === 'string' ? body.userId : 'cloud-user';
      const code = store.createPairingCode(userId, '');
      return send(res, 201, { code: code.code, expiresAt: new Date(code.expiresAt).toISOString() });
    }

    if (path === '/v1/pair/complete' && method === 'POST') {
      const body = await readJson(req);
      if (typeof body.code !== 'string') {
        return send(res, 400, { error: { code: 'INVALID_INPUT', message: 'code required' } });
      }
      const consumed = store.consumePairingCode(body.code);
      if (consumed === null) {
        return send(res, 400, { error: { code: 'PAIRING_INVALID', message: 'code expired or already used' } });
      }
      const { device, token } = store.createDevice({
        userId: consumed.userId,
        name: typeof body.name === 'string' ? body.name : 'desktop',
        os: body.os === 'macos' || body.os === 'linux' ? body.os : 'windows',
        capabilities: Array.isArray(body.capabilities) ? (body.capabilities as string[]) : [],
      });
      consumed.deviceId = device.id;
      return send(res, 201, { deviceId: device.id, token });
    }

    // --- everything below requires a device token ---
    const token = bearer(req);
    const device = token === null ? null : store.findByToken(token);
    if (device === null) {
      return send(res, 401, { error: { code: 'UNAUTHORIZED', message: 'missing or invalid token' } });
    }
    store.touchDevice(device.id);

    if (path === '/v1/me' && method === 'GET') {
      return send(res, 200, {
        deviceId: device.id,
        userId: device.userId,
        usage: store.usage(device.userId),
        plan: store.planOf(device.userId),
      });
    }

    if (path === '/v1/devices' && method === 'GET') {
      const mine = [...store.devices.values()]
        .filter((entry) => entry.userId === device.userId)
        .map((entry) => ({
          id: entry.id,
          name: entry.name,
          os: entry.os,
          online: tunnel.isOnline(entry.id),
          lastSeenAt: entry.lastSeenAt,
          revokedAt: entry.revokedAt,
        }));
      return send(res, 200, { devices: mine });
    }

    if (path.startsWith('/v1/devices/') && path.endsWith('/rotate') && method === 'POST') {
      const targetId = path.slice('/v1/devices/'.length, -'/rotate'.length);
      const target = store.devices.get(targetId);
      // Same 404 masking as DELETE: never reveal another user's device existence.
      if (target === undefined || target.userId !== device.userId) {
        return send(res, 404, { error: { code: 'NOT_FOUND', message: targetId } });
      }
      if (target.revokedAt !== null) {
        return send(res, 409, { error: { code: 'DEVICE_REVOKED', message: targetId } });
      }
      const rotated = store.rotateDevice(targetId);
      return send(res, 201, { token: rotated });
    }

    if (path.startsWith('/v1/devices/') && method === 'DELETE') {
      const targetId = path.slice('/v1/devices/'.length);
      const target = store.devices.get(targetId);
      if (target === undefined || target.userId !== device.userId) {
        return send(res, 404, { error: { code: 'NOT_FOUND', message: targetId } });
      }
      store.revokeDevice(targetId);
      // A revoked device must not keep an open tunnel; drop it with its pending calls.
      tunnel.close(targetId);
      return send(res, 200, { revoked: targetId });
    }

    if (path === '/v1/runs' && method === 'POST') {
      const body = await readJson(req);
      const plan = store.planOf(device.userId);
      const used = store.runsThisMonth(device.userId);
      if (used >= plan.monthlyRuns) {
        return send(res, 402, {
          error: { code: 'PLAN_LIMIT', message: `${used}/${plan.monthlyRuns} runs used this month` },
        });
      }
      const run: CloudRun = {
        id: randomUUID(),
        userId: device.userId,
        deviceId: typeof body.deviceId === 'string' ? body.deviceId : null,
        projectId: typeof body.projectId === 'string' ? body.projectId : '',
        agentId: typeof body.agentId === 'string' ? body.agentId : 'scriptwriter',
        status: 'queued',
        executionMode: body.executionMode === 'hybrid' ? 'hybrid' : 'cloud',
        createdAt: clock().toISOString(),
        endedAt: null,
        error: null,
      };
      store.recordRun(run);
      store.charge({ userId: device.userId, runId: run.id, kind: 'run', units: 1, costCny: 0 });
      return send(res, 201, { run });
    }

    if (path === '/v1/runs' && method === 'GET') {
      const mine = [...store.runs.values()]
        .filter((run) => run.userId === device.userId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return send(res, 200, { runs: mine });
    }

    if (path.startsWith('/v1/runs/') && method === 'PATCH') {
      const runId = path.slice('/v1/runs/'.length);
      const run = store.runs.get(runId);
      if (run === undefined || run.userId !== device.userId) {
        return send(res, 404, { error: { code: 'NOT_FOUND', message: runId } });
      }
      const body = await readJson(req);
      if (typeof body.status === 'string') {
        const allowed = ['queued', 'running', 'succeeded', 'failed'];
        if (!allowed.includes(body.status)) {
          return send(res, 400, { error: { code: 'INVALID_INPUT', message: 'unknown status' } });
        }
        run.status = body.status as CloudRun['status'];
        if (run.status === 'succeeded' || run.status === 'failed') run.endedAt = clock().toISOString();
      }
      if (typeof body.error === 'string') run.error = body.error;
      return send(res, 200, { run });
    }

    // --- tunnel-mediated tool call: proves the cloud can reach local fs ---
    if (path === '/v1/tool' && method === 'POST') {
      const body = await readJson(req);
      const targetDevice = typeof body.deviceId === 'string' ? body.deviceId : device.id;
      // A device may only drive tunnels of devices owned by the same user; unknown
      // ids get the same 404 so existence is not leaked either way.
      const target = store.devices.get(targetDevice);
      if (target === undefined || target.userId !== device.userId) {
        return send(res, 404, { error: { code: 'NOT_FOUND', message: targetDevice } });
      }
      if (typeof body.name !== 'string') {
        return send(res, 400, { error: { code: 'INVALID_INPUT', message: 'name required' } });
      }
      try {
        const result = await tunnel.call(
          targetDevice,
          {
            callId: typeof body.callId === 'string' ? body.callId : randomUUID(),
            name: body.name,
            args: body.args ?? {},
            timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : 30_000,
          },
          typeof body.timeoutMs === 'number' ? body.timeoutMs : 30_000,
        );
        if (!result.ok) {
          return send(res, 502, { error: result.error ?? { code: 'TOOL_FAILED', message: 'device reported failure' } });
        }
        return send(res, 200, { result: result.result });
      } catch (error) {
        const code = error instanceof Error ? error.message : 'TUNNEL_ERROR';
        return send(res, code === 'DEVICE_OFFLINE' ? 409 : 504, { error: { code, message: code } });
      }
    }

    if (path === '/v1/usage' && method === 'GET') {
      return send(res, 200, store.usage(device.userId));
    }

    if (path === '/v1/plans' && method === 'GET') {
      return send(res, 200, { plans: PLANS });
    }

    return send(res, 404, { error: { code: 'NOT_FOUND', message: path } });
  }

  // The WS upgrade is the one endpoint that cannot carry a Bearer header, so the
  // device token rides in the query string and is validated against the same store.
  const wssReady = attachTunnelServer(server, tunnel, (tunnelDeviceId, tunnelToken) => {
    const tokenDevice = store.findByToken(tunnelToken);
    if (tokenDevice === null || tokenDevice.id !== tunnelDeviceId) return false;
    store.touchDevice(tokenDevice.id);
    return true;
  });

  return {
    server,
    store,
    tunnel,
    async listen(port = 0, host = '127.0.0.1'): Promise<number> {
      await wssReady;
      await new Promise<void>((resolve) => server.listen(port, host, resolve));
      return (server.address() as { port: number }).port;
    },
    async close(): Promise<void> {
      const wss = await wssReady;
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
