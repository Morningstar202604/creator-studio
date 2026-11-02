import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { api } from '../src/api';

const PACK = {
  id: 'novel',
  name: '长篇小说',
  description: '',
  icon: '📖',
  builtin: true,
  defaultPlatform: 'generic' as const,
  formatVersion: 2,
  requiresViews: ['generate', 'document'],
  stages: [
    {
      key: 'premise',
      label: '设定',
      view: 'generate' as const,
      hint: '一句话卖点、题材、读者预期与差异化',
      produces: ['topic-card'],
      promptHint: '给出 3 个可写的故事前提。',
      required: true,
    },
    {
      key: 'chapter',
      label: '章节',
      view: 'document' as const,
      entityType: 'chapter',
      document: { orderField: 'number' },
      hint: '逐章正文',
      produces: ['chapter'],
      promptHint: '',
      required: true,
    },
  ],
  entityTypes: [
    {
      key: 'chapter',
      label: '章节',
      labelPlural: '章节卡',
      hint: '',
      icon: '📄',
      titleField: 'title',
      summaryFields: [],
      fields: [
        { key: 'title', label: '章节标题', type: 'text' as const, required: true, options: [], placeholder: '', wide: false },
        { key: 'number', label: '章节序号', type: 'number' as const, required: false, options: [], placeholder: '', wide: false },
      ],
    },
  ],
  relationTypes: [],
};

const PROJECT = {
  id: 'p1',
  ownerId: 'u1',
  title: '雾港纪事',
  platform: 'generic' as const,
  stage: 'premise',
  scenarioId: 'novel',
  workspacePath: null,
  styleProfileId: null,
  description: '',
  tags: [],
  createdAt: '2026-10-27T00:00:00.000Z',
  updatedAt: '2026-10-27T00:00:00.000Z',
  deletedAt: null,
};

vi.mock('../src/api', async () => {
  const actual = await vi.importActual<typeof import('../src/api')>('../src/api');
  return {
    ...actual,
    api: {
      health: vi.fn(async () => ({ ok: true, version: 1, workspaceRoot: 'C:/ws', os: 'win32', pid: 1 })),
      tools: vi.fn(async () => ({ tools: [] })),
      listProjects: vi.fn(async () => ({ projects: [PROJECT] })),
      getProject: vi.fn(async () => ({ project: PROJECT })),
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
      checklist: vi.fn(async () => ({
        items: [{ key: 'chapter:chapter', label: '章节 · 章节', ok: false, detail: '还没有卡片', stage: 'chapter' }],
        ready: false,
        missing: ['chapter:chapter'],
      })),
      publish: vi.fn(),
      scenarios: vi.fn(async () => ({ scenarios: [PACK], defaultId: 'novel' })),
      saveScenario: vi.fn(),
      deleteScenario: vi.fn(),
      entities: vi.fn(async () => ({ cards: [], counts: {} })),
      createEntity: vi.fn(),
      updateEntity: vi.fn(),
      deleteEntity: vi.fn(),
      manuscript: vi.fn(),
      exportManuscript: vi.fn(),
      projectGraph: vi.fn(),
      foreshadowHealth: vi.fn(),
      cardLinks: vi.fn(),
      linkCards: vi.fn(),
      unlinkCards: vi.fn(),
    },
    apiExtra: {
      ...actual.apiExtra,
      projectDetail: vi.fn(async () => ({
        project: PROJECT,
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

const mocked = vi.mocked(api, true);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('R1 a pack-declared generate stage has a real page', () => {
  it('renders the stage label and hint from the pack, not a placeholder', async () => {
    window.location.hash = '#/p/p1/stage/premise';
    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('设定');
    });
    expect(screen.getByText(/一句话卖点、题材、读者预期与差异化/)).toBeTruthy();
    expect(screen.queryByText('页面不存在')).toBeNull();
  });

  it('sends the pack prompt hint with the generation request', async () => {
    const user = userEvent.setup();
    window.location.hash = '#/p/p1/stage/premise';
    render(<App />);
    const box = await screen.findByPlaceholderText(/用一句话说清/);
    await user.type(box, '一个关于雾港的悬疑故事');
    await user.click(screen.getByRole('button', { name: '开始生成' }));
    await waitFor(() => expect(mocked.generate).toHaveBeenCalled());
    expect(mocked.generate.mock.calls[0]?.[1]).toBe('topic-card');
  });
});

describe('R2 the workspace rail routes by view', () => {
  it('opens the generic stage page for 设定 instead of the not-found route', async () => {
    const user = userEvent.setup();
    window.location.hash = '#/p/p1';
    render(<App />);
    await user.click(await screen.findByRole('button', { name: '设定' }));
    await waitFor(() => expect(window.location.hash).toBe('#/p/p1/stage/premise'));
  });

  it('sends the chapter stage to the writing desk', async () => {
    const user = userEvent.setup();
    window.location.hash = '#/p/p1';
    render(<App />);
    await user.click(await screen.findByRole('button', { name: '章节' }));
    await waitFor(() => expect(window.location.hash).toBe('#/p/p1/write/chapter'));
  });
});

describe('R3 the publish checklist links into the pack, not a fixed URL', () => {
  it('links a missing chapter to the writing desk', async () => {
    window.location.hash = '#/p/p1/publish';
    render(<App />);
    const link = await screen.findByRole('link', { name: '去补' });
    expect(link.getAttribute('href')).toBe('#/p/p1/write/chapter');
  });
});
