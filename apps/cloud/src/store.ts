import { randomUUID, createHash, randomBytes } from 'node:crypto';

export type DeviceRecord = {
  id: string;
  userId: string;
  name: string;
  os: 'windows' | 'macos' | 'linux';
  tokenHash: string;
  capabilities: string[];
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
};

export type PairingCode = {
  code: string;
  userId: string;
  deviceId: string;
  expiresAt: number;
  usedAt: string | null;
};

export type CloudRun = {
  id: string;
  userId: string;
  deviceId: string | null;
  projectId: string;
  agentId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  executionMode: 'cloud' | 'hybrid';
  createdAt: string;
  endedAt: string | null;
  error: string | null;
};

export type BillingEntry = {
  id: string;
  userId: string;
  runId: string | null;
  kind: 'run' | 'tool';
  units: number;
  costCny: number;
  createdAt: string;
};

export type Plan = {
  monthlyRuns: number;
  monthlyCostCny: number;
  priceCny: number;
};

export const PLANS: Record<'free' | 'creator' | 'pro', Plan> = {
  free: { monthlyRuns: 0, monthlyCostCny: 0, priceCny: 0 },
  creator: { monthlyRuns: 30, monthlyCostCny: 100, priceCny: 69 },
  pro: { monthlyRuns: 100, monthlyCostCny: 400, priceCny: 169 },
};

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function newPairingCode(): string {
  // Six digits, zero-padded, easy to type on the desktop side.
  return String(randomBytes(3).readUIntBE(0, 3) % 1_000_000).padStart(6, '0');
}

export type SecurityEvent = {
  id: string;
  at: string;
  kind: 'cross-tenant-read' | 'cross-tenant-write';
  actorUserId: string;
  resource: string;
  resourceId: string;
};

/**
 * In-memory store used when no PostgreSQL is configured. The interface mirrors the
 * Postgres-backed implementation so swapping it in needs no call-site changes.
 *
 * Multi-tenancy is enforced here rather than in the HTTP layer: every scoped accessor
 * takes the caller's `userId` and returns null/none on a mismatch, recording a
 * security event instead of leaking existence. Postgres deployments should mirror
 * these helpers with `WHERE user_id = $1` predicates (and RLS as a second layer).
 */
export class MemoryStore {
  readonly devices = new Map<string, DeviceRecord>();
  readonly pairing = new Map<string, PairingCode>();
  readonly runs = new Map<string, CloudRun>();
  readonly billing: BillingEntry[] = [];
  readonly securityEvents: SecurityEvent[] = [];
  private readonly planByUser = new Map<string, keyof typeof PLANS>();

  createDevice(input: { userId: string; name: string; os: DeviceRecord['os']; capabilities: string[] }): {
    device: DeviceRecord;
    token: string;
  } {
    const token = newToken();
    const device: DeviceRecord = {
      id: randomUUID(),
      userId: input.userId,
      name: input.name,
      os: input.os,
      tokenHash: hashToken(token),
      capabilities: input.capabilities,
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
      revokedAt: null,
    };
    this.devices.set(device.id, device);
    return { device, token };
  }

  private recordDenial(kind: SecurityEvent['kind'], actorUserId: string, resource: string, resourceId: string): void {
    this.securityEvents.push({
      id: randomUUID(),
      at: new Date().toISOString(),
      kind,
      actorUserId,
      resource,
      resourceId,
    });
  }

  /** Devices owned by a tenant. Never returns another user's rows. */
  devicesOf(userId: string): DeviceRecord[] {
    return [...this.devices.values()].filter((device) => device.userId === userId);
  }

  /** Tenant-scoped lookup; a foreign id is treated as absent and logged. */
  deviceFor(userId: string, deviceId: string): DeviceRecord | null {
    const device = this.devices.get(deviceId);
    if (device === undefined) return null;
    if (device.userId !== userId) {
      this.recordDenial('cross-tenant-read', userId, 'device', deviceId);
      return null;
    }
    return device;
  }

  runsOf(userId: string): CloudRun[] {
    return [...this.runs.values()]
      .filter((run) => run.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  runFor(userId: string, runId: string): CloudRun | null {
    const run = this.runs.get(runId);
    if (run === undefined) return null;
    if (run.userId !== userId) {
      this.recordDenial('cross-tenant-read', userId, 'run', runId);
      return null;
    }
    return run;
  }

  /** Applies a status/error patch only when the run belongs to the caller. */
  updateRun(
    userId: string,
    runId: string,
    patch: { status?: CloudRun['status']; error?: string },
  ): CloudRun | null {
    const run = this.runs.get(runId);
    if (run === undefined) return null;
    if (run.userId !== userId) {
      this.recordDenial('cross-tenant-write', userId, 'run', runId);
      return null;
    }
    if (patch.status !== undefined) {
      run.status = patch.status;
      if (run.status === 'succeeded' || run.status === 'failed') run.endedAt = new Date().toISOString();
    }
    if (patch.error !== undefined) run.error = patch.error;
    return run;
  }

  /** Billing rows are tenant-scoped on read; there is no cross-tenant aggregate. */
  billingOf(userId: string): BillingEntry[] {
    return this.billing.filter((entry) => entry.userId === userId);
  }

  findByToken(token: string): DeviceRecord | null {
    const hash = hashToken(token);
    for (const device of this.devices.values()) {
      if (device.tokenHash === hash && device.revokedAt === null) return device;
    }
    return null;
  }

  createPairingCode(userId: string, deviceId: string, ttlMs = 5 * 60_000): PairingCode {
    const code = newPairingCode();
    const entry: PairingCode = {
      code,
      userId,
      deviceId,
      expiresAt: Date.now() + ttlMs,
      usedAt: null,
    };
    this.pairing.set(code, entry);
    return entry;
  }

  /** Consumes a pairing code; returns null when missing, expired or already used. */
  consumePairingCode(code: string): PairingCode | null {
    const entry = this.pairing.get(code);
    if (entry === undefined) return null;
    if (entry.usedAt !== null) return null;
    if (entry.expiresAt < Date.now()) return null;
    entry.usedAt = new Date().toISOString();
    return entry;
  }

  touchDevice(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (device !== undefined) device.lastSeenAt = new Date().toISOString();
  }

  revokeDevice(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (device !== undefined) device.revokedAt = new Date().toISOString();
  }

  /** Replaces a device's token hash; the previous token stops authenticating at once. */
  rotateDevice(deviceId: string): string | null {
    const device = this.devices.get(deviceId);
    if (device === undefined || device.revokedAt !== null) return null;
    const token = newToken();
    device.tokenHash = hashToken(token);
    return token;
  }

  setPlan(userId: string, plan: keyof typeof PLANS): void {
    this.planByUser.set(userId, plan);
  }

  planOf(userId: string): Plan {
    return PLANS[this.planByUser.get(userId) ?? 'free'];
  }

  recordRun(run: CloudRun): CloudRun {
    this.runs.set(run.id, run);
    return run;
  }

  /** Returns the number of runs started in the current calendar month. */
  runsThisMonth(userId: string): number {
    const now = new Date();
    const prefix = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    let count = 0;
    for (const run of this.runs.values()) {
      if (run.userId !== userId) continue;
      if (run.createdAt.startsWith(prefix)) count += 1;
    }
    return count;
  }

  charge(entry: Omit<BillingEntry, 'id' | 'createdAt'>): BillingEntry {
    const record: BillingEntry = {
      ...entry,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.billing.push(record);
    return record;
  }

  usage(userId: string): { runs: number; costCny: number; plan: Plan } {
    const entries = this.billingOf(userId);
    return {
      runs: this.runsThisMonth(userId),
      costCny: Number(entries.reduce((sum, entry) => sum + entry.costCny, 0).toFixed(4)),
      plan: this.planOf(userId),
    };
  }
}
