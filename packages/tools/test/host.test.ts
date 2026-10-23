import type { Approval, ToolGrant } from '@creator-studio/protocol';
import { describe, expect, it } from 'vitest';
import { MemoryAuditSink, ToolHost, ToolError } from '../src/index.js';
import type { ToolDefinition } from '../src/index.js';

const grant = (overrides: Partial<ToolGrant> = {}): ToolGrant => ({
  id: 'g1',
  deviceId: 'd1',
  tool: 'fs.probe',
  scope: '**',
  mode: 'auto',
  ...overrides,
});

const approval = (overrides: Partial<Approval> = {}): Approval => ({
  id: 'ap1',
  runId: 'r1',
  stepId: 's1',
  kind: 'delete',
  payload: {},
  decision: 'approved',
  requestedAt: '2026-10-21T10:00:00.000Z',
  decidedAt: '2026-10-21T10:01:00.000Z',
  decidedBy: 'u1',
  ...overrides,
});

function makeHost(grantMode: 'auto' | 'ask' | 'deny' = 'auto') {
  const audit = new MemoryAuditSink();
  const host = new ToolHost({ workspaceRoot: process.cwd(), audit });
  const calls: unknown[] = [];

  const probe: ToolDefinition<{ path: string }, { echoed: string }> = {
    name: 'fs.probe',
    risk: 'low',
    approvalKind: null,
    pathArg: 'path',
    inputSchema: (input) => {
      if (typeof input !== 'object' || input === null) throw new ToolError('INVALID_INPUT', 'object required');
      const path = (input as Record<string, unknown>).path;
      if (typeof path !== 'string') throw new ToolError('INVALID_INPUT', 'path required');
      return { path };
    },
    execute: async (input) => {
      calls.push(input);
      return { echoed: input.path };
    },
  };
  host.register(probe);

  const deleter: ToolDefinition<{ path: string }, { deleted: string }> = {
    name: 'fs.delete',
    risk: 'high',
    approvalKind: 'delete',
    pathArg: 'path',
    inputSchema: (input) => {
      const path = (input as Record<string, unknown>).path;
      if (typeof path !== 'string') throw new ToolError('INVALID_INPUT', 'path required');
      return { path };
    },
    execute: async (input) => ({ deleted: input.path }),
  };
  host.register(deleter);

  return { host, audit, calls, grant: grant({ mode: grantMode }) };
}

const ctx = (grants: ToolGrant[], approvalValue: Approval | null = null) => ({
  deviceId: 'd1',
  runId: 'r1',
  workspaceRoot: process.cwd(),
  grants,
  approval: approvalValue,
});

describe('R1 default deny at the host', () => {
  it('rejects a call with no grant and records an audit entry', async () => {
    const { host, audit } = makeHost();
    const result = await host.execute({ name: 'fs.probe', input: { path: 'a.md' }, context: ctx([]) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NO_GRANT');
    const records = audit.all();
    expect(records).toHaveLength(1);
    expect(records[0]?.decision).toBe('deny');
    expect(records[0]?.reason).toBe('NO_GRANT');
  });

  it('rejects an unknown tool', async () => {
    const { host } = makeHost();
    const result = await host.execute({ name: 'nope', input: {}, context: ctx([grant()]) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('TOOL_NOT_FOUND');
  });

  it('runs an auto-granted call', async () => {
    const { host, calls } = makeHost();
    const result = await host.execute({
      name: 'fs.probe',
      input: { path: 'a.md' },
      context: ctx([grant()]),
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe('R3 path sandbox integration', () => {
  it('rejects traversal before touching the tool', async () => {
    const { host, calls, audit } = makeHost();
    const result = await host.execute({
      name: 'fs.probe',
      input: { path: '../../../etc/passwd' },
      context: ctx([grant({ scope: '**' })]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PATH_ESCAPE');
    expect(calls).toHaveLength(0);
    expect(audit.all()[0]?.reason).toBe('PATH_ESCAPE');
  });
});

describe('R4 approval gate', () => {
  it('requires an approval for a high-risk tool even when auto-granted', async () => {
    const { host } = makeHost();
    const result = await host.execute({
      name: 'fs.delete',
      input: { path: 'a.md' },
      context: ctx([grant({ tool: 'fs.delete' })], null),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('APPROVAL_REQUIRED');
  });

  it('runs with a matching approved approval', async () => {
    const { host } = makeHost();
    const result = await host.execute({
      name: 'fs.delete',
      input: { path: 'a.md' },
      context: ctx([grant({ tool: 'fs.delete' })], approval()),
    });
    expect(result.ok).toBe(true);
  });

  it('rejects an approval of the wrong kind', async () => {
    const { host } = makeHost();
    const result = await host.execute({
      name: 'fs.delete',
      input: { path: 'a.md' },
      context: ctx([grant({ tool: 'fs.delete' })], approval({ kind: 'publish' })),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('APPROVAL_REQUIRED');
  });

  it('rejects a pending approval', async () => {
    const { host } = makeHost();
    const result = await host.execute({
      name: 'fs.delete',
      input: { path: 'a.md' },
      context: ctx([grant({ tool: 'fs.delete' })], approval({ decision: 'pending' })),
    });
    expect(result.ok).toBe(false);
  });

  it('consumes an approval so it cannot be replayed', async () => {
    const { host } = makeHost();
    const first = await host.execute({
      name: 'fs.delete',
      input: { path: 'a.md' },
      context: ctx([grant({ tool: 'fs.delete' })], approval()),
    });
    const second = await host.execute({
      name: 'fs.delete',
      input: { path: 'b.md' },
      context: ctx([grant({ tool: 'fs.delete' })], approval()),
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('APPROVAL_CONSUMED');
  });

  it('requires approval when the grant mode is ask', async () => {
    const { host } = makeHost('ask');
    const result = await host.execute({
      name: 'fs.probe',
      input: { path: 'a.md' },
      context: ctx([grant({ mode: 'ask' })], null),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('APPROVAL_REQUIRED');
  });
});

describe('R5 audit trail', () => {
  it('writes exactly one record per call', async () => {
    const { host, audit } = makeHost();
    await host.execute({ name: 'fs.probe', input: { path: 'a.md' }, context: ctx([grant()]) });
    await host.execute({ name: 'fs.probe', input: { path: 'b.md' }, context: ctx([]) });
    expect(audit.all()).toHaveLength(2);
  });

  it('records the target and duration', async () => {
    const { host, audit } = makeHost();
    await host.execute({ name: 'fs.probe', input: { path: 'a.md' }, context: ctx([grant()]) });
    const record = audit.all()[0];
    expect(record?.target).toBe('a.md');
    expect(record?.durationMs).toBeGreaterThanOrEqual(0);
    expect(record?.ok).toBe(true);
  });
});

describe('input validation and failures', () => {
  it('maps an input validation error', async () => {
    const { host } = makeHost();
    const result = await host.execute({ name: 'fs.probe', input: {}, context: ctx([grant()]) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_INPUT');
  });

  it('maps a thrown tool error', async () => {
    const { host } = makeHost();
    host.register({
      name: 'boom',
      risk: 'low',
      approvalKind: null,
      inputSchema: () => ({}),
      execute: async () => {
        throw new ToolError('EXECUTION_FAILED', 'exploded');
      },
    });
    const result = await host.execute({
      name: 'boom',
      input: {},
      context: ctx([grant({ tool: 'boom' })]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('EXECUTION_FAILED');
  });

  it('times out a slow tool', async () => {
    const audit = new MemoryAuditSink();
    const host = new ToolHost({ workspaceRoot: process.cwd(), audit, defaultTimeoutMs: 20 });
    host.register({
      name: 'slow',
      risk: 'low',
      approvalKind: null,
      inputSchema: () => ({}),
      execute: () => new Promise((resolve) => setTimeout(resolve, 200)),
    });
    const result = await host.execute({
      name: 'slow',
      input: {},
      context: ctx([grant({ tool: 'slow' })]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('TIMEOUT');
  });
});

describe('list', () => {
  it('exposes tool metadata without implementations', () => {
    const { host } = makeHost();
    const listed = host.list();
    expect(listed.map((tool) => tool.name).sort()).toEqual(['fs.delete', 'fs.probe']);
    for (const tool of listed) {
      expect(Object.keys(tool).sort()).toEqual(['approvalKind', 'name', 'risk']);
    }
  });
});
