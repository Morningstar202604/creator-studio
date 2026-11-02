import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  PLANS,
  hashToken,
  newPairingCode,
  newToken,
  type BillingEntry,
  type CloudRun,
  type CloudStore,
  type DeviceRecord,
  type PairingCode,
  type Plan,
  type SecurityEvent,
} from './store.js';

/**
 * Postgres-backed control-plane store. Every query that touches tenant data takes
 * `user_id` as a predicate, so a foreign id is indistinguishable from a missing one.
 * The schema is created lazily on first connect (`ensureSchema`) which keeps a fresh
 * database usable with one env var and no migration step.
 */

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cloud_devices (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  os           TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_cloud_devices_user ON cloud_devices (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_devices_token ON cloud_devices (token_hash);

CREATE TABLE IF NOT EXISTS cloud_pairing_codes (
  code       TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at    TEXT
);

CREATE TABLE IF NOT EXISTS cloud_runs (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  device_id      TEXT,
  project_id     TEXT NOT NULL,
  agent_id       TEXT NOT NULL,
  status         TEXT NOT NULL,
  execution_mode TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  ended_at       TEXT,
  error          TEXT
);
CREATE INDEX IF NOT EXISTS idx_cloud_runs_user ON cloud_runs (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS cloud_billing (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  run_id     TEXT,
  kind       TEXT NOT NULL,
  units      INTEGER NOT NULL,
  cost_cny   DOUBLE PRECISION NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cloud_billing_user ON cloud_billing (user_id);

CREATE TABLE IF NOT EXISTS cloud_plans (
  user_id TEXT PRIMARY KEY,
  plan    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cloud_security_events (
  id             TEXT PRIMARY KEY,
  at             TEXT NOT NULL,
  kind           TEXT NOT NULL,
  actor_user_id  TEXT NOT NULL,
  resource       TEXT NOT NULL,
  resource_id    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cloud_security_user ON cloud_security_events (actor_user_id);
`;

type DeviceRow = {
  id: string;
  user_id: string;
  name: string;
  os: string;
  token_hash: string;
  capabilities: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
};

type RunRow = {
  id: string;
  user_id: string;
  device_id: string | null;
  project_id: string;
  agent_id: string;
  status: string;
  execution_mode: string;
  created_at: string;
  ended_at: string | null;
  error: string | null;
};

type PairingRow = { code: string; user_id: string; device_id: string; expires_at: string; used_at: string | null };
type BillingRow = { id: string; user_id: string; run_id: string | null; kind: string; units: number; cost_cny: number; created_at: string };
type SecurityRow = { id: string; at: string; kind: string; actor_user_id: string; resource: string; resource_id: string };

function toDevice(row: DeviceRow): DeviceRecord {
  let capabilities: string[] = [];
  try {
    const parsed = JSON.parse(row.capabilities) as unknown;
    if (Array.isArray(parsed)) capabilities = parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    capabilities = [];
  }
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    os: row.os as DeviceRecord['os'],
    tokenHash: row.token_hash,
    capabilities,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

function toRun(row: RunRow): CloudRun {
  return {
    id: row.id,
    userId: row.user_id,
    deviceId: row.device_id,
    projectId: row.project_id,
    agentId: row.agent_id,
    status: row.status as CloudRun['status'],
    executionMode: row.execution_mode as CloudRun['executionMode'],
    createdAt: row.created_at,
    endedAt: row.ended_at,
    error: row.error,
  };
}

function toBilling(row: BillingRow): BillingEntry {
  return {
    id: row.id,
    userId: row.user_id,
    runId: row.run_id,
    kind: row.kind as BillingEntry['kind'],
    units: row.units,
    costCny: row.cost_cny,
    createdAt: row.created_at,
  };
}

function toPairing(row: PairingRow): PairingCode {
  return {
    code: row.code,
    userId: row.user_id,
    deviceId: row.device_id,
    expiresAt: Number(row.expires_at),
    usedAt: row.used_at,
  };
}

function toSecurity(row: SecurityRow): SecurityEvent {
  return {
    id: row.id,
    at: row.at,
    kind: row.kind as SecurityEvent['kind'],
    actorUserId: row.actor_user_id,
    resource: row.resource,
    resourceId: row.resource_id,
  };
}

export class PostgresStore implements CloudStore {
  private readonly pool: Pool;
  private schemaReady: Promise<void> | null = null;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 8 });
  }

  /** Creates the schema once per process; concurrent callers share one promise. */
  private ensureSchema(): Promise<void> {
    this.schemaReady ??= this.pool.query(SCHEMA_SQL).then(() => undefined);
    return this.schemaReady;
  }

  async init(): Promise<void> {
    await this.ensureSchema();
  }

  private async recordDenial(
    kind: SecurityEvent['kind'],
    actorUserId: string,
    resource: string,
    resourceId: string,
  ): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      'INSERT INTO cloud_security_events (id, at, kind, actor_user_id, resource, resource_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [randomUUID(), new Date().toISOString(), kind, actorUserId, resource, resourceId],
    );
  }

  async createDevice(input: {
    userId: string;
    name: string;
    os: DeviceRecord['os'];
    capabilities: string[];
  }): Promise<{ device: DeviceRecord; token: string }> {
    await this.ensureSchema();
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
    await this.pool.query(
      `INSERT INTO cloud_devices (id, user_id, name, os, token_hash, capabilities, created_at, last_seen_at, revoked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        device.id,
        device.userId,
        device.name,
        device.os,
        device.tokenHash,
        JSON.stringify(device.capabilities),
        device.createdAt,
        device.lastSeenAt,
        device.revokedAt,
      ],
    );
    return { device, token };
  }

  async devicesOf(userId: string): Promise<DeviceRecord[]> {
    await this.ensureSchema();
    const result = await this.pool.query<DeviceRow>(
      'SELECT * FROM cloud_devices WHERE user_id = $1 ORDER BY created_at ASC',
      [userId],
    );
    return result.rows.map(toDevice);
  }

  async deviceFor(userId: string, deviceId: string): Promise<DeviceRecord | null> {
    await this.ensureSchema();
    const result = await this.pool.query<DeviceRow>('SELECT * FROM cloud_devices WHERE id = $1', [deviceId]);
    const row = result.rows[0];
    if (row === undefined) return null;
    if (row.user_id !== userId) {
      await this.recordDenial('cross-tenant-read', userId, 'device', deviceId);
      return null;
    }
    return toDevice(row);
  }

  async runsOf(userId: string): Promise<CloudRun[]> {
    await this.ensureSchema();
    const result = await this.pool.query<RunRow>(
      'SELECT * FROM cloud_runs WHERE user_id = $1 ORDER BY created_at DESC',
      [userId],
    );
    return result.rows.map(toRun);
  }

  async runFor(userId: string, runId: string): Promise<CloudRun | null> {
    await this.ensureSchema();
    const result = await this.pool.query<RunRow>('SELECT * FROM cloud_runs WHERE id = $1', [runId]);
    const row = result.rows[0];
    if (row === undefined) return null;
    if (row.user_id !== userId) {
      await this.recordDenial('cross-tenant-read', userId, 'run', runId);
      return null;
    }
    return toRun(row);
  }

  async updateRun(
    userId: string,
    runId: string,
    patch: { status?: CloudRun['status']; error?: string },
  ): Promise<CloudRun | null> {
    const current = await this.runFor(userId, runId);
    if (current === null) return null;
    const nextStatus = patch.status ?? current.status;
    const endedAt =
      patch.status !== undefined && (nextStatus === 'succeeded' || nextStatus === 'failed')
        ? new Date().toISOString()
        : current.endedAt;
    const result = await this.pool.query<RunRow>(
      `UPDATE cloud_runs SET status = $1, ended_at = $2, error = $3
       WHERE id = $4 AND user_id = $5 RETURNING *`,
      [nextStatus, endedAt, patch.error ?? current.error, runId, userId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRun(row);
  }

  async billingOf(userId: string): Promise<BillingEntry[]> {
    await this.ensureSchema();
    const result = await this.pool.query<BillingRow>(
      'SELECT * FROM cloud_billing WHERE user_id = $1 ORDER BY created_at ASC',
      [userId],
    );
    return result.rows.map(toBilling);
  }

  async findByToken(token: string): Promise<DeviceRecord | null> {
    await this.ensureSchema();
    const result = await this.pool.query<DeviceRow>(
      'SELECT * FROM cloud_devices WHERE token_hash = $1 AND revoked_at IS NULL',
      [hashToken(token)],
    );
    const row = result.rows[0];
    return row === undefined ? null : toDevice(row);
  }

  async createPairingCode(userId: string, deviceId: string, ttlMs = 5 * 60_000): Promise<PairingCode> {
    await this.ensureSchema();
    const entry: PairingCode = {
      code: newPairingCode(),
      userId,
      deviceId,
      expiresAt: Date.now() + ttlMs,
      usedAt: null,
    };
    await this.pool.query(
      'INSERT INTO cloud_pairing_codes (code, user_id, device_id, expires_at, used_at) VALUES ($1,$2,$3,$4,$5)',
      [entry.code, entry.userId, entry.deviceId, String(entry.expiresAt), entry.usedAt],
    );
    return entry;
  }

  async consumePairingCode(code: string): Promise<PairingCode | null> {
    await this.ensureSchema();
    // Single statement so two concurrent redemptions cannot both succeed.
    const result = await this.pool.query<PairingRow>(
      `UPDATE cloud_pairing_codes SET used_at = $1
       WHERE code = $2 AND used_at IS NULL AND expires_at >= $3
       RETURNING *`,
      [new Date().toISOString(), code, String(Date.now())],
    );
    const row = result.rows[0];
    return row === undefined ? null : toPairing(row);
  }

  async touchDevice(deviceId: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query('UPDATE cloud_devices SET last_seen_at = $1 WHERE id = $2', [
      new Date().toISOString(),
      deviceId,
    ]);
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query('UPDATE cloud_devices SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL', [
      new Date().toISOString(),
      deviceId,
    ]);
  }

  async rotateDevice(deviceId: string): Promise<string | null> {
    await this.ensureSchema();
    const token = newToken();
    const result = await this.pool.query(
      'UPDATE cloud_devices SET token_hash = $1 WHERE id = $2 AND revoked_at IS NULL RETURNING id',
      [hashToken(token), deviceId],
    );
    return result.rowCount === 0 ? null : token;
  }

  async setPlan(userId: string, plan: keyof typeof PLANS): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `INSERT INTO cloud_plans (user_id, plan) VALUES ($1,$2)
       ON CONFLICT (user_id) DO UPDATE SET plan = excluded.plan`,
      [userId, plan],
    );
  }

  async planOf(userId: string): Promise<Plan> {
    await this.ensureSchema();
    const result = await this.pool.query<{ plan: string }>('SELECT plan FROM cloud_plans WHERE user_id = $1', [userId]);
    const row = result.rows[0];
    return PLANS[(row?.plan as keyof typeof PLANS | undefined) ?? 'free'];
  }

  async recordRun(run: CloudRun): Promise<CloudRun> {
    await this.ensureSchema();
    await this.pool.query(
      `INSERT INTO cloud_runs (id, user_id, device_id, project_id, agent_id, status, execution_mode, created_at, ended_at, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [run.id, run.userId, run.deviceId, run.projectId, run.agentId, run.status, run.executionMode, run.createdAt, run.endedAt, run.error],
    );
    return run;
  }

  async runsThisMonth(userId: string): Promise<number> {
    await this.ensureSchema();
    const now = new Date();
    const prefix = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const result = await this.pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM cloud_runs WHERE user_id = $1 AND created_at LIKE $2',
      [userId, `${prefix}%`],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  async charge(entry: Omit<BillingEntry, 'id' | 'createdAt'>): Promise<BillingEntry> {
    await this.ensureSchema();
    const record: BillingEntry = { ...entry, id: randomUUID(), createdAt: new Date().toISOString() };
    await this.pool.query(
      'INSERT INTO cloud_billing (id, user_id, run_id, kind, units, cost_cny, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [record.id, record.userId, record.runId, record.kind, record.units, record.costCny, record.createdAt],
    );
    return record;
  }

  async usage(userId: string): Promise<{ runs: number; costCny: number; plan: Plan }> {
    const entries = await this.billingOf(userId);
    return {
      runs: await this.runsThisMonth(userId),
      costCny: Number(entries.reduce((sum, entry) => sum + entry.costCny, 0).toFixed(4)),
      plan: await this.planOf(userId),
    };
  }

  async runsCount(): Promise<number> {
    await this.ensureSchema();
    const result = await this.pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM cloud_runs');
    return Number(result.rows[0]?.count ?? '0');
  }

  async tenantCount(): Promise<number> {
    await this.ensureSchema();
    const result = await this.pool.query<{ count: string }>(
      'SELECT COUNT(DISTINCT user_id)::text AS count FROM cloud_devices',
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  async securityEventsOf(userId: string): Promise<SecurityEvent[]> {
    await this.ensureSchema();
    const result = await this.pool.query<SecurityRow>(
      'SELECT * FROM cloud_security_events WHERE actor_user_id = $1 ORDER BY at DESC',
      [userId],
    );
    return result.rows.map(toSecurity);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
