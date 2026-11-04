import { randomUUID, timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { TunnelRegistry, attachTunnelServer } from './tunnel.js';
import { MemoryStore, PLANS, type CloudRun, type CloudStore } from './store.js';

export type CloudOptions = {
  port?: number;
  store?: CloudStore;
  tunnel?: TunnelRegistry;
  now?: () => Date;
  /**
   * One-time enrolment secret for the very first device of a deployment. When set,
   * `POST /v1/pair/start` accepts it instead of a device token. When unset, only an
   * already-paired device can start a pairing — the safe default for an established
   * deployment.
   */
  bootstrapToken?: string;
};

export type CloudApp = {
  server: Server;
  store: CloudStore;
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

/**
 * Constant-time comparison for a shared secret. Length differences leak through the
 * early return, which is acceptable here: the bootstrap token is fixed-length and a
 * length oracle on it reveals nothing useful.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return cryptoTimingSafeEqual(left, right);
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
  const bootstrapToken = options.bootstrapToken ?? null;
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
        onlineDevices: tunnel.online().length,
        // Aggregate counts only; no tenant identifiers in an unauthenticated route.
        runs: await store.runsCount(),
        tenants: await store.tenantCount(),
      });
    }

    // --- device pairing ---
    //
    // Starting a pairing is how a *new* device joins an existing account, so it must
    // be authorised by a credential that already belongs to that account. Accepting
    // `userId` from the body let any anonymous caller mint a code for any user and
    // then redeem it into a device token — full account takeover with two requests.
    if (path === '/v1/pair/start' && method === 'POST') {
      // Two legitimate callers:
      //   1. an already-paired device adding another device to its own account;
      //   2. a bootstrap client presenting the deployment's one-time enrolment
      //      secret (CLOUD_BOOTSTRAP_TOKEN), which is how the *first* device of a
      //      fresh deployment gets in. Without case 2 the product cannot start; with
      //      an unauthenticated case 1 it can be taken over, which is what this
      //      replaced.
      const startToken = bearer(req);
      const startDevice = startToken === null ? null : await store.findByToken(startToken);
      const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);

      let userId: string | null = null;
      let deviceId = '';
      if (startDevice !== null) {
        userId = startDevice.userId;
        deviceId = startDevice.id;
      } else if (startToken !== null && bootstrapToken !== null && timingSafeEqual(startToken, bootstrapToken)) {
        userId = typeof body.userId === 'string' && body.userId !== '' ? body.userId : 'cloud-user';
      }

      if (userId === null) {
        return send(res, 401, {
          error: {
            code: 'UNAUTHENTICATED',
            message: 'pairing must be started by a paired device or the deployment bootstrap token',
          },
        });
      }

      const code = await store.createPairingCode(userId, deviceId);
      return send(res, 201, { code: code.code, expiresAt: new Date(code.expiresAt).toISOString(), userId });
    }

    if (path === '/v1/pair/complete' && method === 'POST') {
      const body = await readJson(req);
      if (typeof body.code !== 'string') {
        return send(res, 400, { error: { code: 'INVALID_INPUT', message: 'code required' } });
      }
      const consumed = await store.consumePairingCode(body.code);
      if (consumed === null) {
        return send(res, 400, { error: { code: 'PAIRING_INVALID', message: 'code expired or already used' } });
      }
      const { device, token } = await store.createDevice({
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
    const device = token === null ? null : await store.findByToken(token);
    if (device === null) {
      return send(res, 401, { error: { code: 'UNAUTHORIZED', message: 'missing or invalid token' } });
    }
    await store.touchDevice(device.id);

    if (path === '/v1/me' && method === 'GET') {
      return send(res, 200, {
        deviceId: device.id,
        userId: device.userId,
        usage: await store.usage(device.userId),
        plan: await store.planOf(device.userId),
      });
    }

    if (path === '/v1/devices' && method === 'GET') {
      const mine = (await store.devicesOf(device.userId)).map((entry) => ({
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
      // Tenant-scoped lookup: a foreign device is indistinguishable from a missing
      // one, and the store records the attempt as a security event.
      const target = await store.deviceFor(device.userId, targetId);
      if (target === null) {
        return send(res, 404, { error: { code: 'NOT_FOUND', message: targetId } });
      }
      if (target.revokedAt !== null) {
        return send(res, 409, { error: { code: 'DEVICE_REVOKED', message: targetId } });
      }
      const rotated = await store.rotateDevice(targetId);
      return send(res, 201, { token: rotated });
    }

    if (path.startsWith('/v1/devices/') && method === 'DELETE') {
      const targetId = path.slice('/v1/devices/'.length);
      const target = await store.deviceFor(device.userId, targetId);
      if (target === null) {
        return send(res, 404, { error: { code: 'NOT_FOUND', message: targetId } });
      }
      await store.revokeDevice(targetId);
      // A revoked device must not keep an open tunnel; drop it with its pending calls.
      tunnel.close(targetId);
      return send(res, 200, { revoked: targetId });
    }

    if (path === '/v1/runs' && method === 'POST') {
      const body = await readJson(req);
      const plan = await store.planOf(device.userId);
      const used = await store.runsThisMonth(device.userId);
      if (used >= plan.monthlyRuns) {
        return send(res, 402, {
          error: { code: 'PLAN_LIMIT', message: `${used}/${plan.monthlyRuns} runs used this month` },
        });
      }
      // A run may only target a device the caller owns; otherwise it silently
      // becomes a cloud-only run instead of pointing at a foreign tunnel.
      const requestedDevice = typeof body.deviceId === 'string' ? body.deviceId : null;
      const ownedDevice =
        requestedDevice !== null && (await store.deviceFor(device.userId, requestedDevice)) !== null
          ? requestedDevice
          : null;
      const run: CloudRun = {
        id: randomUUID(),
        userId: device.userId,
        deviceId: ownedDevice,
        projectId: typeof body.projectId === 'string' ? body.projectId : '',
        agentId: typeof body.agentId === 'string' ? body.agentId : 'scriptwriter',
        status: 'queued',
        executionMode: body.executionMode === 'hybrid' ? 'hybrid' : 'cloud',
        createdAt: clock().toISOString(),
        endedAt: null,
        error: null,
      };
      await store.recordRun(run);
      await store.charge({ userId: device.userId, runId: run.id, kind: 'run', units: 1, costCny: 0 });
      return send(res, 201, { run });
    }

    if (path === '/v1/runs' && method === 'GET') {
      return send(res, 200, { runs: await store.runsOf(device.userId) });
    }

    if (path.startsWith('/v1/runs/') && method === 'GET') {
      const runId = path.slice('/v1/runs/'.length);
      const run = await store.runFor(device.userId, runId);
      if (run === null) return send(res, 404, { error: { code: 'NOT_FOUND', message: runId } });
      return send(res, 200, { run });
    }

    if (path.startsWith('/v1/runs/') && method === 'PATCH') {
      const runId = path.slice('/v1/runs/'.length);
      if ((await store.runFor(device.userId, runId)) === null) {
        return send(res, 404, { error: { code: 'NOT_FOUND', message: runId } });
      }
      const body = await readJson(req);
      const patch: { status?: CloudRun['status']; error?: string } = {};
      if (typeof body.status === 'string') {
        const allowed = ['queued', 'running', 'succeeded', 'failed'];
        if (!allowed.includes(body.status)) {
          return send(res, 400, { error: { code: 'INVALID_INPUT', message: 'unknown status' } });
        }
        patch.status = body.status as CloudRun['status'];
      }
      if (typeof body.error === 'string') patch.error = body.error;
      const updated = await store.updateRun(device.userId, runId, patch);
      if (updated === null) return send(res, 404, { error: { code: 'NOT_FOUND', message: runId } });
      return send(res, 200, { run: updated });
    }

    // --- tunnel-mediated tool call: proves the cloud can reach local fs ---
    if (path === '/v1/tool' && method === 'POST') {
      const body = await readJson(req);
      const targetDevice = typeof body.deviceId === 'string' ? body.deviceId : device.id;
      // A device may only drive tunnels of devices owned by the same user; unknown
      // ids get the same 404 so existence is not leaked either way.
      const target = await store.deviceFor(device.userId, targetDevice);
      if (target === null) {
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
      return send(res, 200, await store.usage(device.userId));
    }

    if (path === '/v1/plans' && method === 'GET') {
      return send(res, 200, { plans: PLANS });
    }

    // Tenant-scoped audit of denied cross-tenant access attempts. Admin/debug only:
    // it exposes ids, never payloads, and only for the caller's own tenant.
    if (path === '/v1/security-events' && method === 'GET') {
      const mine = await store.securityEventsOf(device.userId);
      return send(res, 200, { events: mine });
    }

    return send(res, 404, { error: { code: 'NOT_FOUND', message: path } });
  }

  // The WS upgrade is the one endpoint that cannot carry a Bearer header, so the
  // device token rides in the query string and is validated against the same store.
  const wssReady = attachTunnelServer(server, tunnel, async (tunnelDeviceId, tunnelToken) => {
    const tokenDevice = await store.findByToken(tunnelToken);
    if (tokenDevice === null || tokenDevice.id !== tunnelDeviceId) return false;
    await store.touchDevice(tokenDevice.id);
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
      // Release the backend (Postgres pool) so tests and shutdown do not leak handles.
      await store.close();
    },
  };
}
