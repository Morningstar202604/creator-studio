import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresStore } from '../src/store-postgres.js';

/**
 * Runs only when a real Postgres is reachable. The suite proves the Postgres
 * implementation matches the in-memory one on the property that matters most:
 * a foreign tenant id must behave exactly like a missing one.
 */
const url = process.env['CLOUD_TEST_DATABASE_URL'] ?? '';
const describeIf = url === '' ? describe.skip : describe;

let store: PostgresStore;
const suffix = Math.random().toString(36).slice(2, 8);
const alice = `alice-${suffix}`;
const bob = `bob-${suffix}`;

describeIf('PostgresStore (integration)', () => {
  beforeAll(async () => {
    store = new PostgresStore(url);
    await store.init();
  });

  afterAll(async () => {
    await store.close();
  });

  it('creates a device and authenticates by token', async () => {
    const { device, token } = await store.createDevice({
      userId: alice,
      name: '台式机',
      os: 'windows',
      capabilities: ['fs.read'],
    });
    expect(device.userId).toBe(alice);
    const found = await store.findByToken(token);
    expect(found?.id).toBe(device.id);
    expect(found?.capabilities).toEqual(['fs.read']);
  });

  it('returns null and records a security event for a cross-tenant device read', async () => {
    const mine = await store.createDevice({ userId: alice, name: 'a', os: 'linux', capabilities: [] });
    expect(await store.deviceFor(bob, mine.device.id)).toBeNull();
    const events = await store.securityEventsOf(bob);
    expect(events.some((event) => event.kind === 'cross-tenant-read' && event.resourceId === mine.device.id)).toBe(
      true,
    );
    // The owner still sees it.
    expect((await store.deviceFor(alice, mine.device.id))?.id).toBe(mine.device.id);
  });

  it('lists only the caller devices', async () => {
    const bobDevice = await store.createDevice({ userId: bob, name: 'b', os: 'macos', capabilities: [] });
    const aliceDevices = await store.devicesOf(alice);
    expect(aliceDevices.every((device) => device.userId === alice)).toBe(true);
    expect(aliceDevices.some((device) => device.id === bobDevice.device.id)).toBe(false);
  });

  it('scopes runs and refuses a cross-tenant write', async () => {
    const runId = `run-${suffix}`;
    await store.recordRun({
      id: runId,
      userId: alice,
      deviceId: null,
      projectId: 'p1',
      agentId: 'scriptwriter',
      status: 'running',
      executionMode: 'cloud',
      createdAt: new Date().toISOString(),
      endedAt: null,
      error: null,
    });
    expect(await store.runFor(bob, runId)).toBeNull();
    expect(await store.updateRun(bob, runId, { status: 'failed' })).toBeNull();
    const updated = await store.updateRun(alice, runId, { status: 'succeeded' });
    expect(updated?.status).toBe('succeeded');
    expect(updated?.endedAt).not.toBeNull();

    const bobRuns = await store.runsOf(bob);
    expect(bobRuns.some((run) => run.id === runId)).toBe(false);
  });

  it('consumes a pairing code exactly once even when redeemed twice', async () => {
    const code = await store.createPairingCode(alice, '');
    const first = await store.consumePairingCode(code.code);
    expect(first?.userId).toBe(alice);
    expect(await store.consumePairingCode(code.code)).toBeNull();
  });

  it('rejects an expired pairing code', async () => {
    const code = await store.createPairingCode(alice, '', -1000);
    expect(await store.consumePairingCode(code.code)).toBeNull();
  });

  it('rotates a token and stops accepting the previous one', async () => {
    const { device, token } = await store.createDevice({ userId: alice, name: 'rot', os: 'linux', capabilities: [] });
    const next = await store.rotateDevice(device.id);
    expect(next).not.toBeNull();
    expect(await store.findByToken(token)).toBeNull();
    expect((await store.findByToken(next as string))?.id).toBe(device.id);
  });

  it('persists plan, billing and usage per tenant', async () => {
    await store.setPlan(alice, 'creator');
    expect((await store.planOf(alice)).priceCny).toBe(69);
    expect((await store.planOf(bob)).priceCny).toBe(0);
    await store.charge({ userId: alice, runId: null, kind: 'tool', units: 1, costCny: 1.25 });
    const usage = await store.usage(alice);
    expect(usage.costCny).toBeGreaterThanOrEqual(1.25);
    expect(usage.plan.priceCny).toBe(69);
    expect((await store.billingOf(bob)).length).toBe(0);
  });

  it('reports aggregates without leaking tenant ids', async () => {
    expect(await store.runsCount()).toBeGreaterThan(0);
    expect(await store.tenantCount()).toBeGreaterThanOrEqual(2);
  });
});
