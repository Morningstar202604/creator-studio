import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { Database } from 'better-sqlite3';
import type { ArtifactKind, Run, ToolGrant } from '@creator-studio/protocol';
import { AgentIdSchema, ProjectStageSchema } from '@creator-studio/protocol';
import { ModelGateway } from '@creator-studio/model-gateway';
import { MemoryAuditSink, ToolHost, ToolError, fenceUntrusted, type ToolDefinition } from '@creator-studio/tools';
import {
  SqliteRunStore,
  SqliteProjectStore,
  SqliteArtifactStore,
  SqliteSettingsStore,
  ArtifactCorruptError,
  DEFAULT_BUDGET,
  openDatabase,
} from '@creator-studio/store-sqlite';
import { EventBus, SSE_HEARTBEAT_MS, writeHeartbeat, writeSseEvent } from './stream.js';
import {
  PROMPTS,
  UPSTREAM,
  artifactPathFor,
  buildUpstreamContext,
  isGenerateKind,
  parseGenerated,
  renderMarkdown,
} from './generate.js';
import { buildChecklist, buildZip, exportFileName, isExportableKind } from './publish.js';
import { AgentRunner, type AgentSpec, type RunOutcome } from '@creator-studio/agent-core';

/** Rejects absolute paths and any `..` segment before it reaches the archive. */
function resolveRelativeName(path: string): string {
  const normalized = normalize(path).split(String.fromCharCode(92)).join('/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`absolute artifact path: ${path}`);
  }
  if (normalized.split('/').includes('..')) {
    throw new Error(`traversal in artifact path: ${path}`);
  }
  return normalized.split(sep).filter((part) => part !== '.').join('/');
}

export type DaemonOptions = {
  dbPath: string;
  workspaceRoot: string;
  deviceId: string;
  modelGateway: ModelGateway;
  agents?: AgentSpec[];
  grants?: ToolGrant[];
  logger?: boolean;
};

export type Daemon = {
  app: FastifyInstance;
  close(): Promise<void>;
  db: Database;
};

const DEFAULT_AGENTS: AgentSpec[] = [
  {
    id: 'scriptwriter',
    systemPrompt:
      '你是中文长视频编剧。用简洁、具体、有信息量的中文写作，避免空洞套话。需要资料时调用 fs.read。',
    tools: ['fs.read', 'fs.write'],
    maxOutputTokens: 2048,
  },
  {
    id: 'editor',
    systemPrompt: '你是剪辑助理，负责整理素材与删除废弃文件。破坏性操作前必须请求确认。',
    tools: ['fs.read', 'fs.delete'],
    maxOutputTokens: 1024,
  },
];

function registerFileTools(host: ToolHost, workspaceRoot: string): void {
  const read: ToolDefinition<{ path: string }, { content: string; bytes: number }> = {
    name: 'fs.read',
    risk: 'low',
    approvalKind: null,
    pathArg: 'path',
    inputSchema: (input) => {
      if (typeof input !== 'object' || input === null) throw new ToolError('INVALID_INPUT', 'input must be object');
      const path = (input as Record<string, unknown>).path;
      if (typeof path !== 'string') throw new ToolError('INVALID_INPUT', 'path required');
      return { path };
    },
    execute: async (input) => {
      const { readFileSync } = await import('node:fs');
      const content = readFileSync(join(workspaceRoot, input.path), 'utf8');
      return { content, bytes: Buffer.byteLength(content) };
    },
  };

  const write: ToolDefinition<{ path: string; text: string }, { bytes: number; path: string }> = {
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
      const { writeFileSync } = await import('node:fs');
      const target = join(workspaceRoot, input.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, input.text, 'utf8');
      return { bytes: Buffer.byteLength(input.text), path: input.path };
    },
  };

  const del: ToolDefinition<{ path: string }, { deleted: string }> = {
    name: 'fs.delete',
    risk: 'high',
    approvalKind: 'delete',
    pathArg: 'path',
    inputSchema: (input) => {
      const path = (input as Record<string, unknown>).path;
      if (typeof path !== 'string') throw new ToolError('INVALID_INPUT', 'path required');
      return { path };
    },
    execute: async (input) => {
      const { rmSync } = await import('node:fs');
      rmSync(join(workspaceRoot, input.path), { force: true });
      return { deleted: input.path };
    },
  };

  host.register(read);
  host.register(write);
  host.register(del);
}

export async function createDaemon(options: DaemonOptions): Promise<Daemon> {
  mkdirSync(dirname(options.dbPath), { recursive: true });
  mkdirSync(options.workspaceRoot, { recursive: true });

  const db = openDatabase({ path: options.dbPath });
  const projectStore = new SqliteProjectStore(db);
  const runStore = new SqliteRunStore(db);
  const artifactStore = new SqliteArtifactStore(db, options.workspaceRoot);
  const settingsStore = new SqliteSettingsStore(db);

  // tool_grants references devices(id); register this machine on first boot so
  // per-device grants can be stored without an explicit pairing step.
  db.prepare(
    `INSERT INTO devices (id, user_id, name, os, public_key, capabilities, last_seen_at, revoked_at)
     VALUES (?, 'local-user', ?, ?, 'local-device-key', '[]', ?, NULL)
     ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  ).run(
    options.deviceId,
    `${process.platform}-local`,
    process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
    new Date().toISOString(),
  );
  const audit = new MemoryAuditSink();
  const toolHost = new ToolHost({ workspaceRoot: options.workspaceRoot, audit });
  registerFileTools(toolHost, options.workspaceRoot);

  const agents = options.agents ?? DEFAULT_AGENTS;
  const grants = options.grants ?? [
    { id: 'g-read', deviceId: options.deviceId, tool: 'fs.read', scope: '**', mode: 'auto' },
    { id: 'g-write', deviceId: options.deviceId, tool: 'fs.write', scope: '**', mode: 'auto' },
    { id: 'g-delete', deviceId: options.deviceId, tool: 'fs.delete', scope: '**', mode: 'ask' },
  ];

  const appendEvent = runStore.appendEvent.bind(runStore);
  runStore.appendEvent = (event) => {
    appendEvent(event);
    bus.publish(event);
  };

  // Crash recovery: a run left in `running` means the previous process died mid-step.
  // Mark it failed with a distinct code instead of leaving a zombie the UI polls forever.
  const staleRuns = db
    .prepare("SELECT id FROM runs WHERE status IN ('running','queued')")
    .all() as Array<{ id: string }>;
  for (const stale of staleRuns) {
    runStore.patchRun(stale.id, {
      status: 'failed',
      endedAt: new Date().toISOString(),
      error: { code: 'INTERRUPTED', message: 'daemon restarted while this run was in flight', retryable: true },
    });
    try {
      const seq = runStore.nextEventSeq(stale.id);
      runStore.appendEvent({
        id: `${stale.id}_e${seq}`,
        runId: stale.id,
        seq,
        type: 'error',
        payload: { code: 'INTERRUPTED' },
        ts: new Date().toISOString(),
      });
    } catch {
      // A duplicate seq means another writer won the race; nothing to repair.
    }
  }

  const runner = new AgentRunner({
    store: runStore,
    gateway: options.modelGateway,
    toolHost,
    agents,
    approvalProvider: {
      request: async () => null,
    },
    workspaceRoot: options.workspaceRoot,
    deviceId: options.deviceId,
    grantsFor: () => grants,
  });

  const bus = new EventBus();
  const app = Fastify({ logger: options.logger ?? false });
  await app.register(cors, {
    origin: (origin, callback) => {
      if (origin === undefined) return callback(null, true);
      const allowed =
        origin.startsWith('http://127.0.0.1:') ||
        origin.startsWith('http://localhost:') ||
        origin === 'tauri://localhost' ||
        origin === 'http://tauri.localhost' ||
        origin === 'https://tauri.localhost';
      callback(null, allowed);
    },
  });

  const CAPABILITIES = ['artifacts', 'generate', 'rewrite', 'stream', 'runs', 'settings'] as const;
  const startedAt = Date.now();

  app.get('/health', async () => ({
    ok: true,
    version: 0.1 as const,
    apiVersion: 2,
    capabilities: [...CAPABILITIES],
    workspaceRoot: options.workspaceRoot,
    os: process.platform,
    pid: process.pid,
    uptimeMs: Date.now() - startedAt,
    stats: {
      projects: projectStore.list().length,
      runs: (db.prepare('SELECT COUNT(*) AS c FROM runs').get() as { c: number }).c,
      artifacts: (db.prepare('SELECT COUNT(*) AS c FROM artifacts').get() as { c: number }).c,
      events: (db.prepare('SELECT COUNT(*) AS c FROM run_events').get() as { c: number }).c,
    },
  }));

  app.get('/v1/usage', async () => {
    const rows = db
      .prepare(
        `SELECT agent_id, status, COUNT(*) AS runs, SUM(used_tokens) AS tokens, SUM(used_cost_cny) AS cost,
                AVG((julianday(ended_at) - julianday(started_at)) * 86400) AS avg_seconds
         FROM runs
         WHERE started_at IS NOT NULL
         GROUP BY agent_id, status
         ORDER BY cost DESC`,
      )
      .all() as Array<{
      agent_id: string;
      status: string;
      runs: number;
      tokens: number | null;
      cost: number | null;
      avg_seconds: number | null;
    }>;

    const totals = db
      .prepare(
        `SELECT COUNT(*) AS runs, COALESCE(SUM(used_tokens),0) AS tokens,
                COALESCE(SUM(used_cost_cny),0) AS cost
         FROM runs`,
      )
      .get() as { runs: number; tokens: number; cost: number };

    return {
      totals,
      budget: settingsStore.getBudget(),
      byAgent: rows.map((row) => ({
        agentId: row.agent_id,
        status: row.status,
        runs: row.runs,
        tokens: row.tokens ?? 0,
        costCny: Number((row.cost ?? 0).toFixed(4)),
        avgSeconds: row.avg_seconds === null ? null : Number(row.avg_seconds.toFixed(1)),
      })),
    };
  });

  app.get('/v1/tools', async () => ({ tools: toolHost.list() }));

  app.get('/v1/audit', async () => ({ records: audit.all() }));

  app.post('/v1/projects', async (request, reply) => {
    const body = request.body as { title?: unknown; platform?: unknown } | undefined;
    if (typeof body?.title !== 'string' || body.title.trim() === '') {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'title is required' } });
    }
    const platform = typeof body.platform === 'string' ? body.platform : 'generic';
    if (!['bilibili', 'youtube', 'xiaohongshu', 'generic'].includes(platform)) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'unknown platform' } });
    }
    const project = projectStore.create({
      id: randomUUID(),
      ownerId: 'local-user',
      title: body.title,
      platform: platform as 'bilibili',
      workspacePath: options.workspaceRoot,
    });
    return reply.code(201).send({ project });
  });

  app.get('/v1/projects', async () => ({ projects: projectStore.list() }));

  app.get('/v1/projects/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = projectStore.get(id);
    if (project === null) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });
    return { project };
  });

  app.post('/v1/projects/:id/stage', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { stage?: unknown } | undefined;
    const parsed = ProjectStageSchema.safeParse(body?.stage);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'unknown stage' } });
    }
    const project = projectStore.get(id);
    if (project === null) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });
    projectStore.advanceStage(id, parsed.data);
    return { project: projectStore.get(id) };
  });

  app.post('/v1/projects/:id/runs', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { agentId?: unknown; message?: unknown; maxTokens?: unknown; maxCostCny?: unknown } | undefined;

    const project = projectStore.get(id);
    if (project === null) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });

    const agentParsed = AgentIdSchema.safeParse(body?.agentId ?? 'scriptwriter');
    if (!agentParsed.success) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'unknown agentId' } });
    }
    if (typeof body?.message !== 'string' || body.message.trim() === '') {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'message is required' } });
    }

    const runId = randomUUID();
    const createdAt = new Date().toISOString();
    const run: Run = {
      id: runId,
      projectId: id,
      parentRunId: null,
      agentId: agentParsed.data,
      executionMode: 'local',
      status: 'queued',
      modelProfileId: options.modelGateway.listProfiles()[0]?.id ?? 'default',
      budget: {
        maxTokens: typeof body.maxTokens === 'number' ? body.maxTokens : 200_000,
        maxCostCny: typeof body.maxCostCny === 'number' ? body.maxCostCny : 5,
        usedTokens: 0,
        usedCostCny: 0,
      },
      inputRef: null,
      outputRef: null,
      error: null,
      startedAt: null,
      endedAt: null,
      createdAt,
    };
    runStore.createRun(run);
    return reply.code(202).send({ run });
  });

  app.get('/v1/projects/:id/artifacts', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (projectStore.get(id) === null) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });
    }
    return { artifacts: artifactStore.list(id) };
  });

  app.get('/v1/artifacts/:artifactId', async (request, reply) => {
    const { artifactId } = request.params as { artifactId: string };
    try {
      const result = artifactStore.read(artifactId);
      if (result === null) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: artifactId } });
      return result;
    } catch (error) {
      if (error instanceof ArtifactCorruptError) {
        return reply.code(409).send({ error: { code: 'ARTIFACT_CORRUPT', message: error.message } });
      }
      throw error;
    }
  });

  app.post('/v1/projects/:id/artifacts', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (projectStore.get(id) === null) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });
    }
    const body = request.body as
      | { kind?: unknown; path?: unknown; content?: unknown; runId?: unknown; baseName?: unknown }
      | undefined;
    if (typeof body?.path !== 'string' || typeof body.content !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'path and content are required' } });
    }
    const kind = typeof body.kind === 'string' ? body.kind : 'script';
    if (
      ![
        'topic-card',
        'research-notes',
        'script',
        'shot-list',
        'subtitle',
        'publish-pack',
        'review-report',
        'image',
        'audio',
        'other',
      ].includes(kind)
    ) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'unknown kind' } });
    }
    try {
      const artifact = artifactStore.save({
        id: randomUUID(),
        projectId: id,
        runId: typeof body.runId === 'string' ? body.runId : null,
        kind: kind as 'script',
        path: body.path,
        content: body.content,
        mime: kind === 'image' ? 'image/png' : kind === 'audio' ? 'audio/mpeg' : 'text/markdown',
      });
      return reply.code(201).send({ artifact });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('PATH_ESCAPE')) {
        return reply.code(400).send({ error: { code: 'PATH_ESCAPE', message } });
      }
      throw error;
    }
  });

  app.post('/v1/projects/:id/generate', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = projectStore.get(id);
    if (project === null) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });
    }
    const body = request.body as { kind?: unknown; context?: unknown; includeUpstream?: unknown } | undefined;
    if (typeof body?.kind !== 'string' || !isGenerateKind(body.kind)) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'unknown kind' } });
    }
    if (typeof body.context !== 'string' || body.context.trim() === '') {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'context is required' } });
    }

    const kind = body.kind;
    const prompt = PROMPTS[kind];
    const includeUpstream = body.includeUpstream !== false;

    // Pull the newest artifact of each upstream stage so later stages build on
    // earlier output instead of starting from scratch.
    let upstreamText = '';
    if (includeUpstream) {
      const docs: Array<{ kind: string; content: string }> = [];
      for (const upstreamKind of UPSTREAM[kind]) {
        const latest = artifactStore.latest(id, upstreamKind as ArtifactKind);
        if (latest !== null) docs.push({ kind: upstreamKind, content: latest.content });
      }
      upstreamText = buildUpstreamContext(docs, fenceUntrusted);
    }

    const userContent =
      upstreamText === ''
        ? prompt.user(body.context)
        : `${prompt.user(body.context)}

以下是本项目的上游产物，请在此基础上继续：

${upstreamText}`;

    let raw = '';
    try {
      for await (const delta of options.modelGateway.chat(
        { agentId: 'scriptwriter' },
        {
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: userContent },
          ],
          maxOutputTokens: 2048,
          temperature: 0.6,
        },
      )) {
        if (delta.kind === 'text') raw += delta.text;
      }
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'MODEL_ERROR';
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(502).send({ error: { code, message } });
    }

    let payload: unknown;
    try {
      payload = parseGenerated(kind, raw);
    } catch (error) {
      // Fail closed: a schema-invalid response must never reach the artifact store.
      return reply.code(502).send({
        error: { code: 'MODEL_BAD_OUTPUT', message: error instanceof Error ? error.message : String(error) },
      });
    }

    const version = artifactStore.nextVersion(id, kind, kind);
    const path = artifactPathFor(kind, version);
    const markdown = renderMarkdown(kind, payload);
    try {
      const artifact = artifactStore.save({
        id: randomUUID(),
        projectId: id,
        runId: null,
        kind,
        path,
        content: markdown,
        mime: 'text/markdown',
      });
      return reply.code(201).send({ artifact, payload });
    } catch (error) {
      return reply.code(500).send({
        error: { code: 'ARTIFACT_WRITE_FAILED', message: error instanceof Error ? error.message : String(error) },
      });
    }
  });

  app.get('/v1/projects/:id/checklist', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (projectStore.get(id) === null) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });
    }
    const artifacts = artifactStore.list(id);
    const items = buildChecklist(artifacts);
    return {
      items,
      ready: items.every((item) => item.ok),
      missing: items.filter((item) => !item.ok).map((item) => item.key),
    };
  });

  app.post('/v1/projects/:id/publish', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (projectStore.get(id) === null) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });
    }

    const artifacts = artifactStore.list(id);
    const items = buildChecklist(artifacts);
    const missing = items.filter((item) => !item.ok).map((item) => item.key);
    if (missing.length > 0) {
      // R1: fail closed before touching the filesystem.
      return reply.code(409).send({
        error: { code: 'CHECKLIST_INCOMPLETE', message: `missing: ${missing.join(', ')}` },
        missing,
      });
    }

    const entries: Array<{ name: string; content: Buffer }> = [];
    let totalBytes = 0;
    try {
      for (const artifact of artifacts) {
        if (!isExportableKind(artifact.kind)) continue;
        const detail = artifactStore.read(artifact.id);
        if (detail === null) continue;
        // Re-run the sandbox: a corrupted row must not smuggle a path into the zip.
        const safeName = resolveRelativeName(artifact.path);
        const buffer = Buffer.from(detail.content, 'utf8');
        totalBytes += buffer.length;
        if (totalBytes > 5 * 1024 * 1024) {
          return reply.code(413).send({ error: { code: 'EXPORT_TOO_LARGE', message: 'over 5MB' } });
        }
        entries.push({ name: safeName, content: buffer });
      }
    } catch (error) {
      return reply.code(500).send({
        error: { code: 'EXPORT_FAILED', message: error instanceof Error ? error.message : String(error) },
      });
    }

    const fileName = exportFileName();
    const outDir = join(options.workspaceRoot, 'publish-exports');
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, fileName);
    const zip = buildZip(entries);
    writeFileSync(outPath, zip);

    return reply.code(201).send({
      file: `publish-exports/${fileName}`,
      bytes: zip.length,
      entries: entries.map((entry) => entry.name),
      checklist: items,
    });
  });

  app.get('/v1/settings/models', async () => {
    const configured = settingsStore.listModels();
    const runtime = options.modelGateway.listProfiles();
    return {
      models: configured.length > 0 ? configured : runtime,
      activeModelId: runtime[0]?.id ?? null,
      source: configured.length > 0 ? 'stored' : 'runtime',
    };
  });

  app.post('/v1/settings/models', async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    if (typeof body?.name !== 'string' || typeof body.baseUrl !== 'string' || typeof body.model !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'name, baseUrl and model are required' } });
    }
    try {
      const profile = settingsStore.upsertModel({
        id: typeof body.id === 'string' ? body.id : randomUUID(),
        name: body.name,
        provider: (typeof body.provider === 'string' ? body.provider : 'openai-compatible') as never,
        baseUrl: body.baseUrl,
        model: body.model,
        apiKeyRef: typeof body.apiKeyRef === 'string' ? body.apiKeyRef : 'env:MODEL_API_KEY',
        contextWindow: typeof body.contextWindow === 'number' ? body.contextWindow : 128_000,
        priceInPerM: typeof body.priceInPerM === 'number' ? body.priceInPerM : 0,
        priceOutPerM: typeof body.priceOutPerM === 'number' ? body.priceOutPerM : 0,
        isLocal: body.isLocal === true,
      });
      return reply.code(201).send({ model: profile });
    } catch (error) {
      return reply.code(400).send({
        error: { code: 'INVALID_INPUT', message: error instanceof Error ? error.message : String(error) },
      });
    }
  });

  app.delete('/v1/settings/models/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    settingsStore.deleteModel(id);
    return reply.code(204).send();
  });

  app.get('/v1/settings/grants', async () => {
    const grants = settingsStore.listGrants(options.deviceId);
    return {
      deviceId: options.deviceId,
      grants,
      tools: toolHost.list().map((tool) => ({
        ...tool,
        mode: grants.find((grant) => grant.tool === tool.name)?.mode ?? 'deny',
      })),
    };
  });

  app.post('/v1/settings/grants', async (request, reply) => {
    const body = request.body as { tool?: unknown; mode?: unknown } | undefined;
    if (typeof body?.tool !== 'string' || typeof body.mode !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'tool and mode are required' } });
    }
    if (!['auto', 'ask', 'deny'].includes(body.mode)) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'unknown mode' } });
    }
    settingsStore.setGrantMode(options.deviceId, body.tool, body.mode as 'auto');
    return { grants: settingsStore.listGrants(options.deviceId) };
  });

  app.get('/v1/settings/budget', async () => ({ budget: settingsStore.getBudget() }));

  app.post('/v1/settings/budget', async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    const current = settingsStore.getBudget();
    const next = {
      monthlyCostCny: typeof body?.monthlyCostCny === 'number' ? body.monthlyCostCny : current.monthlyCostCny,
      perProjectCostCny:
        typeof body?.perProjectCostCny === 'number' ? body.perProjectCostCny : current.perProjectCostCny,
      warnAtPercent: typeof body?.warnAtPercent === 'number' ? body.warnAtPercent : current.warnAtPercent,
    };
    if (next.monthlyCostCny < 0 || next.perProjectCostCny < 0 || next.warnAtPercent < 0 || next.warnAtPercent > 100) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'budget values out of range' } });
    }
    return { budget: settingsStore.setBudget(next) };
  });

  app.get('/v1/onboarding', async () => ({
    completed: settingsStore.isOnboarded(),
    modelConfigured: settingsStore.listModels().length > 0 || options.modelGateway.listProfiles().length > 0,
    workspaceRoot: options.workspaceRoot,
    tools: toolHost.list().length,
  }));

  app.post('/v1/onboarding/complete', async () => {
    settingsStore.setOnboarded(true);
    return { completed: true };
  });

  app.get('/v1/settings/defaults', async () => ({ budget: { ...DEFAULT_BUDGET } }));

  app.post('/v1/rewrite', async (request, reply) => {
    const body = request.body as
      | { text?: unknown; instruction?: unknown; projectId?: unknown; agentId?: unknown }
      | undefined;
    if (typeof body?.text !== 'string' || body.text.trim() === '') {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'text is required' } });
    }
    const instruction = typeof body.instruction === 'string' ? body.instruction : '把这段改得更口语';
    const started = Date.now();
    let output = '';
    try {
      for await (const delta of options.modelGateway.chat(
        { agentId: typeof body.agentId === 'string' ? body.agentId : 'scriptwriter' },
        {
          messages: [
            { role: 'system', content: '你是中文视频编剧。只输出改写后的正文，不要解释，不要加引号。' },
            { role: 'user', content: `改写要求：${instruction}

原文：
${body.text}` },
          ],
          maxOutputTokens: 1024,
          temperature: 0.5,
        },
      )) {
        if (delta.kind === 'text') output += delta.text;
      }
      return { rewritten: output, durationMs: Date.now() - started };
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'MODEL_ERROR';
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(502).send({ error: { code, message } });
    }
  });

  app.get('/v1/runs', async (request) => {
    const query = request.query as { status?: string; projectId?: string; limit?: string };
    const limit = Math.min(Number.parseInt(query.limit ?? '50', 10) || 50, 200);
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (query.status !== undefined) {
      clauses.push('status = ?');
      params.push(query.status);
    }
    if (query.projectId !== undefined) {
      clauses.push('project_id = ?');
      params.push(query.projectId);
    }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
    const rows = db
      .prepare(`SELECT id FROM runs ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, limit) as Array<{ id: string }>;
    return {
      runs: rows
        .map((row) => runStore.getRun(row.id))
        .filter((value): value is NonNullable<typeof value> => value !== null),
    };
  });

  app.get('/v1/runs/:runId', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const run = runStore.getRun(runId);
    if (run === null) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: runId } });
    return { run, steps: runStore.listSteps(runId), approvals: runStore.listApprovals(runId) };
  });

  app.get('/v1/runs/:runId/events', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const query = request.query as { after?: string };
    const after = query.after === undefined ? -1 : Number.parseInt(query.after, 10);
    if (Number.isNaN(after)) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'after must be a number' } });
    }
    return { events: runStore.listEvents(runId, after) };
  });

  app.get('/v1/runs/:runId/stream', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const query = request.query as { after?: string };
    const after = query.after === undefined ? -1 : Number.parseInt(query.after, 10);
    if (Number.isNaN(after)) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'after must be a number' } });
    }
    if (runStore.getRun(runId) === null) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: runId } });
    }

    reply.hijack();
    const raw = reply.raw;
    // reply.hijack() bypasses the CORS plugin, so the SSE response must carry the
    // origin header itself or EventSource is blocked in the Tauri webview.
    const origin = request.headers.origin;
    const allowedOrigin =
      origin !== undefined &&
      (origin.startsWith('http://127.0.0.1:') ||
        origin.startsWith('http://localhost:') ||
        origin === 'tauri://localhost' ||
        origin === 'http://tauri.localhost' ||
        origin === 'https://tauri.localhost')
        ? origin
        : null;

    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...(allowedOrigin === null
        ? {}
        : { 'access-control-allow-origin': allowedOrigin, vary: 'Origin' }),
    });

    const write = (chunk: string): void => {
      if (!raw.writableEnded) raw.write(chunk);
    };

    let lastSeq = after;
    for (const event of runStore.listEvents(runId, after)) {
      writeSseEvent(write, { type: event.type, data: event });
      lastSeq = event.seq;
    }
    writeHeartbeat(write);

    const unsubscribe = bus.subscribe(runId, (event) => {
      if (event.seq <= lastSeq) return;
      lastSeq = event.seq;
      writeSseEvent(write, { type: event.type, data: event });
    });

    const heartbeat = setInterval(() => writeHeartbeat(write), SSE_HEARTBEAT_MS);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
  });

  app.post('/v1/runs/:runId/execute', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const body = request.body as { message?: unknown; agentId?: unknown } | undefined;
    if (typeof body?.message !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'message is required' } });
    }
    const run = runStore.getRun(runId);
    if (run === null) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: runId } });

    const agentParsed = AgentIdSchema.safeParse(body.agentId ?? run.agentId);
    if (!agentParsed.success) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'unknown agentId' } });
    }

    const outcome = await runner.run({
      runId,
      agentId: agentParsed.data,
      messages: [{ role: 'user', content: body.message }],
    });

    return reply.code(200).send({ outcome, run: runStore.getRun(runId) });
  });

  app.post('/v1/approvals/:approvalId', async (request, reply) => {
    const { approvalId } = request.params as { approvalId: string };
    const body = request.body as { decision?: unknown } | undefined;
    const decision = body?.decision;
    if (decision !== 'approved' && decision !== 'rejected') {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'decision must be approved|rejected' } });
    }
    const approval = runStore.getApproval(approvalId);
    if (approval === null) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: approvalId } });
    if (approval.decision !== 'pending') {
      return reply.code(409).send({ error: { code: 'ALREADY_DECIDED', message: approval.decision } });
    }
    db.prepare('UPDATE approvals SET decision = ?, decided_at = ?, decided_by = ? WHERE id = ?').run(
      decision,
      new Date().toISOString(),
      'local-user',
      approvalId,
    );
    return { approval: runStore.getApproval(approvalId) };
  });

  app.get('/v1/approvals', async (request) => {
    const query = request.query as { status?: string };
    const status = query.status ?? 'pending';
    const rows = db
      .prepare('SELECT id FROM approvals WHERE decision = ? ORDER BY requested_at DESC')
      .all(status) as Array<{ id: string }>;
    return { approvals: rows.map((row) => runStore.getApproval(row.id)).filter((value) => value !== null) };
  });

  return {
    app,
    db,
    async close(): Promise<void> {
      await app.close();
      db.close();
    },
  };
}
