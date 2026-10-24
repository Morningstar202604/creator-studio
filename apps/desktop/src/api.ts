export type Platform = 'bilibili' | 'youtube' | 'xiaohongshu' | 'generic';

export type Project = {
  id: string;
  ownerId: string;
  title: string;
  platform: Platform;
  stage: 'topic' | 'research' | 'script' | 'shotlist' | 'package' | 'published' | 'review';
  workspacePath: string | null;
  styleProfileId: string | null;
  description?: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type Run = {
  id: string;
  projectId: string;
  agentId: string;
  status: 'queued' | 'running' | 'waiting_approval' | 'paused' | 'succeeded' | 'failed' | 'cancelled';
  budget: { maxTokens: number; maxCostCny: number; usedTokens: number; usedCostCny: number };
  error: { code: string; message: string; retryable: boolean } | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
};

export type Step = {
  id: string;
  runId: string;
  index: number;
  kind: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
};

export type RunEvent = {
  id: string;
  runId: string;
  seq: number;
  type: string;
  payload: unknown;
  ts: string;
};

export type Approval = {
  id: string;
  runId: string;
  stepId: string;
  kind: string;
  decision: 'pending' | 'approved' | 'rejected' | 'expired';
  requestedAt: string;
};

export type Health = {
  ok: boolean;
  version: number;
  apiVersion?: number;
  capabilities?: string[];
  workspaceRoot: string;
  os: string;
  pid: number;
};

/** Routes this build of the UI requires. A daemon missing any of them is stale. */
export const REQUIRED_CAPABILITIES = ['artifacts', 'generate', 'stream', 'runs'] as const;

export type ToolInfo = { name: string; risk: string; approvalKind: string | null };

export type ModelInfo = {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  model: string;
  contextWindow: number;
  priceInPerM: number;
  priceOutPerM: number;
  isLocal: boolean;
  keyConfigured?: boolean;
};

export type GrantInfo = { id: string; deviceId: string; tool: string; scope: string; mode: string };

export type GrantTool = { name: string; risk: string; approvalKind: string | null; mode: string };

export type BudgetSettings = { monthlyCostCny: number; perProjectCostCny: number; warnAtPercent: number };

export type ChecklistItem = {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
  stage: string;
  required?: boolean;
};

export type Artifact = {
  id: string;
  projectId: string;
  runId: string | null;
  kind: string;
  path: string;
  sha256: string;
  mime: string;
  size: number;
  visibility: 'local' | 'synced';
  createdAt: string;
};

function resolveBase(): string {
  const explicit = import.meta.env.VITE_DAEMON_URL as string | undefined;
  if (explicit !== undefined && explicit !== '') return explicit;
  // Served by the daemon itself (web mode): talk to the same origin so a custom
  // --port works without rebuilding. The Tauri shell loads from tauri.localhost
  // (a pseudo-origin with no HTTP server) and keeps the loopback default.
  if (typeof window !== 'undefined') {
    const { protocol, hostname, origin } = window.location;
    const isLocalHttp =
      (protocol === 'http:' || protocol === 'https:') &&
      (hostname === '127.0.0.1' || hostname === 'localhost');
    if (isLocalHttp) return origin;
  }
  return 'http://127.0.0.1:7878';
}

const BASE = resolveBase();

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  const hasBody = init?.body !== undefined;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (error) {
    throw new ApiError(
      'DAEMON_UNREACHABLE',
      `无法连接本地 daemon（${BASE}）：${error instanceof Error ? error.message : '网络错误'}`,
      0,
    );
  }

  const text = await response.text();
  const body = text === '' ? null : (JSON.parse(text) as unknown);

  if (!response.ok) {
    const parsed = body as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(
      parsed?.error?.code ?? 'HTTP_ERROR',
      parsed?.error?.message ?? `请求失败 ${response.status}`,
      response.status,
    );
  }
  return body as T;
}

export const api = {
  health: (): Promise<Health> => request('/health'),

  tools: (): Promise<{ tools: ToolInfo[] }> => request('/v1/tools'),

  listProjects: (): Promise<{ projects: Project[] }> => request('/v1/projects'),

  getProject: (id: string): Promise<{ project: Project }> => request(`/v1/projects/${id}`),

  createProject: (title: string, platform: Platform): Promise<{ project: Project }> =>
    request('/v1/projects', { method: 'POST', body: JSON.stringify({ title, platform }) }),

  advanceStage: (id: string, stage: Project['stage']): Promise<{ project: Project }> =>
    request(`/v1/projects/${id}/stage`, { method: 'POST', body: JSON.stringify({ stage }) }),

  createRun: (
    projectId: string,
    message: string,
    agentId: string,
  ): Promise<{ run: Run }> =>
    request(`/v1/projects/${projectId}/runs`, {
      method: 'POST',
      body: JSON.stringify({ message, agentId }),
    }),

  executeRun: (
    runId: string,
    message: string,
    agentId: string,
  ): Promise<{ outcome: { status: string; text?: string; code?: string; message?: string; steps: number }; run: Run }> =>
    request(`/v1/runs/${runId}/execute`, {
      method: 'POST',
      body: JSON.stringify({ message, agentId }),
    }),

  listRuns: (params: { status?: string; projectId?: string; limit?: number } = {}): Promise<{ runs: Run[] }> => {
    const search = new URLSearchParams();
    if (params.status !== undefined) search.set('status', params.status);
    if (params.projectId !== undefined) search.set('projectId', params.projectId);
    if (params.limit !== undefined) search.set('limit', String(params.limit));
    const suffix = search.toString() === '' ? '' : `?${search.toString()}`;
    return request(`/v1/runs${suffix}`);
  },

  getRun: (runId: string): Promise<{ run: Run; steps: Step[]; approvals: Approval[] }> =>
    request(`/v1/runs/${runId}`),

  runEvents: (runId: string, after = -1): Promise<{ events: RunEvent[] }> =>
    request(`/v1/runs/${runId}/events?after=${after}`),

  listApprovals: (status = 'pending'): Promise<{ approvals: Approval[] }> =>
    request(`/v1/approvals?status=${status}`),

  decideApproval: (id: string, decision: 'approved' | 'rejected'): Promise<{ approval: Approval }> =>
    request(`/v1/approvals/${id}`, { method: 'POST', body: JSON.stringify({ decision }) }),

  audit: (): Promise<{ records: Array<{ tool: string; decision: string; ok: boolean; target: string }> }> =>
    request('/v1/audit'),

  streamUrl: (runId: string, after = -1): string => `${BASE}/v1/runs/${runId}/stream?after=${after}`,

  listArtifacts: (projectId: string): Promise<{ artifacts: Artifact[] }> =>
    request(`/v1/projects/${projectId}/artifacts`),

  getArtifact: (artifactId: string): Promise<{ artifact: Artifact; content: string }> =>
    request(`/v1/artifacts/${artifactId}`),

  saveArtifact: (
    projectId: string,
    input: { kind: string; path: string; content: string; runId?: string },
  ): Promise<{ artifact: Artifact }> =>
    request(`/v1/projects/${projectId}/artifacts`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  rewrite: (text: string, instruction: string): Promise<{ rewritten: string; durationMs: number }> =>
    request('/v1/rewrite', { method: 'POST', body: JSON.stringify({ text, instruction }) }),

  checklist: (projectId: string): Promise<{ items: ChecklistItem[]; ready: boolean; missing: string[] }> =>
    request(`/v1/projects/${projectId}/checklist`),

  publish: (projectId: string): Promise<{ file: string; bytes: number; entries: string[]; absolutePath?: string }> =>
    request(`/v1/projects/${projectId}/publish`, { method: 'POST' }),

  onboardingStatus: (): Promise<{
    completed: boolean;
    modelConfigured: boolean;
    workspaceRoot: string;
    tools: number;
  }> => request('/v1/onboarding'),

  completeOnboarding: (): Promise<{ completed: boolean }> =>
    request('/v1/onboarding/complete', { method: 'POST' }),

  listModels: (): Promise<{ models: ModelInfo[]; activeModelId: string | null; source: string }> =>
    request('/v1/settings/models'),

  saveModel: (input: {
    name: string;
    baseUrl: string;
    model: string;
    contextWindow?: number;
    priceInPerM?: number;
    priceOutPerM?: number;
    isLocal?: boolean;
  }): Promise<{ model: ModelInfo }> => request('/v1/settings/models', { method: 'POST', body: JSON.stringify(input) }),

  deleteModel: (id: string): Promise<null> =>
    request(`/v1/settings/models/${id}`, { method: 'DELETE' }),

  listGrants: (): Promise<{ deviceId: string; grants: GrantInfo[]; tools: GrantTool[] }> =>
    request('/v1/settings/grants'),

  setGrant: (tool: string, mode: 'auto' | 'ask' | 'deny'): Promise<{ grants: GrantInfo[] }> =>
    request('/v1/settings/grants', { method: 'POST', body: JSON.stringify({ tool, mode }) }),

  getBudget: (): Promise<{ budget: BudgetSettings }> => request('/v1/settings/budget'),

  setBudget: (input: Partial<BudgetSettings>): Promise<{ budget: BudgetSettings }> =>
    request('/v1/settings/budget', { method: 'POST', body: JSON.stringify(input) }),

  generate: (
    projectId: string,
    kind: 'topic-card' | 'research-notes' | 'script' | 'shot-list' | 'publish-pack' | 'review-report',
    context: string,
  ): Promise<{ artifact: Artifact; payload: unknown }> =>
    request(`/v1/projects/${projectId}/generate`, {
      method: 'POST',
      body: JSON.stringify({ kind, context }),
    }),
};

export type Automation = {
  id: string;
  projectId: string;
  name: string;
  kind: 'topic-card' | 'research-notes' | 'publish-pack';
  prompt: string;
  intervalMinutes: number;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  recentRuns: AutomationRun[];
};

export type AutomationRun = {
  id: string;
  automationId: string;
  status: 'running' | 'succeeded' | 'failed';
  artifactId: string | null;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
};

export type ProjectMetrics = {
  id: string;
  projectId: string;
  recordedAt: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  retentionPercent: number;
  revenueCny: number;
  note: string;
};

export type LibraryItem = {
  id: string;
  projectId: string;
  projectTitle: string;
  kind: string;
  path: string;
  size: number;
  createdAt: string;
};

export type Dashboard = {
  counts: { total: number; active: number; deleted: number };
  artifactsByKind: Array<{ kind: string; count: number }>;
  runsByStatus: Array<{ status: string; count: number }>;
  spend: { costCny: number; tokens: number };
  projects: Array<{
    id: string;
    title: string;
    stage: string;
    platform: string;
    artifacts: number;
    views: number;
    updatedAt: string;
  }>;
  metricsSummary: Array<{
    projectId: string;
    samples: number;
    views: number;
    likes: number;
    comments: number;
    shares: number;
  }>;
};

export const apiExtra = {
  usage: async (): Promise<Usage> => {
    try {
      return await request('/v1/usage');
    } catch {
      return {
        totals: { runs: 0, tokens: 0, cost: 0 },
        budget: { monthlyCostCny: 0, perProjectCostCny: 0, warnAtPercent: 80 },
        byAgent: [],
      };
    }
  },

  updateProject: (
    id: string,
    input: { title?: string; platform?: Platform; description?: string; tags?: string[] },
  ): Promise<{ project: Project }> =>
    request(`/v1/projects/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),

  deleteProject: (id: string): Promise<{ deleted: string; recoverable: boolean }> =>
    request(`/v1/projects/${id}`, { method: 'DELETE' }),

  projectDetail: (id: string): Promise<{
    project: Project;
    stats: { artifacts: number; runs: number; tokens: number; costCny: number };
    checklist: ChecklistItem[];
  }> => request(`/v1/projects/${id}`),

  library: (params: { kind?: string; q?: string } = {}): Promise<{
    items: LibraryItem[];
    projects: Array<{ id: string; title: string }>;
  }> => {
    const search = new URLSearchParams();
    if (params.kind !== undefined && params.kind !== '') search.set('kind', params.kind);
    if (params.q !== undefined && params.q !== '') search.set('q', params.q);
    const suffix = search.toString() === '' ? '' : `?${search.toString()}`;
    return request(`/v1/library${suffix}`);
  },

  dashboard: (): Promise<Dashboard> => request('/v1/dashboard'),

  automations: (projectId?: string): Promise<{ automations: Automation[] }> =>
    request(`/v1/automations${projectId === undefined ? '' : `?projectId=${projectId}`}`),

  createAutomation: (input: {
    projectId: string;
    name: string;
    kind: 'topic-card' | 'research-notes' | 'publish-pack';
    prompt: string;
    intervalMinutes: number;
    enabled?: boolean;
  }): Promise<{ automation: Automation }> =>
    request('/v1/automations', { method: 'POST', body: JSON.stringify(input) }),

  toggleAutomation: (id: string, enabled: boolean): Promise<{ automation: Automation }> =>
    request(`/v1/automations/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),

  deleteAutomation: (id: string): Promise<null> => request(`/v1/automations/${id}`, { method: 'DELETE' }),

  runAutomation: (id: string): Promise<{ status: string; artifactId?: string; error?: string }> =>
    request(`/v1/automations/${id}/run`, { method: 'POST' }),

  metrics: (projectId: string): Promise<{ metrics: ProjectMetrics[] }> =>
    request(`/v1/projects/${projectId}/metrics`),

  addMetrics: (
    projectId: string,
    input: {
      views: number;
      likes: number;
      comments: number;
      shares?: number;
      retentionPercent?: number;
      revenueCny?: number;
      note?: string;
    },
  ): Promise<{ metrics: ProjectMetrics }> =>
    request(`/v1/projects/${projectId}/metrics`, { method: 'POST', body: JSON.stringify(input) }),

  deleteMetrics: (id: string): Promise<null> => request(`/v1/metrics/${id}`, { method: 'DELETE' }),

  cancelRun: (runId: string): Promise<{ run: Run }> =>
    request(`/v1/runs/${runId}/cancel`, { method: 'POST' }),

  resumeRun: (
    runId: string,
    approvalId?: string,
  ): Promise<{ outcome: { status: string; text?: string; code?: string }; run: Run }> =>
    request(`/v1/runs/${runId}/resume`, {
      method: 'POST',
      body: JSON.stringify(approvalId === undefined ? {} : { approvalId }),
    }),

  setModelKey: (id: string, apiKey: string): Promise<{ id: string; keyConfigured: boolean }> =>
    request(`/v1/settings/models/${id}/key`, { method: 'POST', body: JSON.stringify({ apiKey }) }),

  testModel: (id: string): Promise<{ ok: boolean; latencyMs: number; sample?: string; code?: string; message?: string }> =>
    request(`/v1/settings/models/${id}/test`, { method: 'POST' }),

  saveModelFull: (input: {
    id?: string;
    name: string;
    baseUrl: string;
    model: string;
    provider?: string;
    apiKey?: string;
    contextWindow?: number;
    priceInPerM?: number;
    priceOutPerM?: number;
    isLocal?: boolean;
  }): Promise<{ model: ModelInfo }> =>
    request('/v1/settings/models', { method: 'POST', body: JSON.stringify(input) }),

  listModelsFull: (): Promise<{
    models: Array<ModelInfo & { apiKeyRef: string; keyConfigured: boolean; source: string }>;
    activeModelId: string | null;
    source: string;
  }> => request('/v1/settings/models'),
};

export type Usage = {
  totals: { runs: number; tokens: number; cost: number };
  budget: BudgetSettings;
  byAgent: Array<{
    agentId: string;
    status: string;
    runs: number;
    tokens: number;
    costCny: number;
    avgSeconds: number | null;
  }>;
};

export type SettingsTab = 'models' | 'grants' | 'budget' | 'appearance';
