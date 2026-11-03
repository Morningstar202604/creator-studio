import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, sep } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import type { Database } from 'better-sqlite3';
import type { Artifact, Run, ToolGrant } from '@creator-studio/protocol';
import {
  AgentIdSchema,
  EntityCardInputSchema,
  ProjectMetricsInputSchema,
  ProjectStageSchema,
  PACK_FORMAT_VERSION,
  RelationInputSchema,
  STAGE_VIEWS,
  ScenarioPackSchema,
  negotiatePack,
  lintBannedWords,
  stageView,
  validateCardAgainstType,
  type DocumentConfig,
  type ResearchNotes,
  type ScenarioPack,
} from '@creator-studio/protocol';
import { ModelGateway, localEmbeddingProvider, type EmbeddingProvider } from '@creator-studio/model-gateway';
import { MemoryAuditSink, ToolHost, ToolError, fetchPage, listDirectory, type ListEntry, type ToolDefinition } from '@creator-studio/tools';
import {
  SqliteRunStore,
  SqliteProjectStore,
  SqliteArtifactStore,
  SqliteSettingsStore,
  SqliteAutomationStore,
  SqliteMetricsStore,
  SqliteStyleStore,
  SqliteScenarioStore,
  SqliteMemoryIndex,
  ArtifactCorruptError,
  DEFAULT_BUDGET,
  openDatabase,
} from '@creator-studio/store-sqlite';
import { EventBus, SSE_HEARTBEAT_MS, writeHeartbeat, writeSseEvent } from './stream.js';
import { isGenerateKind } from './generate.js';
import { buildChecklist, buildZip, exportFileName, isExportableKind } from './publish.js';
import { buildDocx, buildMarkdown, collectChapters, countChars, MANUSCRIPT_MAX_CHARS } from './manuscript.js';
import { buildSrt, scriptToCues } from './subtitle.js';
import { generateArtifact, ModelOutputError, type RetrieveFn } from './pipeline.js';
import { MAX_SOURCES, gatherSources, renderSourceLedger, verifyNotes, type ResearchBundle } from './research.js';
import { AgentRunner, type AgentSpec, type RunOutcome } from '@creator-studio/agent-core';

/**
 * Single source of truth for the version stamped into exported manifests. Read
 * from the daemon's own package.json at startup so a release bump cannot leave a
 * stale string in the zip.
 */
export const DAEMON_VERSION: string = (() => {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

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
  /**
   * Product version reported by /health. Injected rather than read from disk so
   * the daemon stays a pure function of its options (tests pin it explicitly).
   */
  appVersion?: string;
  /** Secret resolver (env/vault). Injecting one keeps tests hermetic. */
  resolveSecret?: (ref: string) => string | null;
  secretStore?: { set(name: string, value: string): string; delete(name: string): void };
  /** Override outbound HTTP (tests inject a fake; production uses global fetch). */
  fetchImpl?: typeof fetch;
  /** Override DNS resolution for the fetch guard; tests keep this hermetic. */
  lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
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
    tools: ['fs.read', 'fs.list', 'fs.delete'],
    maxOutputTokens: 1024,
  },
  {
    id: 'scout',
    systemPrompt:
      '你是选题侦察。用 http.fetch 读公开页面、用 fs.read 读本地资料，产出带出处的选题判断；不要凭记忆编造数据或链接。',
    tools: ['fs.read', 'fs.list', 'http.fetch'],
    maxOutputTokens: 2048,
  },
  {
    id: 'researcher',
    systemPrompt:
      '你是资料研究员。先用 http.fetch 抓取给定链接，再逐条提炼可核查的事实，每条都写清来源 URL；找不到原文支持时必须降低 confidence。',
    tools: ['fs.read', 'fs.list', 'http.fetch'],
    maxOutputTokens: 2048,
  },
  {
    id: 'director',
    systemPrompt: '你是导演助理。把脚本拆成镜头清单，给出景别、画面、B-roll 与上屏字幕，不写正文。',
    tools: ['fs.read', 'fs.list'],
    maxOutputTokens: 2048,
  },
  {
    id: 'packager',
    systemPrompt: '你是包装编辑。负责标题候选、简介、标签、章节与封面 brief；遵循平台规则，不承诺自动发布。',
    tools: ['fs.read'],
    maxOutputTokens: 1536,
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
  registerResearchTools(host, workspaceRoot);
}

/**
 * Tools for the research stage. `fs.list` is a read-only map of one workspace
 * directory; `http.fetch` goes through the guarded fetcher so an agent cannot
 * use it to reach loopback services or internal networks.
 */
function registerResearchTools(host: ToolHost, workspaceRoot: string): void {
  // No `pathArg` here on purpose: ToolHost's path sandbox requires a path, which
  // would make "list the workspace root" impossible. `listDirectory` applies
  // `resolveInsideWorkspace` itself, which is the other accepted sandbox shape.
  const list: ToolDefinition<{ path?: string; limit?: number }, { path: string; entries: ListEntry[]; truncated: boolean }> = {
    name: 'fs.list',
    risk: 'low',
    approvalKind: null,
    inputSchema: (input) => {
      const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
      const path = record.path === undefined ? '' : record.path;
      if (typeof path !== 'string') throw new ToolError('INVALID_INPUT', 'path must be a string');
      const limit = typeof record.limit === 'number' ? Math.min(Math.max(Math.trunc(record.limit), 1), 500) : 200;
      return { path, limit };
    },
    execute: async (input) => listDirectory(input.path ?? '', { workspaceRoot, limit: input.limit ?? 200 }),
  };

  const fetchTool: ToolDefinition<{ url: string }, { url: string; title: string; text: string; truncated: boolean }> = {
    name: 'http.fetch',
    risk: 'medium',
    approvalKind: null,
    inputSchema: (input) => {
      const url = typeof input === 'object' && input !== null ? (input as Record<string, unknown>).url : undefined;
      if (typeof url !== 'string' || url.trim() === '') throw new ToolError('INVALID_INPUT', 'url required');
      return { url };
    },
    execute: async (input) => {
      const page = await fetchPage(input.url);
      return { url: page.finalUrl, title: page.title, text: page.text, truncated: page.truncated };
    },
  };

  host.register(list as never);
  host.register(fetchTool as never);
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
  // Nothing can still be running at construction time, so any `running` row is a
  // leftover from a process that died mid-generation. Correcting it once here
  // keeps the UI honest without a lazy repair on every read.
  automationStore.recoverInterruptedRuns();
  const metricsStore = new SqliteMetricsStore(db);
  const clock = options.now ?? (() => new Date());
  const styleStore = new SqliteStyleStore(db, 'local-user', () => clock());
  const scenarioStore = new SqliteScenarioStore(db, () => clock());
  // Built-in packs are code-defined and refreshed each boot; user packs are left alone.
  scenarioStore.seedBuiltins();

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
    { id: 'g-list', deviceId: options.deviceId, tool: 'fs.list', scope: '**', mode: 'auto' },
    { id: 'g-write', deviceId: options.deviceId, tool: 'fs.write', scope: '**', mode: 'auto' },
    // Outbound fetch is allowed by default because every call passes the SSRF,
    // robots and size guards; the audit trail still records each target.
    { id: 'g-fetch', deviceId: options.deviceId, tool: 'http.fetch', scope: 'https://**', mode: 'auto' },
    { id: 'g-fetch-http', deviceId: options.deviceId, tool: 'http.fetch', scope: 'http://**', mode: 'auto' },
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
    'styles',
    'subtitle',
    'review',
    'sources',
    'exportPolicy',
    'scenarios',
    'entities',
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

  const INDEXED_KINDS = new Set([
    'topic-card',
    'research-notes',
    'script',
    'shot-list',
    'publish-pack',
    'review-report',
    'outline',
    'chapter',
  ]);

  const indexArtifact = async (artifact: { id: string; projectId: string; kind: string; path: string }): Promise<void> => {
    // Only knowledge artifacts are indexed. Subtitle/SRT is a derived rendering of
    // the script (indexing it would duplicate every sentence), and image/audio/other
    // carry no text the model could quote.
    if (!INDEXED_KINDS.has(artifact.kind)) return;
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

  /**
   * Banned-word scan over the two artifacts that ship to the audience: the latest
   * script and the latest publish pack (titles/description/tags also get published).
   */
  const styleLintFor = (
    projectId: string,
  ): { bannedWords: string[]; hits: Array<{ word: string; count: number }> } | null => {
    const project = projectStore.get(projectId);
    if (project === null || project.styleProfileId === null) return null;
    const profile = styleStore.get(project.styleProfileId);
    if (profile === null) return null;
    const totals = new Map<string, number>();
    for (const kind of ['script', 'publish-pack'] as const) {
      const latest = artifactStore.latest(projectId, kind);
      if (latest === null) continue;
      for (const hit of lintBannedWords(latest.content, profile.bannedWords)) {
        totals.set(hit.word, (totals.get(hit.word) ?? 0) + hit.count);
      }
    }
    return {
      bannedWords: profile.bannedWords,
      hits: [...totals.entries()].map(([word, count]) => ({ word, count })),
    };
  };

  const checklistFor = (projectId: string): ReturnType<typeof buildChecklist> => {
    const artifacts = artifactStore.list(projectId);
    const lint = styleLintFor(projectId);
    const checked = artifacts.some(
      (artifact) => artifact.kind === 'script' || artifact.kind === 'publish-pack',
    );
    const project = projectStore.get(projectId);
    const pack = project === null ? null : scenarioStore.get(project.scenarioId);
    return buildChecklist(artifacts, {
      style: lint === null ? null : { ...lint, checked },
      entityCounts: scenarioStore.countCards(projectId),
      scenario:
        pack === null
          ? null
          : {
              stages: pack.stages.map((stage) => ({
                key: stage.key,
                label: stage.label,
                required: stage.required,
                produces: stage.produces,
                ...(stage.view === undefined ? {} : { view: stage.view }),
                ...(stage.entityType === undefined ? {} : { entityType: stage.entityType }),
              })),
            },
    });
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
    // The product version, distinct from apiVersion: 'which build am I running'
    // is the first question in any bug report, and the daemon could not answer it.
    appVersion: options.appVersion ?? '0.0.0-dev',
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
      | { title?: unknown; platform?: unknown; description?: unknown; tags?: unknown; scenarioId?: unknown }
      | undefined;
    if (typeof body?.title !== 'string' || body.title.trim() === '') {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'title is required' } });
    }
    // A project must belong to a scenario: the pack decides its stages and cards.
    const scenarioId = typeof body.scenarioId === 'string' && body.scenarioId !== '' ? body.scenarioId : 'video';
    const pack = scenarioStore.get(scenarioId);
    if (pack === null) {
      return reply.code(400).send({ error: { code: 'UNKNOWN_SCENARIO', message: `no scenario pack ${scenarioId}` } });
    }
    const platform =
      typeof body.platform === 'string' && ['bilibili', 'youtube', 'xiaohongshu', 'generic'].includes(body.platform)
        ? body.platform
        : pack.defaultPlatform;
    const tags = Array.isArray(body.tags)
      ? body.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 12)
      : [];
    const firstStage = pack.stages[0]?.key ?? 'topic';
    const project = projectStore.create({
      id: randomUUID(),
      ownerId: 'local-user',
      title: body.title.trim(),
      platform: platform as 'bilibili',
      workspacePath: options.workspaceRoot,
      scenarioId: pack.id,
      stage: firstStage,
      ...(typeof body.description === 'string' ? { description: body.description } : {}),
      tags,
    });
    return reply.code(201).send({ project, scenario: pack });
  });

  app.get('/v1/projects', async (request) => {
    const query = request.query as { q?: string; includeDeleted?: string };
    const needle = (query.q ?? '').trim().toLowerCase();
    const includeDeleted = query.includeDeleted === '1';
    // `includeDeleted=1` used to be parsed and then ignored, so a soft-deleted
    // project could never be found again from the UI. Honour it now.
    const projects = projectStore.listWithDeleted(includeDeleted);
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
    const cardCounts = scenarioStore.countCards(id);
    return {
      project,
      stats: {
        artifacts: artifacts.length,
        // Card-based projects keep their work in entity cards, not artifacts; the
        // workspace headline reads "0 个产物" otherwise even with nine chapters.
        cards: Object.values(cardCounts).reduce((sum, count) => sum + count, 0),
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
      checklist: checklistFor(id),
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
    if (body.styleProfileId !== undefined && body.styleProfileId !== null) {
      if (typeof body.styleProfileId !== 'string' || styleStore.get(body.styleProfileId) === null) {
        return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'unknown styleProfileId' } });
      }
    }
    const project = projectStore.update(id, {
      ...(typeof body.title === 'string' ? { title: body.title.trim() } : {}),
      ...(typeof body.platform === 'string' ? { platform: body.platform as 'bilibili' } : {}),
      ...(typeof body.description === 'string' ? { description: body.description } : {}),
      ...(Array.isArray(body.tags)
        ? { tags: body.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 12) }
        : {}),
      ...(body.styleProfileId === undefined
        ? {}
        : { styleProfileId: typeof body.styleProfileId === 'string' ? body.styleProfileId : null }),
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
    // The stage must exist in this project's own pack: a typo would otherwise park
    // the project on a stage the UI cannot render.
    const pack = scenarioStore.get(project.scenarioId);
    if (pack === null || !pack.stages.some((stage) => stage.key === parsed.data)) {
      return reply.code(400).send({
        error: { code: 'UNKNOWN_STAGE', message: `stage ${parsed.data} is not part of scenario ${project.scenarioId}` },
        available: pack?.stages.map((stage) => stage.key) ?? [],
      });
    }
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
        'outline',
        'chapter',
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
      | { kind?: unknown; context?: unknown; includeUpstream?: unknown; sources?: unknown }
      | undefined;
    if (typeof body?.kind !== 'string' || !isGenerateKind(body.kind)) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'unknown kind' } });
    }
    // The review report has its own endpoint that also reads metrics and advances
    // the stage. Keeping a second path here produced reports that claimed to be
    // reviews but had no data behind them, so it is refused with a pointer.
    if (body.kind === 'review-report') {
      return reply.code(400).send({
        error: {
          code: 'USE_REVIEW_ENDPOINT',
          message: 'use POST /v1/projects/:id/review so metrics and stage advancement are included',
        },
      });
    }
    if (typeof body.context !== 'string' || body.context.trim() === '') {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'context is required' } });
    }
    const requestSources = Array.isArray(body.sources)
      ? body.sources.filter((url): url is string => typeof url === 'string').slice(0, MAX_SOURCES)
      : [];

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
    const attachedStyle =
      project.styleProfileId === null ? null : styleStore.get(project.styleProfileId);

    // The stage that produces this kind decides the scenario instruction: a novel
    // outline and a video script share the same endpoint but not the same brief.
    const projectPack = scenarioStore.get(project.scenarioId);
    const requestedKind: string = body.kind;
    const stageHint =
      projectPack?.stages.find((stage) => (stage.produces as readonly string[]).includes(requestedKind))
        ?.promptHint ?? '';

    // Research is the only stage that may reach the network. Sources are fetched
    // (with SSRF/robots/size guards) before the model call, and the resulting text
    // enters the prompt fenced. A failed fetch is reported, never papered over.
    let research: ResearchBundle | null = null;
    if (body.kind === 'research-notes' && requestSources.length > 0) {
      research = await gatherSources(requestSources, {
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        ...(options.lookup === undefined ? {} : { lookup: options.lookup }),
      });
      if (research.sources.length === 0) {
        runStore.patchRun(runId, {
          status: 'failed',
          endedAt: clock().toISOString(),
          error: {
            code: 'SOURCES_UNREACHABLE',
            message: research.failures.map((failure) => `${failure.code} ${failure.url}`).join('; '),
            retryable: true,
          },
        });
        return reply.code(502).send({
          error: { code: 'SOURCES_UNREACHABLE', message: 'none of the supplied sources could be fetched' },
          failures: research.failures,
        });
      }
    }

    try {
      const result = await generateArtifact(generateDeps, {
        projectId: id,
        kind: body.kind,
        context: body.context,
        includeUpstream: body.includeUpstream !== false,
        ...(attachedStyle === null
          ? {}
          : {
              style: {
                name: attachedStyle.name,
                tone: attachedStyle.tone,
                audience: attachedStyle.audience,
                bannedWords: attachedStyle.bannedWords,
                notes: attachedStyle.notes,
              },
            }),
        ...(stageHint === '' ? {} : { scenarioHint: stageHint }),
        ...(research === null
          ? {}
          : {
              extraContext: research.promptBlock,
              refine: (payload: unknown) => {
                const verified = verifyNotes(payload as ResearchNotes, research.pages);
                return {
                  payload: { ...(payload as ResearchNotes), notes: verified.notes },
                  meta: {
                    sources: research.sources,
                    failures: research.failures,
                    unverified: verified.unverified,
                    downgraded: verified.downgraded,
                  },
                };
              },
              appendMarkdown: renderSourceLedger(research),
            }),
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
      // Advance to the first stage in THIS project's pack that produces this kind.
      const packForAdvance = scenarioStore.get(project.scenarioId);
      if (packForAdvance !== null) {
        const order = packForAdvance.stages.map((stage) => stage.key);
        const producedKind = body.kind;
        const nextStage = packForAdvance.stages.find((stage) =>
          (stage.produces as readonly string[]).includes(producedKind),
        )?.key;
        if (nextStage !== undefined) projectStore.advanceStageIfBehind(id, nextStage, order);
      }
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
    const items = checklistFor(id);
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
    const items = checklistFor(id);
    const missing = items.filter((item) => item.required && !item.ok).map((item) => item.key);
    if (missing.length > 0) {
      return reply.code(409).send({
        error: { code: 'CHECKLIST_INCOMPLETE', message: `missing: ${missing.join(', ')}` },
        missing,
      });
    }

    const entries: Array<{ name: string; content: Buffer }> = [];
    let totalBytes = 0;
    // A publish pack is the cut that goes out, not the edit history. Export only
    // the newest artifact of each kind unless the caller explicitly asks for all
    // versions (useful for archival). Grouping by kind keeps every stage present
    // even when two kinds share a folder.
    const includeHistory = (request.body as { includeHistory?: unknown } | undefined)?.includeHistory === true;
    const newestByKind = new Map<string, Artifact>();
    for (const artifact of artifacts) {
      if (!isExportableKind(artifact.kind)) continue;
      if (includeHistory) continue;
      const current = newestByKind.get(artifact.kind);
      if (current === undefined || artifact.createdAt > current.createdAt) newestByKind.set(artifact.kind, artifact);
    }
    const selected = includeHistory
      ? artifacts.filter((artifact) => isExportableKind(artifact.kind))
      : [...newestByKind.values()];

    try {
      for (const artifact of selected) {
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
      const summary = buildPublishSummary(selected);
      if (summary !== null) entries.push({ name: 'README.md', content: Buffer.from(summary, 'utf8') });
      // Manifest makes the export reproducible and attributable: every file's
      // hash plus the source artifact id, so a zip can be verified later.
      entries.push({
        name: 'manifest.json',
        content: Buffer.from(
          JSON.stringify(
            {
              generator: 'creator-studio',
              version: DAEMON_VERSION,
              projectId: id,
              projectTitle: projectStore.get(id)?.title ?? '',
              exportedAt: clock().toISOString(),
              includeHistory,
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

    // A successful export is the "published" milestone: the pack exists, so the
    // pipeline can move past packaging instead of sitting there forever.
    const publishedPack = scenarioStore.get(projectStore.get(id)?.scenarioId ?? 'video');
    if (publishedPack !== null) {
      // Packs name their publishing stage differently (`published`, `submitted`…);
      // find it by view first so a custom pack still advances after an export.
      const publishStage =
        publishedPack.stages.find((stage) => stageView(stage) === 'publish')?.key ?? 'published';
      projectStore.advanceStageIfBehind(
        id,
        publishStage,
        publishedPack.stages.map((stage) => stage.key),
      );
    }

    return reply.code(201).send({
      file: `publish-exports/${fileName}`,
      absolutePath: outPath,
      bytes: zip.length,
      entries: entries.map((entry) => entry.name),
      includeHistory,
      stage: projectStore.get(id)?.stage ?? 'published',
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

  // ------------------------------------------------------------- scenarios

  app.get('/v1/scenarios', async () => ({
    scenarios: scenarioStore.list(),
    defaultId: 'video',
    engine: { packFormat: PACK_FORMAT_VERSION, views: [...STAGE_VIEWS] },
  }));

  app.get('/v1/scenarios/:scenarioId', async (request, reply) => {
    const { scenarioId } = request.params as { scenarioId: string };
    const pack = scenarioStore.get(scenarioId);
    if (pack === null) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: scenarioId } });
    return { scenario: pack };
  });

  app.post('/v1/scenarios', async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    if (body === undefined) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'body required' } });
    }
    // Built-ins cannot be overwritten through this route; that keeps `video` stable
    // for every existing project. A user can always create a new id.
    const candidate = { ...body, builtin: false };
    const parsed = ScenarioPackSchema.safeParse(candidate);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'INVALID_SCENARIO', message: parsed.error.issues.map((issue) => issue.message).join('; ') },
      });
    }
    try {
      const saved = scenarioStore.save(parsed.data);
      return reply.code(201).send({ scenario: saved });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('BUILTIN_READONLY')) {
        return reply.code(409).send({ error: { code: 'BUILTIN_READONLY', message: 'built-in packs cannot be edited' } });
      }
      if (message.includes('UNSUPPORTED_VIEW')) {
        return reply.code(400).send({
          error: { code: 'UNSUPPORTED_VIEW', message },
          supportedViews: [...STAGE_VIEWS],
        });
      }
      if (message.includes('BAD_INHERITANCE')) {
        return reply.code(400).send({ error: { code: 'BAD_INHERITANCE', message } });
      }
      return reply.code(400).send({ error: { code: 'INVALID_SCENARIO', message } });
    }
  });

  /** Export exactly what is stored, so an import can reproduce it. */
  app.get('/v1/scenarios/:scenarioId/export', async (request, reply) => {
    const { scenarioId } = request.params as { scenarioId: string };
    const stored = scenarioStore.getStored(scenarioId);
    if (stored === null) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: scenarioId } });
    return {
      pack: stored,
      exportedAt: clock().toISOString(),
      engine: { packFormat: PACK_FORMAT_VERSION, views: [...STAGE_VIEWS] },
    };
  });

  /** Import a previously exported pack; reported issues never mutate the database. */
  app.post('/v1/scenarios/import', async (request, reply) => {
    const body = request.body as { pack?: unknown } | undefined;
    if (body?.pack === undefined) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'pack required' } });
    }
    const parsed = ScenarioPackSchema.safeParse({ ...(body.pack as Record<string, unknown>), builtin: false });
    if (!parsed.success) {
      // An unknown view is the one schema error a pack author can fix by looking at
      // the engine's vocabulary, so it gets its own code and the list.
      const unknownView = parsed.error.issues.some(
        (issue) => issue.code === 'invalid_enum_value' && issue.path.includes('view'),
      );
      return reply.code(400).send({
        error: {
          code: unknownView ? 'UNSUPPORTED_VIEW' : 'INVALID_SCENARIO',
          message: parsed.error.issues.map((issue) => issue.message).join('; '),
        },
        supportedViews: [...STAGE_VIEWS],
      });
    }
    const negotiation = negotiatePack(parsed.data, STAGE_VIEWS);
    if (!negotiation.ok) {
      return reply.code(400).send({
        error: { code: 'UNSUPPORTED_VIEW', message: `pack needs ${negotiation.missingViews.join(', ')}` },
        supportedViews: [...STAGE_VIEWS],
      });
    }
    try {
      const saved = scenarioStore.save(parsed.data);
      return reply.code(201).send({ scenario: saved });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('UNSUPPORTED_VIEW')) {
        return reply.code(400).send({
          error: { code: 'UNSUPPORTED_VIEW', message },
          supportedViews: [...STAGE_VIEWS],
        });
      }
      if (message.includes('BAD_INHERITANCE')) {
        return reply.code(400).send({ error: { code: 'BAD_INHERITANCE', message } });
      }
      return reply.code(400).send({ error: { code: 'INVALID_SCENARIO', message } });
    }
  });

  app.delete('/v1/scenarios/:scenarioId', async (request, reply) => {
    const { scenarioId } = request.params as { scenarioId: string };
    const result = scenarioStore.delete(scenarioId);
    if (result === 'not-found') return reply.code(404).send({ error: { code: 'NOT_FOUND', message: scenarioId } });
    if (result === 'builtin') {
      return reply.code(409).send({ error: { code: 'BUILTIN_READONLY', message: 'built-in packs cannot be deleted' } });
    }
    return { deleted: scenarioId };
  });

  // ---------------------------------------------------------------- entities

  const projectScenario = (projectId: string): ScenarioPack | null => {
    const project = projectStore.get(projectId);
    if (project === null) return null;
    return scenarioStore.get(project.scenarioId);
  };

  app.get('/v1/projects/:id/entities', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (projectStore.get(id) === null) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });
    const query = request.query as { type?: string };
    const cards = scenarioStore.listCards(id, query.type === undefined || query.type === '' ? undefined : query.type);
    const counts = scenarioStore.countCards(id);
    // The board needs to know which select field supplies its columns; the editor
    // needs the card type's field schema. Returning them here saves the UI from
    // stitching three endpoints together for one screen.
    const pack = projectScenario(id);
    const entityTypeKey = query.type ?? '';
    const entityType = pack?.entityTypes.find((candidate) => candidate.key === entityTypeKey);
    const boardStage = pack?.stages.find(
      (stage) => stageView(stage) === 'board' && stage.entityType === entityTypeKey,
    );
    const documentStage = pack?.stages.find(
      (stage) => stageView(stage) === 'document' && stage.entityType === entityTypeKey,
    );
    return {
      cards,
      counts,
      ...(entityType === undefined ? {} : { entityType }),
      ...(boardStage?.board === undefined ? {} : { board: boardStage.board }),
      ...(documentStage === undefined
        ? {}
        : {
            document: {
              stage: documentStage.key,
              label: documentStage.label,
              ...(documentStage.document ?? {}),
            },
          }),
    };
  });

  app.post('/v1/projects/:id/entities', async (request, reply) => {
    const { id } = request.params as { id: string };
    const pack = projectScenario(id);
    if (pack === null) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });
    const parsed = EntityCardInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'INVALID_CARD', message: parsed.error.issues.map((issue) => issue.message).join('; ') },
      });
    }
    const entityType = pack.entityTypes.find((candidate) => candidate.key === parsed.data.type);
    const check = validateCardAgainstType(parsed.data, entityType);
    if (!check.ok) return reply.code(400).send({ error: { code: 'INVALID_CARD', message: check.message } });
    const card = scenarioStore.createCard(id, parsed.data);
    return reply.code(201).send({ card });
  });

  app.patch('/v1/projects/:id/entities/:cardId', async (request, reply) => {
    const { id, cardId } = request.params as { id: string; cardId: string };
    const pack = projectScenario(id);
    if (pack === null) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });
    const existing = scenarioStore.getCard(id, cardId);
    if (existing === null) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: cardId } });
    const merged = {
      type: existing.type,
      title: existing.title,
      fields: existing.fields,
      body: existing.body,
      tags: existing.tags,
      ...(request.body as Record<string, unknown>),
    };
    const parsed = EntityCardInputSchema.safeParse(merged);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'INVALID_CARD', message: parsed.error.issues.map((issue) => issue.message).join('; ') },
      });
    }
    const entityType = pack.entityTypes.find((candidate) => candidate.key === parsed.data.type);
    const check = validateCardAgainstType(parsed.data, entityType);
    if (!check.ok) return reply.code(400).send({ error: { code: 'INVALID_CARD', message: check.message } });
    // Drag-and-drop moves a card within its column, which is the card's own
    // position — not a field value — so it rides alongside the parsed payload.
    const rawOrder = (request.body as Record<string, unknown>).order;
    const order =
      typeof rawOrder === 'number' && Number.isInteger(rawOrder) && rawOrder >= 0 ? rawOrder : undefined;
    const card = scenarioStore.updateCard(id, cardId, {
      ...parsed.data,
      ...(order === undefined ? {} : { order }),
    });
    return card === null ? reply.code(404).send({ error: { code: 'NOT_FOUND', message: cardId } }) : { card };
  });

  /** Whole-project card graph, for the relation view. */
  app.get('/v1/projects/:id/graph', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (projectStore.get(id) === null) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });
    const project = projectStore.get(id);
    const pack = project === null ? null : scenarioStore.get(project.scenarioId);
    return {
      ...scenarioStore.projectGraph(id),
      entityTypes: pack?.entityTypes ?? [],
      relationTypes: pack?.relationTypes ?? [],
    };
  });

  /**
   * Foreshadowing health. A writer's real question is not "what links exist" but
   * "which threads are still open, and did I wait too long" — so this reports the gap
   * in chapters between planting and payoff, and flags anything left open.
   */
  app.get('/v1/projects/:id/foreshadow-health', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = projectStore.get(id);
    if (project === null) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });
    const pack = scenarioStore.get(project.scenarioId);
    const cards = scenarioStore.listCards(id);
    const relations = scenarioStore.listRelationsForProject(id);
    const chapters = cards.filter((card) => card.type === 'chapter');
    const chapterOrder = new Map<string, number>();
    chapters.forEach((chapter) => {
      // Chapter cards carry their own position; fall back to creation order so a card
      // without a number still sorts deterministically instead of jumping around.
      const raw = chapter.fields['number'] ?? chapter.fields['order'] ?? '';
      const parsed = Number.parseInt(raw, 10);
      chapterOrder.set(chapter.id, Number.isNaN(parsed) ? chapters.indexOf(chapter) : parsed);
    });

    const open: Array<{
      cardId: string;
      title: string;
      status: string;
      plantedAt: string;
      plantedChapter: number | null;
      lastChapter: number | null;
      gapChapters: number | null;
      note: string;
    }> = [];

    for (const card of cards.filter((candidate) => candidate.type === 'foreshadow')) {
      const outbound = relations.filter((relation) => relation.from === card.id);
      const plant = outbound.find((relation) => relation.relationType === 'plants');
      const payoffs = outbound.filter((relation) => relation.relationType === 'pays-off');
      const status = card.fields['status'] ?? '';
      const plantedChapter = plant === undefined ? null : (chapterOrder.get(plant.to) ?? null);
      const payoffChapters = payoffs
        .map((relation) => chapterOrder.get(relation.to) ?? null)
        .filter((value): value is number => value !== null);
      const lastChapter = payoffChapters.length === 0 ? null : Math.max(...payoffChapters);
      const gap = plantedChapter !== null && lastChapter !== null ? lastChapter - plantedChapter : null;
      const resolved = payoffs.length > 0 || status === '已回收';
      if (resolved && gap !== null && gap > 12) {
        open.push({
          cardId: card.id,
          title: card.title,
          status,
          plantedAt: card.fields['planted_at'] ?? '',
          plantedChapter,
          lastChapter,
          gapChapters: gap,
          note: `埋了 ${gap} 章才回收，读者可能已经忘了`,
        });
      } else if (!resolved) {
        open.push({
          cardId: card.id,
          title: card.title,
          status,
          plantedAt: card.fields['planted_at'] ?? '',
          plantedChapter,
          lastChapter,
          gapChapters: gap,
          note: plantedChapter === null ? '还没有连到埋设章节' : '还没有回收',
        });
      }
    }

    return {
      total: cards.filter((candidate) => candidate.type === 'foreshadow').length,
      open: open.length,
      paidOff: cards.filter((candidate) => candidate.type === 'foreshadow').length - open.length,
      items: open,
      relationTypes: pack?.relationTypes ?? [],
    };
  });

  app.get('/v1/projects/:id/entities/:cardId/links', async (request, reply) => {
    const { id, cardId } = request.params as { id: string; cardId: string };
    if (projectStore.get(id) === null) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });
    const card = scenarioStore.cardWithLinks(id, cardId);
    if (card === null) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: cardId } });
    return { card };
  });

  app.post('/v1/projects/:id/entities/:cardId/links', async (request, reply) => {
    const { id, cardId } = request.params as { id: string; cardId: string };
    if (projectStore.get(id) === null) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });
    const parsed = RelationInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'INVALID_RELATION', message: parsed.error.issues.map((issue) => issue.message).join('; ') },
      });
    }
    try {
      const relation = scenarioStore.linkCards(
        id,
        cardId,
        parsed.data.toCardId,
        parsed.data.label,
        parsed.data.relationType,
      );
      return reply.code(201).send({ relation });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('SELF_LINK')) {
        return reply.code(400).send({ error: { code: 'SELF_LINK', message: 'a card cannot link to itself' } });
      }
      if (message.includes('UNKNOWN_RELATION_TYPE')) {
        return reply.code(400).send({
          error: { code: 'UNKNOWN_RELATION_TYPE', message: 'relation type is not declared by this scenario' },
        });
      }
      if (message.includes('RELATION_TYPE_MISMATCH')) {
        return reply.code(400).send({
          error: { code: 'RELATION_TYPE_MISMATCH', message: 'relation type does not allow these card types' },
        });
      }
      if (message.includes('CARD_NOT_FOUND')) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: parsed.data.toCardId } });
      }
      throw error;
    }
  });

  app.delete('/v1/projects/:id/links/:relationId', async (request, reply) => {
    const { id, relationId } = request.params as { id: string; relationId: string };
    if (projectStore.get(id) === null) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });
    if (!scenarioStore.unlinkCards(id, relationId)) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: relationId } });
    }
    return { deleted: relationId };
  });

  app.delete('/v1/projects/:id/entities/:cardId', async (request, reply) => {
    const { id, cardId } = request.params as { id: string; cardId: string };
    if (projectStore.get(id) === null) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });
    if (!scenarioStore.deleteCard(id, cardId)) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: cardId } });
    }
    return { deleted: cardId };
  });

  // ------------------------------------------------------------ manuscript

  /**
   * The writing surface. Prose lives on cards, so "the manuscript" is a projection:
   * pick the document stage's card type, order the cards, and read the configured
   * prose field. Keeping the text on the card means one source of truth — editing a
   * chapter in the desk and exporting the book can never disagree.
   */
  const manuscriptSource = (projectId: string): {
    pack: ScenarioPack;
    stageKey: string;
    entityType: string;
    config: DocumentConfig;
    cards: ReturnType<typeof scenarioStore.listCards>;
  } | null => {
    const pack = projectScenario(projectId);
    if (pack === null) return null;
    const stage = pack.stages.find((candidate) => stageView(candidate) === 'document');
    if (stage === undefined || stage.entityType === undefined) return null;
    return {
      pack,
      stageKey: stage.key,
      entityType: stage.entityType,
      config: stage.document ?? {},
      cards: scenarioStore.listCards(projectId, stage.entityType),
    };
  };

  app.get('/v1/projects/:id/manuscript', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (projectStore.get(id) === null) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });
    const source = manuscriptSource(id);
    if (source === null) {
      return reply.code(404).send({
        error: { code: 'NO_DOCUMENT_STAGE', message: 'this scenario has no writing stage' },
      });
    }
    const chapters = collectChapters(source.cards, source.config);
    const totalChars = chapters.reduce((sum, chapter) => sum + countChars(chapter.text), 0);
    return {
      stage: source.stageKey,
      entityType: source.entityType,
      config: source.config,
      title: projectStore.get(id)?.title ?? '',
      totalChars,
      chapters: chapters.map((chapter) => ({
        id: chapter.id,
        title: chapter.title,
        order: chapter.order,
        chars: countChars(chapter.text),
      })),
    };
  });

  app.post('/v1/projects/:id/manuscript/export', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = projectStore.get(id);
    if (project === null) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });
    const source = manuscriptSource(id);
    if (source === null) {
      return reply.code(404).send({
        error: { code: 'NO_DOCUMENT_STAGE', message: 'this scenario has no writing stage' },
      });
    }
    const chapters = collectChapters(source.cards, source.config);
    if (chapters.length === 0) {
      return reply.code(409).send({ error: { code: 'EMPTY_MANUSCRIPT', message: 'no cards with text yet' } });
    }
    const totalChars = chapters.reduce((sum, chapter) => sum + countChars(chapter.text), 0);
    if (totalChars > MANUSCRIPT_MAX_CHARS) {
      return reply.code(413).send({
        error: { code: 'MANUSCRIPT_TOO_LARGE', message: `over ${MANUSCRIPT_MAX_CHARS} characters` },
      });
    }
    const stem = source.config.fileStem ?? source.pack.id;
    const markdown = buildMarkdown({ title: project.title, chapters });

    try {
      const docx = await buildDocx({ title: project.title, chapters });
      const dir = join(options.workspaceRoot, 'projects', id, 'manuscript');
      mkdirSync(dir, { recursive: true });
      const docxPath = join(dir, `${stem}.docx`);
      const mdPath = join(dir, `${stem}.md`);
      writeFileSync(docxPath, docx);
      writeFileSync(mdPath, markdown, 'utf8');
      return reply.code(201).send({
        file: `manuscript/${stem}.docx`,
        markdownFile: `manuscript/${stem}.md`,
        bytes: docx.length,
        chapters: chapters.length,
        chars: totalChars,
        downloadUrl: `/v1/projects/${id}/manuscript/download/${stem}.docx`,
      });
    } catch (error) {
      return reply.code(500).send({
        error: { code: 'EXPORT_FAILED', message: error instanceof Error ? error.message : String(error) },
      });
    }
  });

  app.get('/v1/projects/:id/manuscript/download/:name', async (request, reply) => {
    const { id, name } = request.params as { id: string; name: string };
    if (projectStore.get(id) === null) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });
    // Only names this route writes itself may be read back: the regex admits no
    // separator, dot segment or drive letter, so `name` cannot leave the manuscript
    // directory the export just created.
    if (!/^[a-z0-9][a-z0-9-]*\.(docx|md)$/.test(name)) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'unknown file' } });
    }
    const absolute = join(options.workspaceRoot, 'projects', id, 'manuscript', name);
    if (!existsSync(absolute)) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: name } });
    }
    const buffer = readFileSync(absolute);
    return reply
      .header('content-type', name.endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'text/markdown; charset=utf-8')
      .header('content-disposition', `attachment; filename="${name}"`)
      .send(buffer);
  });

  // ---------------------------------------------------------------- styles

  app.get('/v1/styles', async () => ({ styles: styleStore.list() }));

  app.post('/v1/styles', async (request, reply) => {
    const body = request.body as
      | { id?: unknown; name?: unknown; tone?: unknown; audience?: unknown; bannedWords?: unknown; notes?: unknown }
      | undefined;
    if (body === undefined || typeof body.name !== 'string' || body.name.trim() === '') {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'name is required' } });
    }
    if (body.id !== undefined && typeof body.id !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'id must be a string' } });
    }
    if (body.id !== undefined && styleStore.get(body.id) === null) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: body.id } });
    }
    try {
      const style = styleStore.save({
        ...(typeof body.id === 'string' ? { id: body.id } : {}),
        name: body.name,
        tone: typeof body.tone === 'string' ? body.tone : '',
        audience: typeof body.audience === 'string' ? body.audience : '',
        bannedWords: Array.isArray(body.bannedWords)
          ? body.bannedWords.filter((word): word is string => typeof word === 'string')
          : [],
        notes: typeof body.notes === 'string' ? body.notes : '',
      });
      return reply.code(201).send({ style });
    } catch (error) {
      return reply.code(400).send({
        error: { code: 'INVALID_INPUT', message: error instanceof Error ? error.message : String(error) },
      });
    }
  });

  app.delete('/v1/styles/:styleId', async (request, reply) => {
    const { styleId } = request.params as { styleId: string };
    if (!styleStore.delete(styleId)) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: styleId } });
    }
    return { deleted: styleId, detached: true };
  });

  /** Lint the latest script against a profile without generating anything. */
  app.get('/v1/projects/:id/style-lint', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (projectStore.get(id) === null) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });
    }
    return { lint: styleLintFor(id) };
  });

  // -------------------------------------------------------------- subtitle

  app.post('/v1/projects/:id/subtitle', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (projectStore.get(id) === null) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });
    }
    const body = request.body as { scriptArtifactId?: unknown } | undefined;
    // An explicit scriptArtifactId lets the user export an older version without
    // re-saving it; anything else falls back to the newest script.
    const explicitId = typeof body?.scriptArtifactId === 'string' ? body.scriptArtifactId : null;
    const latest = artifactStore.latest(id, 'script');
    if (explicitId === null && latest === null) {
      return reply.code(409).send({ error: { code: 'NO_SCRIPT', message: 'generate or save a script first' } });
    }
    const source = explicitId === null ? latest : artifactStore.read(explicitId);
    if (source === null || source.artifact.projectId !== id || source.artifact.kind !== 'script') {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'unknown scriptArtifactId' } });
    }
    const cues = scriptToCues(source.content);
    const srt = buildSrt(cues);
    if (srt === '') {
      return reply.code(422).send({ error: { code: 'EMPTY_SUBTITLE', message: 'script has no speakable text' } });
    }
    // Version allocation and the row insert must be atomic, otherwise two
    // concurrent exports could pick the same version and overwrite each other.
    const artifact = db.transaction(() => {
      const version = artifactStore.nextVersion(id, 'subtitle', 'subtitle');
      return artifactStore.save({
        id: randomUUID(),
        projectId: id,
        runId: null,
        kind: 'subtitle',
        path: `subtitle/subtitle.v${version}.srt`,
        content: srt,
        mime: 'application/x-subrip',
      });
    })();
    return reply.code(201).send({ artifact, cues: cues.length, sourceArtifactId: source.artifact.id });
  });

  // ---------------------------------------------------------------- review

  app.post('/v1/projects/:id/review', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = projectStore.get(id);
    if (project === null) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: id } });
    }
    const metrics = metricsStore.list(id, 5);
    if (metrics.length === 0) {
      return reply.code(409).send({ error: { code: 'NO_METRICS', message: 'record at least one metrics sample first' } });
    }
    const latest = metrics[0];
    if (latest === undefined) {
      return reply.code(409).send({ error: { code: 'NO_METRICS', message: 'record at least one metrics sample first' } });
    }
    const previous = metrics[1];
    const delta = (key: 'views' | 'likes' | 'comments'): string => {
      if (previous === undefined || previous[key] === 0) return '无上期数据';
      const change = Math.round(((latest[key] - previous[key]) / previous[key]) * 1000) / 10;
      return `${change >= 0 ? '+' : ''}${change}%`;
    };
    const engagement =
      latest.views === 0 ? 0 : Math.round(((latest.likes + latest.comments + latest.shares) / latest.views) * 10000) / 100;
    const summaryArtifact = artifactStore.latest(id, 'publish-pack');
    const context = [
      `本期《${project.title}》，平台 ${project.platform}`,
      `播放 ${latest.views}（环比 ${delta('views')}），点赞 ${latest.likes}（环比 ${delta('likes')}），评论 ${latest.comments}（环比 ${delta('comments')}）`,
      `完播率 ${latest.retentionPercent}%，互动率 ${engagement}%，收益 ${latest.revenueCny} 元`,
      latest.note === '' ? '' : `备注：${latest.note}`,
      summaryArtifact === null ? '' : `发布包摘要：${summaryArtifact.content.slice(0, 800)}`,
    ]
      .filter((line) => line !== '')
      .join('\n');

    const runId = randomUUID();
    const profile = options.modelGateway.listProfiles()[0];
    const budget = settingsStore.getBudget();
    runStore.createRun({
      id: runId,
      projectId: id,
      parentRunId: null,
      agentId: 'critic',
      executionMode: 'local',
      status: 'running',
      modelProfileId: profile?.id ?? 'default',
      budget: { maxTokens: 200_000, maxCostCny: budget.perProjectCostCny, usedTokens: 0, usedCostCny: 0 },
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
        kind: 'review-report',
        context,
        includeUpstream: true,
        agentId: 'critic',
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
        // Reporting only.
      }
      // Advance to the stage that owns the report in THIS project's pack. The
      // novel pack calls it `revision`, the video pack `review`; a hardcoded key
      // left novel projects pointing at a stage their pack does not have.
      const reviewStages = scenarioStore.get(project.scenarioId)?.stages ?? [];
      const reviewStage = reviewStages.find((stage) => (stage.produces as readonly string[]).includes('review-report'));
      if (reviewStage === undefined) {
        projectStore.advanceStageIfBehind(id, 'review', reviewStages.map((stage) => stage.key));
      } else {
        projectStore.advanceStageIfBehind(id, reviewStage.key, reviewStages.map((stage) => stage.key));
      }
      appendRunEvent(runId, 'run.finished', { status: 'succeeded', kind: 'review-report', tokens });
      return reply.code(201).send({ ...result, runId });
    } catch (error) {
      const code =
        error instanceof ModelOutputError ? 'MODEL_BAD_OUTPUT' : ((error as { code?: string }).code ?? 'MODEL_ERROR');
      runStore.patchRun(runId, {
        status: 'failed',
        endedAt: clock().toISOString(),
        error: { code, message: error instanceof Error ? error.message : String(error), retryable: false },
      });
      appendRunEvent(runId, 'error', { code });
      return reply.code(502).send({
        error: { code, message: error instanceof Error ? error.message : String(error) },
      });
    }
  });

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
    // The protocol enum lists every agent the product plans to ship; only the
    // specs actually registered in this daemon can execute. Rejecting here means
    // the caller gets a 400 instead of a run that fails at execution time.
    if (!agents.some((agent) => agent.id === agentParsed.data)) {
      return reply.code(400).send({
        error: {
          code: 'UNKNOWN_AGENT',
          message: `agent ${agentParsed.data} is not registered on this daemon`,
        },
        available: agents.map((agent) => agent.id),
      });
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

  /**
   * Automations that are mid-flight, keyed by id.
   *
   * The scheduler ticks every 30 seconds and the manual "run now" endpoint exists
   * alongside it. Without this map, a tick that arrives while the previous
   * generation is still streaming starts a second run for the same automation:
   * two model calls, two artifacts, and two `automation_runs` rows where the user
   * asked for one. The map also lets `close()` wait instead of dropping work.
   */
  const inFlight = new Map<string, Promise<{ status: 'succeeded' | 'failed'; artifactId?: string; error?: string }>>();

  const runAutomation = (
    automationId: string,
  ): Promise<{ status: 'succeeded' | 'failed'; artifactId?: string; error?: string }> => {
    // Single flight per automation: a second caller joins the run already in
    // progress rather than starting a competing one.
    const existing = inFlight.get(automationId);
    if (existing !== undefined) return existing;

    const execution = (async (): Promise<{ status: 'succeeded' | 'failed'; artifactId?: string; error?: string }> => {
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
      } finally {
        inFlight.delete(automationId);
      }
    })();

    inFlight.set(automationId, execution);
    return execution;
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
    // Validated against the shared contract rather than read field by field.
    // The previous hand-rolled reader treated an unknown key such as
    // `completionRate` as "not provided" and answered 201, so a client could
    // record a metric missing the value it thought it sent. Strict parsing turns
    // that into a 400 that names the offending key.
    const parsed = ProjectMetricsInputSchema.strict().safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue !== undefined && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
      const detail = issue === undefined ? 'invalid metrics payload' : issue.message;
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: `${where}${detail}` } });
    }
    const metrics = metricsStore.record(id, {
      views: parsed.data.views,
      likes: parsed.data.likes,
      comments: parsed.data.comments,
      shares: parsed.data.shares ?? 0,
      retentionPercent: parsed.data.retentionPercent ?? 0,
      revenueCny: parsed.data.revenueCny ?? 0,
      note: parsed.data.note ?? '',
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
      // Let in-flight generations finish before the database closes. Closing
      // underneath a running write is how a run row ends up half-written; the
      // bounded wait keeps a stuck model call from blocking shutdown forever.
      if (inFlight.size > 0) {
        await Promise.race([
          Promise.allSettled([...inFlight.values()]),
          new Promise((resolve) => setTimeout(resolve, 10_000)),
        ]);
      }
      await app.close();
      db.close();
    },
  };

}

function buildPublishSummary(artifacts: Array<{ kind: string; path: string }>): string | null {
  const lines: string[] = ['# 发布包', '', '本发布包由稿台 Creator Studio 生成。', ''];
  const order = ['topic-card', 'research-notes', 'script', 'shot-list', 'subtitle', 'publish-pack'];
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
    case 'subtitle':
      return '字幕';
    case 'publish-pack':
      return '包装';
    default:
      return kind;
  }
}
