export type ClientOptions = {
  baseUrl: string;
  fetchImpl?: typeof fetch;
};

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

export type Project = {
  id: string;
  title: string;
  platform: string;
  stage: string;
  description: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

export type Artifact = {
  id: string;
  projectId: string;
  kind: string;
  path: string;
  size: number;
  createdAt: string;
};

export type Run = {
  id: string;
  projectId: string;
  agentId: string;
  status: string;
  budget: { usedTokens: number; usedCostCny: number };
  error: { code: string; message: string } | null;
};

/**
 * Minimal HTTP client for the local daemon. The CLI intentionally speaks the same
 * public API as the desktop UI instead of importing daemon internals, so both
 * surfaces stay in lockstep and the CLI also works against a remote daemon.
 */
export class DaemonClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get url(): string {
    return this.baseUrl;
  }

  async request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(init?.headers ?? {}),
        },
      });
    } catch (error) {
      throw new ApiError(
        'DAEMON_UNREACHABLE',
        `无法连接 ${this.baseUrl}：${error instanceof Error ? error.message : '网络错误'}`,
        0,
      );
    }
    const text = await response.text();
    let body: unknown = null;
    if (text !== '') {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = { error: { code: 'BAD_RESPONSE', message: text.slice(0, 200) } };
      }
    }
    if (!response.ok) {
      const parsed = body as { error?: { code?: string; message?: string } } | null;
      throw new ApiError(
        parsed?.error?.code ?? 'HTTP_ERROR',
        parsed?.error?.message ?? `HTTP ${response.status}`,
        response.status,
      );
    }
    return body as T;
  }

  health(): Promise<{ ok: boolean; capabilities: string[]; workspaceRoot: string; apiVersion: number }> {
    return this.request('/health');
  }

  listProjects(query = ''): Promise<{ projects: Project[]; counts: { total: number; active: number; deleted: number } }> {
    return this.request(`/v1/projects${query === '' ? '' : `?q=${encodeURIComponent(query)}`}`);
  }

  createProject(input: { title: string; platform?: string; description?: string; tags?: string[] }): Promise<{ project: Project }> {
    return this.request('/v1/projects', { method: 'POST', body: JSON.stringify(input) });
  }

  getProject(id: string): Promise<{
    project: Project;
    stats: { artifacts: number; runs: number; tokens: number; costCny: number };
    checklist: Array<{ key: string; label: string; ok: boolean; required: boolean }>;
  }> {
    return this.request(`/v1/projects/${id}`);
  }

  deleteProject(id: string): Promise<{ deleted: string }> {
    return this.request(`/v1/projects/${id}`, { method: 'DELETE' });
  }

  listArtifacts(projectId: string): Promise<{ artifacts: Artifact[] }> {
    return this.request(`/v1/projects/${projectId}/artifacts`);
  }

  getArtifact(id: string): Promise<{ artifact: Artifact; content: string }> {
    return this.request(`/v1/artifacts/${id}`);
  }

  generate(
    projectId: string,
    kind: string,
    context: string,
  ): Promise<{ artifact: Artifact; payload: unknown }> {
    return this.request(`/v1/projects/${projectId}/generate`, {
      method: 'POST',
      body: JSON.stringify({ kind, context }),
    });
  }

  checklist(projectId: string): Promise<{ items: Array<{ key: string; label: string; ok: boolean; required: boolean }>; ready: boolean; missing: string[] }> {
    return this.request(`/v1/projects/${projectId}/checklist`);
  }

  publish(projectId: string): Promise<{ file: string; absolutePath: string; bytes: number; entries: string[] }> {
    return this.request(`/v1/projects/${projectId}/publish`, { method: 'POST' });
  }

  createRun(projectId: string, message: string, agentId: string): Promise<{ run: Run }> {
    return this.request(`/v1/projects/${projectId}/runs`, {
      method: 'POST',
      body: JSON.stringify({ message, agentId }),
    });
  }

  executeRun(runId: string, message: string, agentId: string): Promise<{ outcome: { status: string; text?: string }; run: Run }> {
    return this.request(`/v1/runs/${runId}/execute`, {
      method: 'POST',
      body: JSON.stringify({ message, agentId }),
    });
  }

  listRuns(params: { status?: string; projectId?: string } = {}): Promise<{ runs: Run[] }> {
    const search = new URLSearchParams();
    if (params.status !== undefined) search.set('status', params.status);
    if (params.projectId !== undefined) search.set('projectId', params.projectId);
    return this.request(`/v1/runs${search.size === 0 ? '' : `?${search.toString()}`}`);
  }

  usage(): Promise<{ totals: { runs: number; tokens: number; cost: number }; byAgent: unknown[] }> {
    return this.request('/v1/usage');
  }

}
