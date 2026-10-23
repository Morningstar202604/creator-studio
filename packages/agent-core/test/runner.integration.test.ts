import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { Approval, ModelProfile, Run, ToolGrant } from '@creator-studio/protocol';
import { ModelGateway } from '@creator-studio/model-gateway';
import { ToolHost, ToolError, type ToolDefinition } from '@creator-studio/tools';
import { openDatabase, SqliteRunStore } from '@creator-studio/store-sqlite';
import { AgentRunner, type ApprovalProvider } from '../src/index.js';
import { FakeOpenAiServer, type ScriptedTurn } from './fake-openai.js';

const iso = '2026-10-21T10:00:00.000Z';
const profile: ModelProfile = {
  id: 'm1',
  userId: 'u1',
  name: 'fake',
  provider: 'openai-compatible',
  baseUrl: '',
  model: 'fake-model',
  apiKeyRef: 'keychain:fake',
  contextWindow: 128_000,
  priceInPerM: 1_000,
  priceOutPerM: 2_000,
  isLocal: true,
};

let workspace: string;
let server: FakeOpenAiServer;
let db: ReturnType<typeof openDatabase>;
let store: SqliteRunStore;
let gateway: ModelGateway;
let toolHost: ToolHost;
let sequence = 0;

const autoApprove: ApprovalProvider = {
  request: async (kind) => makeApproval(kind, 'approved'),
};
const pauseForApproval: ApprovalProvider = {
  request: async () => null,
};

function makeApproval(kind: Approval['kind'], decision: Approval['decision']): Approval {
  return {
    id: `ap_${kind}_${decision}`,
    runId: 'r1',
    stepId: 's1',
    kind,
    payload: {},
    decision,
    requestedAt: iso,
    decidedAt: decision === 'pending' ? null : iso,
    decidedBy: decision === 'pending' ? null : 'u1',
  };
}

function seedProjectAndRun(budget = { maxTokens: 10_000, maxCostCny: 100 }): Run {
  sequence += 1;
  const projectId = `p${sequence}`;
  const runId = `r${sequence}`;
  db.prepare(
    `INSERT INTO projects (id, owner_id, title, platform, stage, created_at, updated_at)
     VALUES (?, 'u1', 'T', 'bilibili', 'script', ?, ?)`,
  ).run(projectId, iso, iso);

  const run: Run = {
    id: runId,
    projectId,
    parentRunId: null,
    agentId: 'scriptwriter',
    executionMode: 'local',
    status: 'queued',
    modelProfileId: 'm1',
    budget: { maxTokens: budget.maxTokens, maxCostCny: budget.maxCostCny, usedTokens: 0, usedCostCny: 0 },
    inputRef: null,
    outputRef: null,
    error: null,
    startedAt: null,
    endedAt: null,
    createdAt: iso,
  };
  store.createRun(run);
  return run;
}

function registerTools(host: ToolHost): void {
  const readNote: ToolDefinition<{ path: string }, { content: string }> = {
    name: 'fs.read',
    risk: 'low',
    approvalKind: null,
    pathArg: 'path',
    inputSchema: (input) => {
      if (typeof input !== 'object' || input === null) throw new ToolError('INVALID_INPUT', 'object');
      const path = (input as Record<string, unknown>).path;
      if (typeof path !== 'string') throw new ToolError('INVALID_INPUT', 'path');
      return { path };
    },
    execute: async (input) => ({ content: readFileSync(join(workspace, input.path), 'utf8') }),
  };

  const writeNote: ToolDefinition<{ path: string; text: string }, { bytes: number }> = {
    name: 'fs.write',
    risk: 'medium',
    approvalKind: null,
    pathArg: 'path',
    inputSchema: (input) => {
      const record = input as Record<string, unknown>;
      if (typeof record.path !== 'string' || typeof record.text !== 'string') {
        throw new ToolError('INVALID_INPUT', 'path and text required');
      }
      return { path: record.path, text: record.text };
    },
    execute: async (input) => {
      const target = join(workspace, input.path);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, input.text, 'utf8');
      return { bytes: Buffer.byteLength(input.text) };
    },
  };

  const deleteNote: ToolDefinition<{ path: string }, { deleted: string }> = {
    name: 'fs.delete',
    risk: 'high',
    approvalKind: 'delete',
    pathArg: 'path',
    inputSchema: (input) => {
      const path = (input as Record<string, unknown>).path;
      if (typeof path !== 'string') throw new ToolError('INVALID_INPUT', 'path');
      return { path };
    },
    execute: async (input) => ({ deleted: input.path }),
  };

  host.register(readNote);
  host.register(writeNote);
  host.register(deleteNote);
}

function runner(overrides: {
  approvalProvider?: ApprovalProvider;
  maxSteps?: number;
  grants?: ToolGrant[];
  agents?: Parameters<typeof AgentRunner>[0]['agents'];
} = {}): AgentRunner {
  return new AgentRunner({
    store,
    gateway,
    toolHost,
    approvalProvider: overrides.approvalProvider ?? autoApprove,
    workspaceRoot: workspace,
    deviceId: 'd1',
    agents: overrides.agents ?? [
      { id: 'scriptwriter', systemPrompt: 'you write scripts', tools: ['fs.read', 'fs.write'] },
      { id: 'editor', systemPrompt: 'you edit', tools: ['fs.delete'] },
    ],
    ...(overrides.maxSteps === undefined ? {} : { maxStepsPerRun: overrides.maxSteps }),
    ...(overrides.grants === undefined ? {} : { grantsFor: () => overrides.grants ?? [] }),
  });
}

const allowAll: ToolGrant[] = [
  { id: 'g1', deviceId: 'd1', tool: 'fs.read', scope: '**', mode: 'auto' },
  { id: 'g2', deviceId: 'd1', tool: 'fs.write', scope: '**', mode: 'auto' },
  { id: 'g3', deviceId: 'd1', tool: 'fs.delete', scope: '**', mode: 'auto' },
];

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'agent-ws-'));
  writeFileSync(join(workspace, 'notes.md'), 'reference material', 'utf8');
  server = new FakeOpenAiServer();
  await server.start();

  db = openDatabase({ path: join(workspace, 'test.db') });
  store = new SqliteRunStore(db);
  gateway = new ModelGateway({
    profiles: [{ ...profile, baseUrl: server.baseUrl }],
    resolveKey: async () => 'sk-fake',
    sleep: async () => {},
  });
  toolHost = new ToolHost({ workspaceRoot: workspace, defaultTimeoutMs: 5_000 });
  registerTools(toolHost);
});

afterEach(() => {
  server.reset();
});

afterAll(async () => {
  db.close();
  await server.stop();
  rmSync(workspace, { recursive: true, force: true });
});

describe('AgentRunner over real HTTP + real SQLite + real tool host', () => {
  it('runs a single model turn and persists the transcript', async () => {
    const run = seedProjectAndRun();
    server.script([{ kind: 'text', text: '这是生成的脚本正文。', usage: { input: 30, output: 12 } }]);

    const outcome = await runner({ grants: allowAll }).run({
      runId: run.id,
      agentId: 'scriptwriter',
      messages: [{ role: 'user', content: '写一段开场' }],
    });

    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') return;
    expect(outcome.text).toBe('这是生成的脚本正文。');
    expect(outcome.steps).toBe(1);

    const persisted = store.getRun(run.id);
    expect(persisted?.status).toBe('succeeded');
    expect(persisted?.budget.usedTokens).toBe(42);
    expect(persisted?.startedAt).not.toBeNull();
    expect(persisted?.endedAt).not.toBeNull();

    const steps = store.listSteps(run.id);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.status).toBe('succeeded');
    expect(steps[0]?.kind).toBe('model');

    const events = store.listEvents(run.id).map((event) => event.type);
    expect(events).toContain('run.finished');
    expect(store.listEvents(run.id).map((event) => event.seq)).toEqual(
      [...store.listEvents(run.id).map((event) => event.seq)].sort((a, b) => a - b),
    );

    expect(server.requests).toHaveLength(1);
    const body = server.requests[0]?.body as { model?: string; stream?: boolean; messages?: unknown[] };
    expect(body.model).toBe('fake-model');
    expect(body.stream).toBe(true);
    expect(body.messages).toHaveLength(2);
  });

  it('executes a real tool call end to end and feeds the result back', async () => {
    const run = seedProjectAndRun();
    const turns: ScriptedTurn[] = [
      { kind: 'tool_call', id: 'c1', name: 'fs.read', args: { path: 'notes.md' }, usage: { input: 40, output: 10 } },
      { kind: 'text', text: '我看到资料了。', usage: { input: 60, output: 10 } },
    ];
    server.script(turns);

    const outcome = await runner({ grants: allowAll }).run({
      runId: run.id,
      agentId: 'scriptwriter',
      messages: [{ role: 'user', content: '读一下资料再写' }],
    });

    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') return;
    expect(outcome.text).toBe('我看到资料了。');
    expect(outcome.steps).toBe(2);

    // The second request must carry the tool result produced by the real fs tool.
    expect(server.requests).toHaveLength(2);
    const second = server.requests[1]?.body as { messages: Array<Record<string, unknown>> };
    const toolMessage = second.messages.find((message) => message.role === 'tool');
    expect(toolMessage).toBeDefined();
    expect(String(toolMessage?.content)).toContain('reference material');
    expect(toolMessage?.tool_call_id).toBe('c1');

    const toolEvents = store.listEvents(run.id).filter((event) => event.type === 'tool.result');
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]?.payload).toMatchObject({ tool: 'fs.read', ok: true });

    const steps = store.listSteps(run.id);
    expect(steps.map((step) => step.status)).toEqual(['succeeded', 'succeeded']);
  });

  it('writes a file through the tool host and verifies bytes on disk', async () => {
    const run = seedProjectAndRun();
    server.script([
      {
        kind: 'tool_call',
        id: 'c1',
        name: 'fs.write',
        args: { path: 'out/draft.md', text: '第一版脚本' },
        usage: { input: 20, output: 10 },
      },
      { kind: 'text', text: '写好了', usage: { input: 20, output: 5 } },
    ]);

    const outcome = await runner({ grants: allowAll }).run({
      runId: run.id,
      agentId: 'scriptwriter',
      messages: [{ role: 'user', content: '把脚本写进文件' }],
    });

    expect(outcome.status).toBe('succeeded');
    expect(readFileSync(join(workspace, 'out', 'draft.md'), 'utf8')).toBe('第一版脚本');
  });

  it('pauses and records a pending approval for a destructive tool', async () => {
    const run = seedProjectAndRun();
    server.script([
      { kind: 'tool_call', id: 'c1', name: 'fs.delete', args: { path: 'notes.md' }, usage: { input: 20, output: 8 } },
    ]);

    const outcome = await runner({ approvalProvider: pauseForApproval, grants: allowAll }).run({
      runId: run.id,
      agentId: 'editor',
      messages: [{ role: 'user', content: '删掉旧稿' }],
    });

    expect(outcome.status).toBe('waiting_approval');
    if (outcome.status !== 'waiting_approval') return;

    const approvals = store.listApprovals(run.id);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.decision).toBe('pending');
    expect(approvals[0]?.kind).toBe('delete');
    expect(store.getRun(run.id)?.status).toBe('waiting_approval');

    // The file must still exist: nothing ran.
    expect(readFileSync(join(workspace, 'notes.md'), 'utf8')).toBe('reference material');
  });

  it('refuses a tool call when the grant list is empty', async () => {
    const run = seedProjectAndRun();
    server.script([
      { kind: 'tool_call', id: 'c1', name: 'fs.read', args: { path: 'notes.md' }, usage: { input: 20, output: 8 } },
      { kind: 'text', text: '读不到', usage: { input: 20, output: 5 } },
    ]);

    const outcome = await runner({ grants: [] }).run({
      runId: run.id,
      agentId: 'scriptwriter',
      messages: [{ role: 'user', content: '读资料' }],
    });

    expect(outcome.status).toBe('succeeded');
    const second = server.requests[1]?.body as { messages: Array<Record<string, unknown>> };
    const toolMessage = second.messages.find((message) => message.role === 'tool');
    expect(String(toolMessage?.content)).toContain('NO_GRANT');

    const records = toolHost.auditRecords();
    expect(records.some((record) => record.tool === 'fs.read' && record.decision === 'deny')).toBe(true);
  });

  it('blocks a path traversal attempt before the tool runs', async () => {
    const run = seedProjectAndRun();
    server.script([
      {
        kind: 'tool_call',
        id: 'c1',
        name: 'fs.read',
        args: { path: '../../etc/passwd' },
        usage: { input: 20, output: 8 },
      },
      { kind: 'text', text: '被拦住了', usage: { input: 20, output: 5 } },
    ]);

    await runner({ grants: allowAll }).run({
      runId: run.id,
      agentId: 'scriptwriter',
      messages: [{ role: 'user', content: '读系统文件' }],
    });

    const second = server.requests[1]?.body as { messages: Array<Record<string, unknown>> };
    const toolMessage = second.messages.find((message) => message.role === 'tool');
    expect(String(toolMessage?.content)).toContain('PATH_ESCAPE');
  });

  it('maps an upstream 401 into a failed run with a persisted error', async () => {
    const run = seedProjectAndRun();
    server.script([{ kind: 'status', status: 401, body: '{"error":"bad key"}' }]);

    const outcome = await runner({ grants: allowAll }).run({
      runId: run.id,
      agentId: 'scriptwriter',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.code).toBe('MODEL_AUTH');

    const persisted = store.getRun(run.id);
    expect(persisted?.status).toBe('failed');
    expect(persisted?.error?.code).toBe('MODEL_AUTH');
  });

  it('pauses when the budget cannot cover the next call', async () => {
    const run = seedProjectAndRun({ maxTokens: 10, maxCostCny: 0.0001 });
    server.script([{ kind: 'text', text: '不该到这里', usage: { input: 1, output: 1 } }]);

    const outcome = await runner({ grants: allowAll }).run({
      runId: run.id,
      agentId: 'scriptwriter',
      messages: [{ role: 'user', content: 'x'.repeat(400) }],
    });

    expect(outcome.status).toBe('paused');
    if (outcome.status !== 'paused') return;
    expect(outcome.reason).toBe('BUDGET_EXCEEDED');
    expect(store.getRun(run.id)?.status).toBe('paused');
    expect(server.requests).toHaveLength(0);
  });

  it('stops at maxSteps when the model keeps calling tools', async () => {
    const run = seedProjectAndRun();
    server.script(
      Array.from({ length: 5 }, (): ScriptedTurn => ({
        kind: 'tool_call',
        id: 'c1',
        name: 'fs.read',
        args: { path: 'notes.md' },
        usage: { input: 10, output: 4 },
      })),
    );

    const outcome = await runner({ grants: allowAll, maxSteps: 3 }).run({
      runId: run.id,
      agentId: 'scriptwriter',
      messages: [{ role: 'user', content: 'loop' }],
    });

    expect(outcome.status).toBe('paused');
    if (outcome.status !== 'paused') return;
    expect(outcome.reason).toBe('MAX_STEPS');
    expect(outcome.steps).toBe(3);
  });

  it('rejects an unknown agent id before any network call', async () => {
    const run = seedProjectAndRun();
    const outcome = await new AgentRunner({
      store,
      gateway,
      toolHost,
      approvalProvider: autoApprove,
      workspaceRoot: workspace,
      deviceId: 'd1',
      agents: [],
    }).run({ runId: run.id, agentId: 'critic', messages: [] });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.code).toBe('UNKNOWN_AGENT');
    expect(server.requests).toHaveLength(0);
  });

  it('rejects a missing run', async () => {
    const outcome = await runner().run({
      runId: 'does-not-exist',
      agentId: 'scriptwriter',
      messages: [],
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.code).toBe('RUN_NOT_FOUND');
  });
});
