import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, sep } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import type { Database } from 'better-sqlite3';
import type { Run, ToolGrant } from '@creator-studio/protocol';
import { AgentIdSchema, ProjectStageSchema } from '@creator-studio/protocol';
import { ModelGateway, localEmbeddingProvider, type EmbeddingProvider } from '@creator-studio/model-gateway';
import { MemoryAuditSink, ToolHost, ToolError, type ToolDefinition } from '@creator-studio/tools';
import {
  SqliteRunStore,
  SqliteProjectStore,
  SqliteArtifactStore,
  SqliteSettingsStore,
  SqliteAutomationStore,
  SqliteMetricsStore,
  SqliteMemoryIndex,
  ArtifactCorruptError,
  DEFAULT_BUDGET,
  openDatabase,
} from '@creator-studio/store-sqlite';
import { EventBus, SSE_HEARTBEAT_MS, writeHeartbeat, writeSseEvent } from './stream.js';
import { isGenerateKind } from './generate.js';
import { buildChecklist, buildZip, exportFileName, isExportableKind } from './publish.js';
import { generateArtifact, ModelOutputError, type RetrieveFn } from './pipeline.js';
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
  /** Serve the built React app from this directory (web mode). */
  webRoot?: string;
  /** Background scheduler for automations; off in unit tests. */
  scheduler?: boolean;
  now?: () => Date;
  /**
   * Probe the model provider for a real `/embeddings` endpoint. Off by default:
   * most chat-only providers 404 there, and the local hash embedder needs no
   * network. Turn on when the configured model actually serves embeddings.
   */
  remoteEmbeddings?: boolean;
  /** Secret resolver (env/vault). Injecting one keeps tests hermetic. */
  resolveSecret?: (ref: string) => string | null;
  secretStore?: { set(name: string, value: string): string; delete(name: string): void };
};

export type Daemon = {
  app: FastifyInstance;
  close(): Promise<void>;
  db: Database;
};

const DEFAULT_AGENTS: AgentSpec[] = [
  {
    id: 'producer',
    systemPrompt:
      '你是制片人，负责拆解任务、安排顺序与汇报进度。先给计划再执行，不要越权替用户做决定。写作要具体，避免套话。',
    tools: ['fs.read', 'fs.write'],
    maxOutputTokens: 2048,
  },
  {
    id: 'scriptwriter',
    systemPrompt:
      '你是中文长视频编剧。用简洁、具体、有信息量的中文写作，避免空洞套话。需要资料时调用 fs.read。',
    tools: ['fs.read', 'fs.write'],
    maxOutputTokens: 2048,
  },
  {
    id: 'critic',
    systemPrompt: '你是审片人。只做事实核查、合规与风格一致性检查，不改写正文。指出问题要给出证据与修改建议。',
    tools: ['fs.read'],
    maxOutputTokens: 1536,
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
  const automationStore = new SqliteAutomationStore(db);
  const metricsStore = new SqliteMetricsStore(db);
  const clock = options.now ?? (() => new Date());

  // Retrieval prefers the provider's `/embeddings`; the probe runs lazily on the
  // first index call and the chosen provider is then stable for this process. Rows
  // record the provider id, so vectors from different spaces are never compared.
  const localEmbedding = localEmbeddingProvider();
  let embeddingProvider: EmbeddingProvider | null = null;
  const resolveEmbeddingProvider = async (): Promise<EmbeddingProvider> => {
    if (embeddingProvider !== null) return embeddingProvider;
    const configured = settingsStore.getEmbeddingModel();
    // Probe when an embedding model is explicitly configured, or when the operator
    // opted in for the chat model. Otherwise stay offline with the local embedder.
    const shouldProbe = configured !== null || options.remoteEmbeddings === true;
    const probe = shouldProbe
      ? await options.modelGateway.embed(['probe'], configured ?? undefined).catch(() => null)
      : null;
    embeddingProvider =
      probe === null || probe.length === 0 || (probe[0]?.length ?? 0) === 0
        ? localEmbedding
        : {
            id: 'remote',
            neural: true,
            embed: async (batch) =>
              (await options.modelGateway.embed(batch, configured ?? undefined).catch(() => null)) ??
              localEmbedding.embed(batch),
          };
    return embeddingProvider;
  };
  const memoryIndex = new SqliteMemoryIndex(db, resolveEmbeddingProvider);

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
    now: clock,
  });

  const bus = new EventBus();
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 8 * 1024 * 1024 });
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

  const AUTOMATION_KINDS: readonly string[] = ['topic-card', 'research-notes', 'publish-pack'];

function isAutomationKind(value: string): value is 'topic-card' | 'research-notes' | 'publish-pack' {
  return AUTOMATION_KINDS.includes(value);
}

  const CAPABILITIES = [
    'artifacts',
    'generate',
    'rewrite',
    'stream',
    'runs',
    'settings',
    'automations',
    'metrics',
    'library',
    'resume',
    'memory',
  ] as const;
  const startedAt = Date.now();

  const runtimeProfiles = options.modelGateway.listProfiles();
  const syncProfiles = (): void => {
    const stored = settingsStore.listModels();
    options.modelGateway.replaceProfiles(stored.length > 0 ? [...stored, ...runtimeProfiles] : runtimeProfiles);
  };
  syncProfiles();

  const resolveKey = (ref: string): string | null => {
    if (options.resolveSecret !== undefined) return options.resolveSecret(ref);
    if (ref.startsWith('env:')) {
      const value = process.env[ref.slice(4)];
      return value === undefined || value === '' ? null : value;
    }
    return null;
  };
  const setSecret = (id: string, value: string): string => {
    if (options.secretStore !== undefined) return options.secretStore.set(id, value);
    return `vault:${id}`;
  };
  const deleteSecret = (id: string): void => {
    options.secretStore?.delete(id);
  };

  const indexArtifact = async (artifact: { id: string; projectId: string; kind: string; path: string }): Promise<void> => {
    try {
      const detail = artifactStore.read(artifact.id);
      if (detail === null) return;
      await memoryIndex.index({
        projectId: artifact.projectId,
        scope: 'project',
        kind: artifact.kind as never,
        content: detail.content,
        sourceRef: `artifact:${artifact.id}`,
      });
    } catch {
      // Indexing is best effort; a failure must never fail the write that triggered it.
    }
  };

  const retrieveFromMemory: RetrieveFn = async (query, projectId, limit = 4) => {
    const hits = await memoryIndex.search(query, { projectId, limit });
    return hits.map((hit) => ({ kind: hit.kind, content: hit.content, sourceRef: hit.sourceRef, score: hit.score }));
  };

  const generateDeps = {
    gateway: options.modelGateway,
    artifactStore,
    workspaceRoot: options.workspaceRoot,
    retrieve: retrieveFromMemory,
    onArtifactSaved: indexArtifact,
  };

  const appendRunEvent = (runId: string, type: 'error' | 'run.finished' | 'budget.warning', payload: unknown): void => {
    try {
      const seq = runStore.nextEventSeq(runId);
      runStore.appendEvent({
        id: `${runId}_e${seq}`,
        runId,
        seq,
        type,
        payload,
        ts: clock().toISOString(),
      });
    } catch {
      // Best effort: the state column is authoritative for status.
    }
  };

  // ---------------------------------------------------------------- health

  app.get('/health', async () => ({
    ok: true,
    version: 1 as const,
    apiVersion: 3,
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
      automations: automationStore.list().length,
      memoryChunks: memoryIndex.count(),
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

  // ------------------------------------------------------------- projects

  app.post('/v1/projects', async (request, reply) => {
    const body = request.body as
      | { title?: unknown; platform?: unknown; description?: unknown; tags?: unknown }
      | undefined;
    if (typeof body?.title !== 'string' || body.title.trim() === '') {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'title is required' } });
    }
    const platform = typeof body.platform === 'string' ? body.platform : 'generic';
    if (!['bilibili', 'youtube', 'xiaohongshu', 'generic'].includes(platform)) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'unknown platform' } });
    }
    const tags = Array.isArray(body.tags)
      ? body.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 12)
      : [];
    const project = projectStore.create({
      id: randomUUID(),
      ownerId: 'local-user',
      title: body.title.trim(),
      platform: platform as 'bilibili',
      workspacePath: options.workspaceRoot,
      ...(typeof body.description === 'string' ? { description: body.description } : {}),
      tags,
    });
    return reply.code(201).send({ project });
  });

  app.get('/v1/projects', async (request) => {
    const query = request.query as { q?: string; includeDeleted?: string };
    const needle = (query.q ?? '').trim().toLowerCase();
    const includeDeleted = query.includeDeleted === '1';
    const projects = projectStore.list();
    const filtered =
      needle === ''
        ? projects
        : projects.filter((project) => {
            const haystack = `${project.title} ${project.description} ${project.tags.join(' ')}`.toLowerCase();
            return haystack.includes(needle);
          });
    const counts = projectStore.counts();
    return { projects: filtered, counts, includeDeleted };
  });

  app.get('/v1/projects/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = projectStore.get(id);
    if (project === null) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });
    const artifacts = artifactStore.list(id);
    return {
      project,
      stats: {
        artifacts: artifacts.length,
        runs: (db.prepare('SELECT COUNT(*) AS c FROM runs WHERE project_id = ?').get(id) as { c: number }).c,
        tokens: (
          db.prepare('SELECT COALESCE(SUM(used_tokens),0) AS c FROM runs WHERE project_id = ?').get(id) as {
            c: number;
          }
        ).c,
        costCny: (
          db.prepare('SELECT COALESCE(SUM(used_cost_cny),0) AS c FROM runs WHERE project_id = ?').get(id) as {
            c: number;
          }
        ).c,
      },
      checklist: buildChecklist(artifacts),
    };
  });

  app.patch('/v1/projects/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown> | undefined;
    if (body === undefined) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'body required' } });
    }
    if (body.platform !== undefined && !['bilibili', 'youtube', 'xiaohongshu', 'generic'].includes(String(body.platform))) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'unknown platform' } });
    }
    if (body.title !== undefined && (typeof body.title !== 'string' || body.title.trim() === '')) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'title must be non-empty' } });
    }
    const project = projectStore.update(id, {
      ...(typeof body.title === 'string' ? { title: body.title.trim() } : {}),
      ...(typeof body.platform === 'string' ? { platform: body.platform as 'bilibili' } : {}),
      ...(typeof body.description === 'string' ? { description: body.description } : {}),
      ...(Array.isArray(body.tags)
        ? { tags: body.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 12) }
        : {}),
    });
    if (project === null) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });
    return { project };
  });

  app.delete('/v1/projects/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!projectStore.softDelete(id)) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });
    }
    return { deleted: id, recoverable: true };
  });

  app.post('/v1/projects/:id/restore', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!projectStore.restore(id)) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });
    }
    return { project: projectStore.get(id) };
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

  // ------------------------------------------------------------- library

  app.get('/v1/library', async (request) => {
    const query = request.query as { kind?: string; q?: string; limit?: string };
    const limit = Math.min(Number.parseInt(query.limit ?? '200', 10) || 200, 500);
    const needle = (query.q ?? '').trim().toLowerCase();
    const projects = projectStore.list();
    const byId = new Map(projects.map((project) => [project.id, project]));
    const rows = db
      .prepare('SELECT * FROM artifacts ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;

    const items = rows
      .map((row) => {
        const project = byId.get(String(row.project_id));
        if (project === undefined) return null;
        const kind = String(row.kind);
        if (query.kind !== undefined && query.kind !== '' && kind !== query.kind) return null;
        const path = String(row.path);
        if (needle !== '' && !`${path} ${kind} ${project.title}`.toLowerCase().includes(needle)) return null;
        return {
          id: String(row.id),
          projectId: project.id,
          projectTitle: project.title,
          kind,
          path,
          size: Number(row.size),
          createdAt: String(row.created_at),
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);

    return { items, projects: projects.map((project) => ({ id: project.id, title: project.title })) };
  });

  // ------------------------------------------------------------ artifacts

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
      await indexArtifact(artifact);
      return reply.code(201).send({ artifact });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('PATH_ESCAPE')) {
        return reply.code(400).send({ error: { code: 'PATH_ESCAPE', message } });
      }
      throw error;
    }
  });

  // ------------------------------------------------------------- generate

  app.post('/v1/projects/:id/generate', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = projectStore.get(id);
    if (project === null) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });
    }
    const body = request.body as
      | { kind?: unknown; context?: unknown; includeUpstream?: unknown }
      | undefined;
    if (typeof body?.kind !== 'string' || !isGenerateKind(body.kind)) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'unknown kind' } });
    }
    if (typeof body.context !== 'string' || body.context.trim() === '') {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'context is required' } });
    }

    // Generation costs real money, so it gets a Run row like any other model work:
    // the usage dashboard and the monthly budget both read from `runs`.
    const runId = randomUUID();
    const profile = options.modelGateway.listProfiles()[0];
    const budget = settingsStore.getBudget();
    runStore.createRun({
      id: runId,
      projectId: id,
      parentRunId: null,
      agentId: 'scriptwriter',
      executionMode: 'local',
      status: 'running',
      modelProfileId: profile?.id ?? 'default',
      budget: {
        maxTokens: 200_000,
        maxCostCny: budget.perProjectCostCny,
        usedTokens: 0,
        usedCostCny: 0,
      },
      inputRef: null,
      outputRef: null,
      error: null,
      startedAt: clock().toISOString(),
      endedAt: null,
      createdAt: clock().toISOString(),
    });

    let tokens = 0;
    let cost = 0;
    try {
      const result = await generateArtifact(generateDeps, {
        projectId: id,
        kind: body.kind,
        context: body.context,
        includeUpstream: body.includeUpstream !== false,
        onUsage: (usage) => {
          tokens += usage.inputTokens + usage.outputTokens;
          if (profile !== undefined) {
            cost +=
              (usage.inputTokens / 1_000_000) * profile.priceInPerM +
              (usage.outputTokens / 1_000_000) * profile.priceOutPerM;
          }
        },
      });
      runStore.patchRun(runId, { status: 'succeeded', endedAt: clock().toISOString(), outputRef: result.artifact.id });
      try {
        runStore.addBudgetUsage(runId, { tokens, costCny: Number(cost.toFixed(6)) });
      } catch {
        // Budget columns are reporting only here; never fail a finished artifact.
      }
      appendRunEvent(runId, 'run.finished', { status: 'succeeded', kind: body.kind, tokens });
      const stageFor: Record<string, 'topic' | 'research' | 'script' | 'shotlist' | 'package'> = {
        'topic-card': 'topic',
        'research-notes': 'research',
        script: 'script',
        'shot-list': 'shotlist',
        'publish-pack': 'package',
      };
      const nextStage = stageFor[body.kind];
      if (nextStage !== undefined) projectStore.advanceStageIfBehind(id, nextStage);
      return reply.code(201).send({ ...result, runId });
    } catch (error) {
      const code = error instanceof ModelOutputError ? 'MODEL_BAD_OUTPUT' : ((error as { code?: string }).code ?? 'MODEL_ERROR');
      runStore.patchRun(runId, {
        status: 'failed',
        endedAt: clock().toISOString(),
        error: { code, message: error instanceof Error ? error.message : String(error), retryable: false },
      });
      appendRunEvent(runId, 'error', { code });
      if (error instanceof ModelOutputError) {
        return reply.code(502).send({ error: { code: 'MODEL_BAD_OUTPUT', message: error.message } });
      }
      return reply.code(502).send({
        error: { code, message: error instanceof Error ? error.message : String(error) },
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
      ready: items.filter((item) => item.required).every((item) => item.ok),
      missing: items.filter((item) => item.required && !item.ok).map((item) => item.key),
    };
  });

  // ---------------------------------------------------------------- publish

  app.post('/v1/projects/:id/publish', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (projectStore.get(id) === null) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });
    }

    const artifacts = artifactStore.list(id);
    const items = buildChecklist(artifacts);
    const missing = items.filter((item) => item.required && !item.ok).map((item) => item.key);
    if (missing.length > 0) {
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
        const safeName = resolveRelativeName(artifact.path);
        const buffer = Buffer.from(detail.content, 'utf8');
        totalBytes += buffer.length;
        if (totalBytes > 20 * 1024 * 1024) {
          return reply.code(413).send({ error: { code: 'EXPORT_TOO_LARGE', message: 'over 20MB' } });
        }
        entries.push({ name: safeName, content: buffer });
      }
      const summary = buildPublishSummary(artifacts);
      if (summary !== null) entries.push({ name: 'README.md', content: Buffer.from(summary, 'utf8') });
      // Manifest makes the export reproducible and attributable: every file's
      // hash plus the source artifact id, so a zip can be verified later.
      entries.push({
        name: 'manifest.json',
        content: Buffer.from(
          JSON.stringify(
            {
              generator: 'creator-studio',
              version: '0.2.0',
              projectId: id,
              projectTitle: projectStore.get(id)?.title ?? '',
              exportedAt: clock().toISOString(),
              files: entries.map((entry) => ({
                name: entry.name,
                bytes: entry.content.length,
                sha256: createHash('sha256').update(entry.content).digest('hex'),
              })),
            },
            null,
            2,
          ),
          'utf8',
        ),
      });
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
      absolutePath: outPath,
      bytes: zip.length,
      entries: entries.map((entry) => entry.name),
      checklist: items,
    });
  });

  // ---------------------------------------------------------------- models

  app.get('/v1/settings/models', async () => {
    const configured = settingsStore.listModels();
    const runtime = options.modelGateway.listProfiles();
    const models = configured.length > 0 ? configured : runtime;
    return {
      models: models.map((model) => ({
        id: model.id,
        name: model.name,
        provider: model.provider,
        baseUrl: model.baseUrl,
        model: model.model,
        contextWindow: model.contextWindow,
        priceInPerM: model.priceInPerM,
        priceOutPerM: model.priceOutPerM,
        isLocal: model.isLocal,
        apiKeyRef: model.apiKeyRef,
        keyConfigured: resolveKey(model.apiKeyRef) !== null,
        source: configured.length > 0 ? 'stored' : 'runtime',
      })),
      activeModelId: models[0]?.id ?? null,
      source: configured.length > 0 ? 'stored' : 'runtime',
    };
  });

  app.post('/v1/settings/models', async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    if (typeof body?.name !== 'string' || typeof body.baseUrl !== 'string' || typeof body.model !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'name, baseUrl and model are required' } });
    }
    try {
      const id = typeof body.id === 'string' ? body.id : randomUUID();
      const apiKey = typeof body.apiKey === 'string' && body.apiKey !== '' ? body.apiKey : null;
      const apiKeyRef =
        apiKey !== null
          ? setSecret(id, apiKey)
          : typeof body.apiKeyRef === 'string'
            ? body.apiKeyRef
            : 'env:MODEL_API_KEY';
      const profile = settingsStore.upsertModel({
        id,
        name: body.name,
        provider: (typeof body.provider === 'string' ? body.provider : 'openai-compatible') as never,
        baseUrl: body.baseUrl,
        model: body.model,
        apiKeyRef,
        contextWindow: typeof body.contextWindow === 'number' ? body.contextWindow : 128_000,
        priceInPerM: typeof body.priceInPerM === 'number' ? body.priceInPerM : 0,
        priceOutPerM: typeof body.priceOutPerM === 'number' ? body.priceOutPerM : 0,
        isLocal: body.isLocal === true,
      });
      syncProfiles();
      return reply.code(201).send({
        model: { ...profile, apiKeyRef: profile.apiKeyRef, keyConfigured: resolveKey(profile.apiKeyRef) !== null },
      });
    } catch (error) {
      return reply.code(400).send({
        error: { code: 'INVALID_INPUT', message: error instanceof Error ? error.message : String(error) },
      });
    }
  });

  app.post('/v1/settings/models/:id/key', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { apiKey?: unknown } | undefined;
    if (typeof body?.apiKey !== 'string' || body.apiKey.trim() === '') {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'apiKey required' } });
    }
    const stored = settingsStore.listModels().find((model) => model.id === id);
    // A model seeded from env/CLI flags is not in the settings table yet. Let the
    // first key save adopt it, otherwise a fresh install could never add a key
    // without also re-creating the model by hand.
    const runtime = options.modelGateway.listProfiles().find((model) => model.id === id);
    const current = stored ?? runtime;
    if (current === undefined) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });
    }
    const ref = setSecret(id, body.apiKey.trim());
    settingsStore.upsertModel({ ...current, apiKeyRef: ref });
    syncProfiles();
    return { id, keyConfigured: true, adopted: stored === undefined };
  });

  app.delete('/v1/settings/models/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    settingsStore.deleteModel(id);
    deleteSecret(id);
    syncProfiles();
    return reply.code(204).send();
  });

  app.post('/v1/settings/models/:id/test', async (request, reply) => {
    const { id } = request.params as { id: string };
    const started = Date.now();
    try {
      let text = '';
      for await (const delta of options.modelGateway.chat(
        { profileId: id },
        {
          messages: [
            { role: 'system', content: 'Reply with exactly: OK' },
            { role: 'user', content: 'ping' },
          ],
          maxOutputTokens: 16,
          temperature: 0,
        },
      )) {
        if (delta.kind === 'text') text += delta.text;
      }
      return { ok: true, latencyMs: Date.now() - started, sample: text.slice(0, 40) };
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'MODEL_ERROR';
      return reply.code(502).send({
        ok: false,
        code,
        latencyMs: Date.now() - started,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get('/v1/settings/grants', async () => {
    const stored = settingsStore.listGrants(options.deviceId);
    return {
      deviceId: options.deviceId,
      grants: stored,
      tools: toolHost.list().map((tool) => ({
        ...tool,
        mode: stored.find((grant) => grant.tool === tool.name)?.mode ?? 'deny',
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
    if (!toolHost.list().some((tool) => tool.name === body.tool)) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'unknown tool' } });
    }
    settingsStore.setGrantMode(options.deviceId, body.tool, body.mode as 'auto');
    return { grants: settingsStore.listGrants(options.deviceId) };
  });

  app.get('/v1/settings/embedding', async () => ({
    modelId: settingsStore.getEmbeddingModel(),
    active: memoryIndex.embedderId,
    neural: memoryIndex.neural,
    indexedChunks: memoryIndex.count(),
    // Offline mode is lexical, not semantic; the UI states this plainly.
    mode: memoryIndex.neural ? 'neural' : 'lexical-local',
  }));

  app.post('/v1/settings/embedding', async (request, reply) => {
    const body = request.body as { modelId?: unknown } | undefined;
    const modelId = body?.modelId;
    if (modelId !== null && typeof modelId !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'modelId must be string or null' } });
    }
    if (typeof modelId === 'string' && modelId !== '') {
      const exists = options.modelGateway.listProfiles().some((profile) => profile.id === modelId);
      if (!exists) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: modelId } });
    }
    settingsStore.setEmbeddingModel(typeof modelId === 'string' && modelId !== '' ? modelId : null);
    // A new embedding model means new vector space: reindex so old rows stay usable.
    const projects = projectStore.list();
    for (const project of projects) {
      for (const artifact of artifactStore.list(project.id)) await indexArtifact(artifact);
    }
    return { modelId: settingsStore.getEmbeddingModel(), reindexed: memoryIndex.count() };
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

  // --------------------------------------------------------------- rewrite

  app.post('/v1/rewrite', async (request, reply) => {
    const body = request.body as
      | { text?: unknown; instruction?: unknown; projectId?: unknown; agentId?: unknown; profileId?: unknown }
      | undefined;
    if (typeof body?.text !== 'string' || body.text.trim() === '') {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'text is required' } });
    }
    const instruction = typeof body.instruction === 'string' ? body.instruction : '把这段改得更口语';
    const started = Date.now();
    let output = '';
    try {
      for await (const delta of options.modelGateway.chat(
        {
          agentId: typeof body.agentId === 'string' ? body.agentId : 'scriptwriter',
          ...(typeof body.profileId === 'string' ? { profileId: body.profileId } : {}),
        },
        {
          messages: [
            { role: 'system', content: '你是中文视频编剧。只输出改写后的正文，不要解释，不要加引号。' },
            {
              role: 'user',
              content: `改写要求：${instruction}

原文：
${body.text}`,
            },
          ],
          maxOutputTokens: 1024,
          temperature: 0.5,
        },
      )) {
        if (delta.kind === 'text') output += delta.text;
      }
      return { rewritten: output.trim(), durationMs: Date.now() - started };
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'MODEL_ERROR';
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(502).send({ error: { code, message } });
    }
  });

  // ------------------------------------------------------------------ runs

  app.post('/v1/projects/:id/runs', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as
      | { agentId?: unknown; message?: unknown; maxTokens?: unknown; maxCostCny?: unknown }
      | undefined;

    const project = projectStore.get(id);
    if (project === null) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });

    const agentParsed = AgentIdSchema.safeParse(body?.agentId ?? 'scriptwriter');
    if (!agentParsed.success) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'unknown agentId' } });
    }
    if (typeof body?.message !== 'string' || body.message.trim() === '') {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'message is required' } });
    }

    const budget = settingsStore.getBudget();
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
        maxCostCny: typeof body.maxCostCny === 'number' ? body.maxCostCny : budget.perProjectCostCny,
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
    db.prepare('UPDATE runs SET input_message = ? WHERE id = ?').run(body.message, runId);
    return reply.code(202).send({ run });
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
    return {
      run,
      steps: runStore.listSteps(runId),
      approvals: runStore.listApprovals(runId),
      messages: runStore.listMessages(runId).map((message) => ({
        id: message.id,
        seq: message.seq,
        role: message.role,
        content: message.content,
        name: message.name,
        createdAt: message.createdAt,
      })),
    };
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
      ...(allowedOrigin === null ? {} : { 'access-control-allow-origin': allowedOrigin, vary: 'Origin' }),
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

  app.post('/v1/runs/:runId/resume', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const body = request.body as { approvalId?: unknown; agentId?: unknown } | undefined;
    const run = runStore.getRun(runId);
    if (run === null) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: runId } });
    if (run.status === 'succeeded' || run.status === 'cancelled') {
      return reply.code(409).send({ error: { code: 'RUN_TERMINAL', message: run.status } });
    }

    let approval = null;
    if (typeof body?.approvalId === 'string') {
      approval = runStore.getApproval(body.approvalId);
      if (approval === null || approval.runId !== runId) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: body.approvalId } });
      }
      if (approval.decision !== 'approved') {
        return reply.code(409).send({ error: { code: 'APPROVAL_NOT_GRANTED', message: approval.decision } });
      }
    }

    const agentParsed = AgentIdSchema.safeParse(body?.agentId ?? run.agentId);
    if (!agentParsed.success) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'unknown agentId' } });
    }

    const outcome = await runner.resume({
      runId,
      agentId: agentParsed.data,
      ...(approval === null ? {} : { approval }),
    });
    return reply.code(200).send({ outcome, run: runStore.getRun(runId) });
  });

  app.post('/v1/runs/:runId/cancel', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const run = runStore.getRun(runId);
    if (run === null) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: runId } });
    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') {
      return reply.code(409).send({ error: { code: 'RUN_TERMINAL', message: run.status } });
    }
    runStore.patchRun(runId, { status: 'cancelled', endedAt: clock().toISOString() });
    appendRunEvent(runId, 'run.finished', { status: 'cancelled', by: 'user' });
    for (const approval of runStore.listApprovals(runId)) {
      if (approval.decision === 'pending') {
        db.prepare("UPDATE approvals SET decision = 'expired', decided_at = ? WHERE id = ? AND decision = 'pending'").run(
          clock().toISOString(),
          approval.id,
        );
      }
    }
    return { run: runStore.getRun(runId) };
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
    const run = runStore.getRun(approval.runId);
    return {
      approval: runStore.getApproval(approvalId),
      run: run === null ? null : runStore.getRun(run.id),
      resumeHint:
        decision === 'approved' && run !== null && (run.status === 'waiting_approval' || run.status === 'paused')
          ? { method: 'POST', path: `/v1/runs/${run.id}/resume`, body: { approvalId } }
          : null,
    };
  });

  app.get('/v1/approvals', async (request) => {
    const query = request.query as { status?: string };
    const status = query.status ?? 'pending';
    const rows = db
      .prepare('SELECT id FROM approvals WHERE decision = ? ORDER BY requested_at DESC')
      .all(status) as Array<{ id: string }>;
    return { approvals: rows.map((row) => runStore.getApproval(row.id)).filter((value) => value !== null) };
  });

  // ------------------------------------------------------------- automations

  app.get('/v1/automations', async (request) => {
    const query = request.query as { projectId?: string };
    const automations = automationStore.list(query.projectId);
    return {
      automations: automations.map((automation) => ({
        ...automation,
        recentRuns: automationStore.listRuns(automation.id, 5),
      })),
    };
  });

  app.post('/v1/automations', async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    if (
      typeof body?.projectId !== 'string' ||
      typeof body.name !== 'string' ||
      typeof body.kind !== 'string' ||
      typeof body.prompt !== 'string'
    ) {
      return reply.code(400).send({
        error: { code: 'INVALID_INPUT', message: 'projectId, name, kind and prompt are required' },
      });
    }
    if (!isAutomationKind(body.kind)) {
      return reply.code(400).send({
        error: { code: 'INVALID_INPUT', message: 'kind must be topic-card|research-notes|publish-pack' },
      });
    }
    if (projectStore.get(body.projectId) === null) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: body.projectId } });
    }
    const intervalMinutes = typeof body.intervalMinutes === 'number' ? body.intervalMinutes : 1440;
    if (intervalMinutes < 15 || intervalMinutes > 10_080) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'intervalMinutes must be 15-10080' } });
    }
    const automation = automationStore.create({
      projectId: body.projectId,
      name: body.name.slice(0, 80),
      kind: body.kind,
      prompt: body.prompt.slice(0, 2000),
      intervalMinutes,
      enabled: body.enabled !== false,
    });
    return reply.code(201).send({ automation });
  });

  app.patch('/v1/automations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { enabled?: unknown } | undefined;
    if (typeof body?.enabled !== 'boolean') {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'enabled required' } });
    }
    const automation = automationStore.setEnabled(id, body.enabled);
    if (automation === null) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });
    return { automation };
  });

  app.delete('/v1/automations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!automationStore.delete(id)) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });
    }
    return reply.code(204).send();
  });

  const runAutomation = async (
    automationId: string,
  ): Promise<{ status: 'succeeded' | 'failed'; artifactId?: string; error?: string }> => {
    const automation = automationStore.get(automationId);
    if (automation === null) return { status: 'failed', error: 'NOT_FOUND' };
    const run = automationStore.startRun(automationId);
    try {
      const result = await generateArtifact(generateDeps, {
        projectId: automation.projectId,
        kind: automation.kind,
        context: automation.prompt,
      });
      automationStore.finishRun(run.id, { ok: true, artifactId: result.artifact.id });
      automationStore.markRun(automationId);
      return { status: 'succeeded', artifactId: result.artifact.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      automationStore.finishRun(run.id, { ok: false, error: message });
      automationStore.markRun(automationId);
      return { status: 'failed', error: message };
    }
  };

  app.post('/v1/automations/:id/run', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (automationStore.get(id) === null) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });
    }
    const result = await runAutomation(id);
    return reply.code(result.status === 'succeeded' ? 200 : 502).send(result);
  });

  // ---------------------------------------------------------------- metrics

  app.get('/v1/projects/:id/metrics', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (projectStore.get(id) === null) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });
    }
    return { metrics: metricsStore.list(id) };
  });

  app.post('/v1/projects/:id/metrics', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (projectStore.get(id) === null) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });
    }
    const body = request.body as Record<string, unknown> | undefined;
    const numeric = (key: string): number => (typeof body?.[key] === 'number' ? (body[key] as number) : 0);
    if (typeof body?.views !== 'number' || typeof body.likes !== 'number' || typeof body.comments !== 'number') {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'views, likes and comments are required' } });
    }
    const metrics = metricsStore.record(id, {
      views: numeric('views'),
      likes: numeric('likes'),
      comments: numeric('comments'),
      shares: numeric('shares'),
      retentionPercent: numeric('retentionPercent'),
      revenueCny: numeric('revenueCny'),
      note: typeof body.note === 'string' ? body.note.slice(0, 300) : '',
    });
    return reply.code(201).send({ metrics });
  });

  app.delete('/v1/metrics/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!metricsStore.delete(id)) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });
    return reply.code(204).send();
  });

  app.get('/v1/memory/search', async (request, reply) => {
    const query = request.query as { q?: string; projectId?: string; limit?: string; kind?: string };
    if (typeof query.q !== 'string' || query.q.trim() === '') {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'q is required' } });
    }
    const limit = Math.min(Number.parseInt(query.limit ?? '6', 10) || 6, 20);
    const kinds = query.kind === undefined || query.kind === '' ? undefined : ([query.kind] as never);
    const hits = await memoryIndex.search(query.q, {
      ...(query.projectId === undefined || query.projectId === '' ? {} : { projectId: query.projectId }),
      limit,
      ...(kinds === undefined ? {} : { kinds }),
    });
    return {
      hits,
      embedder: memoryIndex.embedderId,
      neural: memoryIndex.neural,
      indexed: memoryIndex.count(query.projectId === '' ? undefined : query.projectId),
    };
  });

  app.post('/v1/memory/reindex', async (request, reply) => {
    const body = request.body as { projectId?: unknown } | undefined;
    const projects =
      typeof body?.projectId === 'string'
        ? projectStore.list().filter((project) => project.id === body.projectId)
        : projectStore.list();
    if (projects.length === 0) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'project' } });

    let chunks = 0;
    let sources = 0;
    for (const project of projects) {
      for (const artifact of artifactStore.list(project.id)) {
        const before = memoryIndex.count(project.id);
        await indexArtifact(artifact);
        const after = memoryIndex.count(project.id);
        chunks += Math.max(0, after - before);
        sources += 1;
      }
    }
    return { projects: projects.length, sources, newChunks: chunks, totalChunks: memoryIndex.count() };
  });

  app.delete('/v1/memory/:sourceRef', async (request, reply) => {
    const { sourceRef } = request.params as { sourceRef: string };
    const decoded = decodeURIComponent(sourceRef);
    const removed = memoryIndex.remove(decoded.startsWith('artifact:') ? decoded : `artifact:${decoded}`);
    if (removed === 0) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: decoded } });
    return { removed };
  });

  app.get('/v1/dashboard', async () => {
    const projects = projectStore.list();
    const counts = projectStore.counts();
    const artifactRows = db
      .prepare('SELECT kind, COUNT(*) AS count FROM artifacts GROUP BY kind')
      .all() as Array<{ kind: string; count: number }>;
    const runRows = db
      .prepare('SELECT status, COUNT(*) AS count FROM runs GROUP BY status')
      .all() as Array<{ status: string; count: number }>;
    const spend = db
      .prepare('SELECT COALESCE(SUM(used_cost_cny),0) AS cost, COALESCE(SUM(used_tokens),0) AS tokens FROM runs')
      .get() as { cost: number; tokens: number };
    return {
      counts,
      artifactsByKind: artifactRows,
      runsByStatus: runRows,
      spend: { costCny: Number(spend.cost.toFixed(4)), tokens: spend.tokens },
      projects: projects.map((project) => {
        const aggregates = metricsStore.summary().find((entry) => entry.projectId === project.id);
        return {
          id: project.id,
          title: project.title,
          stage: project.stage,
          platform: project.platform,
          artifacts: (db.prepare('SELECT COUNT(*) AS c FROM artifacts WHERE project_id = ?').get(project.id) as {
            c: number;
          }).c,
          views: aggregates?.views ?? 0,
          updatedAt: project.updatedAt,
        };
      }),
      metricsSummary: metricsStore.summary(),
    };
  });

  // -------------------------------------------------------------- scheduler

  let timer: NodeJS.Timeout | null = null;
  const schedulerEnabled = options.scheduler !== false;
  if (schedulerEnabled) {
    timer = setInterval(() => {
      for (const automation of automationStore.due(clock())) {
        void runAutomation(automation.id);
      }
    }, 30_000);
    if (typeof timer.unref === 'function') timer.unref();
  }

  // ------------------------------------------------------------ static web

  if (options.webRoot !== undefined && existsSync(options.webRoot)) {
    await app.register(fastifyStatic, { root: options.webRoot, prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      const url = request.url.split('?')[0] ?? '/';
      if (url.startsWith('/v1/') || url.startsWith('/health')) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: url } });
      }
      const candidate = join(options.webRoot as string, url);
      const isFile = extname(url) !== '' && existsSync(candidate);
      return reply.sendFile(isFile ? url.replace(/^\//, '') : 'index.html');
    });
  }

  return {
    app,
    db,
    async close(): Promise<void> {
      if (timer !== null) clearInterval(timer);
      await app.close();
      db.close();
    },
  };

}

function buildPublishSummary(artifacts: Array<{ kind: string; path: string }>): string | null {
  const lines: string[] = ['# 发布包', '', '本发布包由稿台 Creator Studio 生成。', ''];
  const order = ['topic-card', 'research-notes', 'script', 'shot-list', 'publish-pack'];
  for (const kind of order) {
    const found = artifacts.find((artifact) => artifact.kind === kind);
    if (found === undefined) continue;
    lines.push(`## ${labelOf(kind)}`, '', `- 文件：${found.path}`, '');
  }
  lines.push('生成时间：' + new Date().toISOString());
  return lines.join('\n');
}

function labelOf(kind: string): string {
  switch (kind) {
    case 'topic-card':
      return '选题';
    case 'research-notes':
      return '资料';
    case 'script':
      return '脚本';
    case 'shot-list':
      return '分镜';
    case 'publish-pack':
      return '包装';
    default:
      return kind;
  }
}
