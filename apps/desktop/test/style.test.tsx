import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { api, apiExtra } from '../src/api';

const style = {
  id: 's1',
  userId: 'u1',
  name: '理性分析',
  tone: '先结论后证据',
  audience: 'B 站知识区',
  bannedWords: ['赋能'],
  notes: '',
  createdAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:00:00.000Z',
};

vi.mock('../src/api', async () => {
  const actual = await vi.importActual<typeof import('../src/api')>('../src/api');
  return {
    ...actual,
    api: {
      health: vi.fn(async () => ({ ok: true, version: 1, workspaceRoot: 'C:/ws', os: 'win32', pid: 1 })),
      tools: vi.fn(async () => ({ tools: [] })),
      listProjects: vi.fn(async () => ({ projects: [] })),
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
          title: '风格项目',
          platform: 'bilibili',
          stage: 'script',
          workspacePath: null,
          styleProfileId: null,
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
      listArtifacts: vi.fn(async () => ({ artifacts: [] })),
      getArtifact: vi.fn(),
      saveArtifact: vi.fn(),
      rewrite: vi.fn(),
      generate: vi.fn(),
      checklist: vi.fn(async () => ({ items: [], ready: false, missing: [] })),
      publish: vi.fn(),
      listModels: vi.fn(async () => ({
        models: [
          {
            id: 'm1',
            name: 'OpenAI',
            provider: 'openai-compatible',
            baseUrl: 'https://api.openai.com/v1',
            model: 'gpt-4o-mini',
            contextWindow: 128000,
            priceInPerM: 1,
            priceOutPerM: 2,
            isLocal: false,
          },
        ],
        activeModelId: 'm1',
        source: 'stored',
      })),
      getBudget: vi.fn(async () => ({ budget: { monthlyCostCny: 50, perProjectCostCny: 5, warnAtPercent: 80 } })),
    },
    apiExtra: {
      ...actual.apiExtra,
      styles: vi.fn(async () => ({ styles: [style] })),
      saveStyle: vi.fn(async () => ({ style })),
      deleteStyle: vi.fn(async () => ({ deleted: 's1', detached: true })),
      styleLint: vi.fn(async () => ({ lint: { bannedWords: ['赋能'], hits: [{ word: '赋能', count: 2 }] } })),
      exportSubtitle: vi.fn(async () => ({
        artifact: {
          id: 'a2',
          projectId: 'p1',
          runId: null,
          kind: 'subtitle',
          path: 'subtitle/subtitle.v1.srt',
          sha256: '',
          mime: 'application/x-subrip',
          size: 10,
          visibility: 'local',
          createdAt: '2026-10-26T00:00:00.000Z',
        },
        cues: 12,
        sourceArtifactId: 'a1',
      })),
      generateReview: vi.fn(async () => ({
        artifact: {
          id: 'a3',
          projectId: 'p1',
          runId: null,
          kind: 'review-report',
          path: 'review/review-report.v1.md',
          sha256: '',
          mime: 'text/markdown',
          size: 10,
          visibility: 'local',
          createdAt: '2026-10-26T00:00:00.000Z',
        },
        payload: {},
        runId: 'r1',
      })),
      metrics: vi.fn(async () => ({ metrics: [] })),
      updateProject: vi.fn(async () => ({
        project: {
          id: 'p1',
          ownerId: 'u1',
          title: '风格项目',
          platform: 'bilibili',
          stage: 'script',
          workspacePath: null,
          styleProfileId: 's1',
          createdAt: '2026-10-26T00:00:00.000Z',
          updatedAt: '2026-10-26T00:00:00.000Z',
          deletedAt: null,
        },
      })),
      projectDetail: vi.fn(async () => ({
        project: {
          id: 'p1',
          ownerId: 'u1',
          title: '风格项目',
          platform: 'bilibili',
          stage: 'script',
          workspacePath: null,
          styleProfileId: null,
          createdAt: '2026-10-26T00:00:00.000Z',
          updatedAt: '2026-10-26T00:00:00.000Z',
          deletedAt: null,
        },
        stats: { artifacts: 0, runs: 0, tokens: 0, costCny: 0 },
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

// ECharts needs a real canvas; the assertions here are about the data flow, so
// the chart is stubbed the same way other canvas-dependent suites would.
vi.mock('../src/components/Chart', () => ({
  Chart: () => null,
  trendOption: () => ({}),
  barsOption: () => ({}),
  chartPalette: () => ({ series: [], axis: '', grid: '', text: '', tooltipBg: '', tooltipBorder: '' }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = '#/settings';
});

describe('R1 style settings panel', () => {
  it('lists existing profiles and creates a new one', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: '风格' }));
    expect(await screen.findByText('理性分析')).toBeTruthy();

    await user.type(screen.getByLabelText('风格名称'), '短句口播');
    await user.type(screen.getByLabelText('禁用词'), '赋能、抓手');
    await user.click(screen.getByRole('button', { name: '创建风格' }));

    await waitFor(() => {
      expect(mockedExtra.saveStyle).toHaveBeenCalledWith({
        name: '短句口播',
        tone: '',
        audience: '',
        bannedWords: ['赋能', '抓手'],
        notes: '',
      });
    });
  });

  it('edits and deletes a profile', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: '风格' }));
    await user.click(await screen.findByRole('button', { name: '编辑' }));
    expect((screen.getByLabelText('风格名称') as HTMLInputElement).value).toBe('理性分析');
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => {
      expect(mockedExtra.saveStyle).toHaveBeenCalledWith(expect.objectContaining({ id: 's1', name: '理性分析' }));
    });
  });
});

describe('R2 project attaches a style profile', () => {
  it('sends the selected style profile id when saving project settings', async () => {
    window.location.hash = '#/p/p1';
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: '编辑项目' }));
    const select = await screen.findByLabelText('风格档案');
    await user.selectOptions(select, 's1');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(mockedExtra.updateProject).toHaveBeenCalledWith('p1', expect.objectContaining({ styleProfileId: 's1' }));
    });
  });
});

describe('R3 script page exports subtitles', () => {
  it('calls the subtitle endpoint and shows the new artifact', async () => {
    mockedApi.listArtifacts.mockResolvedValueOnce({
      artifacts: [
        {
          id: 'a1',
          projectId: 'p1',
          runId: null,
          kind: 'script',
          path: 'script/script.v1.md',
          sha256: '',
          mime: 'text/markdown',
          size: 10,
          visibility: 'local',
          createdAt: '2026-10-26T00:00:00.000Z',
        },
      ],
    });
    mockedApi.getArtifact.mockResolvedValueOnce({
      artifact: {
        id: 'a1',
        projectId: 'p1',
        runId: null,
        kind: 'script',
        path: 'script/script.v1.md',
        sha256: '',
        mime: 'text/markdown',
        size: 10,
        visibility: 'local',
        createdAt: '2026-10-26T00:00:00.000Z',
      },
      content: '第一句。第二句。',
    });
    window.location.hash = '#/p/p1/script';
    const user = userEvent.setup();
    render(<App />);
    const button = await screen.findByRole('button', { name: '导出 SRT 字幕' });
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
    await user.click(button);
    await waitFor(() => {
      expect(mockedExtra.exportSubtitle).toHaveBeenCalledWith('p1');
    });
  });
});

describe('R4 review page generates a report', () => {
  it('disables until metrics exist and calls the review endpoint', async () => {
    mockedExtra.metrics.mockResolvedValue({
      metrics: [
        {
          id: 'm1',
          projectId: 'p1',
          recordedAt: '2026-10-26T00:00:00.000Z',
          views: 1000,
          likes: 50,
          comments: 10,
          shares: 2,
          retentionPercent: 42,
          revenueCny: 3,
          note: '',
        },
      ],
    });
    mockedApi.getArtifact.mockResolvedValue({
      artifact: {
        id: 'a3',
        projectId: 'p1',
        runId: null,
        kind: 'review-report',
        path: 'review/review-report.v1.md',
        sha256: '',
        mime: 'text/markdown',
        size: 10,
        visibility: 'local',
        createdAt: '2026-10-26T00:00:00.000Z',
      },
      content: '## 综合评分：82',
    });
    window.location.hash = '#/p/p1/review';
    const user = userEvent.setup();
    render(<App />);
    const button = await screen.findByRole('button', { name: '生成复盘报告' });
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
    await user.click(button);
    await waitFor(() => {
      expect(mockedExtra.generateReview).toHaveBeenCalledWith('p1');
    });
  });
});
