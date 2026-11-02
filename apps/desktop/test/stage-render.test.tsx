import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { api, apiExtra } from '../src/api';

const ARTIFACTS = [
  {
    id: 'a1',
    projectId: 'p1',
    runId: null,
    kind: 'shot-list',
    path: 'shotlist/shot-list.v1.md',
    sha256: 'a'.repeat(64),
    mime: 'text/markdown',
    size: 120,
    visibility: 'local' as const,
    createdAt: '2026-10-26T00:00:00.000Z',
  },
];

const SHOT_LIST = `## 分镜表

| # | 时间 | 景别 | 画面 |
|---|---|---|---|
| 0 | 00:00 | 近景 | 开场 |

<script>window.__pwned = true;</script>`;

vi.mock('../src/api', async () => {
  const actual = await vi.importActual<typeof import('../src/api')>('../src/api');
  return {
    ...actual,
    api: {
      health: vi.fn(async () => ({ ok: true, version: 1, workspaceRoot: 'C:/ws', os: 'win32', pid: 1 })),
      tools: vi.fn(async () => ({ tools: [] })),
      listProjects: vi.fn(async (params: { includeDeleted?: boolean } = {}) => ({
        projects: [
          {
            id: 'p1',
            ownerId: 'u1',
            title: '渲染测试',
            platform: 'bilibili',
            stage: 'shotlist',
            workspacePath: null,
            styleProfileId: null,
            description: '',
            tags: [],
            createdAt: '2026-10-26T00:00:00.000Z',
            updatedAt: '2026-10-26T00:00:00.000Z',
            deletedAt: null,
          },
          ...(params.includeDeleted === true
            ? [
                {
                  id: 'p2',
                  ownerId: 'u1',
                  title: '删掉的项目',
                  platform: 'bilibili',
                  stage: 'topic',
                  workspacePath: null,
                  styleProfileId: null,
                  description: '',
                  tags: [],
                  createdAt: '2026-10-26T00:00:00.000Z',
                  updatedAt: '2026-10-26T00:00:00.000Z',
                  deletedAt: '2026-10-26T01:00:00.000Z',
                },
              ]
            : []),
        ],
        counts: { total: 2, active: 1, deleted: 1 },
      })),
      scenarios: vi.fn(async () => ({
        scenarios: [
          {
            id: 'video',
            name: '中长视频',
            description: '',
            icon: '',
            builtin: true,
            defaultPlatform: 'bilibili',
            stages: [
              { key: 'topic', label: '选题', hint: '', produces: ['topic-card'], promptHint: '', required: true },
              { key: 'research', label: '资料', hint: '', produces: ['research-notes'], promptHint: '', required: true },
              { key: 'script', label: '脚本', hint: '', produces: ['script'], promptHint: '', required: true },
              { key: 'shotlist', label: '分镜', hint: '', produces: ['shot-list'], promptHint: '', required: false },
              { key: 'package', label: '包装', hint: '', produces: ['publish-pack'], promptHint: '', required: true },
              { key: 'published', label: '发布', hint: '', produces: [], promptHint: '', required: false },
              { key: 'review', label: '复盘', hint: '', produces: ['review-report'], promptHint: '', required: false },
            ],
            entityTypes: [],
          },
        ],
        defaultId: 'video',
      })),
      getProject: vi.fn(async () => ({
        project: {
          id: 'p1',
          ownerId: 'u1',
          title: '渲染测试',
          platform: 'bilibili',
          stage: 'shotlist',
          workspacePath: null,
          styleProfileId: null,
          description: '',
          tags: [],
          createdAt: '2026-10-26T00:00:00.000Z',
          updatedAt: '2026-10-26T00:00:00.000Z',
          deletedAt: null,
        },
      })),
      createProject: vi.fn(),
      advanceStage: vi.fn(),
      createRun: vi.fn(),
      executeRun: vi.fn(),
      listRuns: vi.fn(async () => ({ runs: [] })),
      getRun: vi.fn(),
      runEvents: vi.fn(),
      listApprovals: vi.fn(async () => ({ approvals: [] })),
      decideApproval: vi.fn(),
      audit: vi.fn(async () => ({ records: [] })),
      streamUrl: vi.fn(),
      listArtifacts: vi.fn(async () => ({ artifacts: ARTIFACTS })),
      getArtifact: vi.fn(async () => ({ artifact: ARTIFACTS[0], content: SHOT_LIST })),
      saveArtifact: vi.fn(),
      rewrite: vi.fn(),
      generate: vi.fn(),
      checklist: vi.fn(async () => ({ items: [], ready: false, missing: [] })),
      publish: vi.fn(),
    },
    apiExtra: {
      ...actual.apiExtra,
      restoreProject: vi.fn(async () => ({ project: { id: 'p2' } })),
      projectDetail: vi.fn(async () => ({
        project: {
          id: 'p1',
          ownerId: 'u1',
          title: '渲染测试',
          platform: 'bilibili',
          stage: 'shotlist',
          workspacePath: null,
          styleProfileId: null,
          description: '',
          tags: [],
          createdAt: '2026-10-26T00:00:00.000Z',
          updatedAt: '2026-10-26T00:00:00.000Z',
          deletedAt: null,
        },
        stats: { artifacts: 1, runs: 0, tokens: 0, costCny: 0 },
        checklist: [],
      })),
      usage: vi.fn(async () => ({
        totals: { runs: 0, tokens: 0, cost: 0 },
        budget: { monthlyCostCny: 50, perProjectCostCny: 5, warnAtPercent: 80 },
        byAgent: [],
      })),
    },
  };
});

const mockedApi = vi.mocked(api, true);
const mockedExtra = vi.mocked(apiExtra, true);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('R1 stage pages render sanitized Markdown', () => {
  it('renders the shot list as a table, not literal pipes', async () => {
    window.location.hash = '#/p/p1/shotlist';
    const { container } = render(<App />);

    await waitFor(() => {
      expect(container.querySelector('table')).not.toBeNull();
    });
    const table = container.querySelector('table');
    expect(table?.textContent).toContain('近景');
    // Literal markdown markers must not survive as visible text.
    expect(container.textContent).not.toContain('|---|');
    // Model output is untrusted: a script tag must never become an element.
    expect(container.querySelector('script')).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });
});

describe('R1b research page accepts reference links', () => {
  it('sends the typed URLs to generate', async () => {
    window.location.hash = '#/p/p1/research';
    const user = userEvent.setup();
    render(<App />);

    await user.type(await screen.findByPlaceholderText(/2026 年 AI 编程工具对校招的影响/), '示例域名');
    await user.type(screen.getByLabelText('参考链接'), 'https://example.com/');
    await user.click(screen.getByRole('button', { name: '开始生成' }));

    await waitFor(() => {
      expect(mockedApi.generate).toHaveBeenCalledWith('p1', 'research-notes', '示例域名', ['https://example.com/']);
    });
  });
});

describe('R2 deleted projects can be restored from the UI', () => {
  it('lists deleted projects and restores one', async () => {
    window.location.hash = '#/';
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: '已删除' }));
    expect(await screen.findByText('删掉的项目')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '恢复' }));
    await waitFor(() => {
      expect(mockedExtra.restoreProject).toHaveBeenCalledWith('p2');
    });
    // The active list is refetched so the restored project appears immediately.
    await waitFor(() => {
      expect(mockedApi.listProjects).toHaveBeenCalled();
    });
  });
});
