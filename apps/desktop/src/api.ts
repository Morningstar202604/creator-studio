export type Platform = 'bilibili' | 'youtube' | 'xiaohongshu' | 'generic';

export type Project = {
  id: string;
  ownerId: string;
  title: string;
  platform: Platform;
  stage: 'topic' | 'research' | 'script' | 'shotlist' | 'package' | 'published' | 'review';
  workspacePath: string | null;
  styleProfileId: string | null;
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

const BASE = import.meta.env.VITE_DAEMON_URL ?? 'http://127.0.0.1:7878';

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

  publish: (projectId: string): Promise<{ file: string; bytes: number; entries: string[] }> =>
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
    kind: 'topic-card' | 'research-notes' | 'publish-pack',
    context: string,
  ): Promise<{ artifact: Artifact; payload: unknown }> =>
    request(`/v1/projects/${projectId}/generate`, {
      method: 'POST',
      body: JSON.stringify({ kind, context }),
    }),
};
