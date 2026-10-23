import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

export type ToolCallFrame = {
  t: 'tool.call';
  callId: string;
  name: string;
  args: unknown;
  timeoutMs: number;
};

export type ToolResultFrame = {
  t: 'tool.result';
  callId: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
};

type Pending = {
  resolve: (result: ToolResultFrame) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type TunnelClient = {
  deviceId: string;
  socket: WebSocket;
  pending: Map<string, Pending>;
};

/**
 * Server side of Agent Link. Devices dial in (NAT friendly); the cloud never dials
 * out. Each device gets one tunnel and a pending-call table keyed by callId.
 */
export class TunnelRegistry {
  private readonly byDevice = new Map<string, TunnelClient>();

  attach(deviceId: string, socket: WebSocket): TunnelClient {
    const existing = this.byDevice.get(deviceId);
    if (existing !== undefined) {
      existing.socket.close(4000, 'replaced by newer connection');
      this.failPending(existing, 'DEVICE_RECONNECTED');
    }

    const client: TunnelClient = { deviceId, socket, pending: new Map() };
    this.byDevice.set(deviceId, client);

    socket.on('message', (raw) => {
      let frame: ToolResultFrame | { t: string };
      try {
        frame = JSON.parse(String(raw)) as ToolResultFrame;
      } catch {
        return;
      }
      if (frame.t !== 'tool.result') return;
      const result = frame as ToolResultFrame;
      const pending = client.pending.get(result.callId);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      client.pending.delete(result.callId);
      pending.resolve(result);
    });

    socket.on('close', () => {
      if (this.byDevice.get(deviceId) === client) this.byDevice.delete(deviceId);
      this.failPending(client, 'DEVICE_OFFLINE');
    });

    return client;
  }

  isOnline(deviceId: string): boolean {
    return this.byDevice.has(deviceId);
  }

  online(): string[] {
    return [...this.byDevice.keys()];
  }

  /** Sends a tool call and waits for the device's result or the timeout. */
  call(deviceId: string, frame: Omit<ToolCallFrame, 't'>, timeoutMs = 60_000): Promise<ToolResultFrame> {
    const client = this.byDevice.get(deviceId);
    if (client === undefined) {
      return Promise.reject(new Error('DEVICE_OFFLINE'));
    }

    return new Promise<ToolResultFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        client.pending.delete(frame.callId);
        reject(new Error('TOOL_TIMEOUT'));
      }, Math.min(timeoutMs, 1_800_000));

      client.pending.set(frame.callId, { resolve, reject, timer });
      client.socket.send(JSON.stringify({ t: 'tool.call', ...frame }));
    });
  }

  private failPending(client: TunnelClient, code: string): void {
    for (const [callId, pending] of client.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(code));
      client.pending.delete(callId);
    }
  }

  /** Forcefully drops a device's tunnel, e.g. after its token was revoked. */
  close(deviceId: string, code = 4002, reason = 'device revoked'): void {
    const client = this.byDevice.get(deviceId);
    if (client === undefined) return;
    this.byDevice.delete(deviceId);
    this.failPending(client, 'DEVICE_REVOKED');
    client.socket.close(code, reason);
  }
}

/** Synchronous so the socket attaches in the same tick the upgrade completes. */
export type TunnelAuthenticator = (deviceId: string, token: string) => boolean;

export async function attachTunnelServer(
  server: Server,
  registry: TunnelRegistry,
  authenticate?: TunnelAuthenticator,
): Promise<WebSocketServer> {
  const wss = new WebSocketServer({ server, path: '/v1/tunnel' });
  wss.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const deviceId = url.searchParams.get('deviceId') ?? '';
    const token = url.searchParams.get('token') ?? '';
    if (deviceId === '' || token === '') {
      socket.close(4001, 'deviceId and token required');
      return;
    }
    if (authenticate !== undefined && !authenticate(deviceId, token)) {
      socket.close(4003, 'invalid device token');
      return;
    }
    registry.attach(deviceId, socket);
  });
  return wss;
}

export function portOf(server: Server): number {
  return (server.address() as AddressInfo).port;
}
