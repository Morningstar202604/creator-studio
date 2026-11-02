import { render, screen, waitFor } from '@testing-library/react';
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
  requiresViews: ['generate', 'board'],
  stages: [
    { key: 'premise', label: '设定', view: 'generate' as const, hint: '', produces: ['topic-card'], promptHint: '', required: true },
    { key: 'chapter', label: '章节', view: 'board' as const, entityType: 'chapter', board: { groupBy: 'status', order: [] }, hint: '', produces: ['chapter'], promptHint: '', required: true },
  ],
  entityTypes: [
    {
      key: 'character',
      label: '角色',
      labelPlural: '角色卡',
      hint: '',
      icon: '👤',
      titleField: 'name',
      summaryFields: ['role'],
      fields: [
        { key: 'name', label: '姓名', type: 'text' as const, required: true, options: [], placeholder: '', wide: false },
        { key: 'role', label: '叙事角色', type: 'select' as const, required: false, options: ['主角'], placeholder: '', wide: false },
      ],
    },
    {
      key: 'chapter',
      label: '章节',
      labelPlural: '章节卡',
      hint: '',
      icon: '📄',
      titleField: 'title',
      summaryFields: ['status'],
      fields: [
        { key: 'title', label: '章节标题', type: 'text' as const, required: true, options: [], placeholder: '', wide: false },
        { key: 'status', label: '状态', type: 'select' as const, required: false, options: ['待写', '定稿'], placeholder: '', wide: false },
      ],
    },
  ],
  relationTypes: [{ key: 'appears-in', label: '出现在', inverse: '出场于', fromTypes: ['character'], toTypes: ['chapter'] }],
};

const PROJECT = {
  id: 'p1',
  ownerId: 'u1',
  title: '雾港纪事',
  platform: 'generic' as const,
  stage: 'chapter',
  scenarioId: 'novel',
  workspacePath: null,
  styleProfileId: null,
  description: '',
  tags: [],
  createdAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:00:00.000Z',
  deletedAt: null,
};

const card = (id: string, type: string, title: string, fields: Record<string, string>) => ({
  id,
  projectId: 'p1',
  type,
  title,
  fields,
  body: '',
  tags: [],
  order: 0,
  createdAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:00:00.000Z',
});

const GRAPH = {
  nodes: [
    card('c1', 'character', '林砚', { name: '林砚', role: '主角' }),
    card('c2', 'chapter', '第一章', { title: '第一章', status: '定稿' }),
    card('c3', 'chapter', '第二章', { title: '第二章', status: '待写' }),
  ],
  edges: [
    { id: 'r1', from: 'c1', to: 'c2', label: '出现在', relationType: 'appears-in' },
    { id: 'r2', from: 'c1', to: 'c3', label: '出现在', relationType: 'appears-in' },
  ],
  entityTypes: PACK.entityTypes,
  relationTypes: PACK.relationTypes,
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
      checklist: vi.fn(async () => ({ items: [], ready: false, missing: [] })),
      publish: vi.fn(),
      scenarios: vi.fn(async () => ({ scenarios: [PACK], defaultId: 'novel', engine: { packFormat: 2, views: [] } })),
      saveScenario: vi.fn(),
      deleteScenario: vi.fn(),
      entities: vi.fn(async () => ({ cards: GRAPH.nodes, counts: { character: 1, chapter: 2 } })),
      createEntity: vi.fn(),
      updateEntity: vi.fn(),
      deleteEntity: vi.fn(),
      projectGraph: vi.fn(async () => GRAPH),
      cardLinks: vi.fn(async () => ({ card: { ...GRAPH.nodes[0], links: [] } })),
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

// jsdom has no canvas implementation; Cytoscape needs one. The assertions here are
// about data wiring and filtering, not pixels, so the renderer is stubbed.
vi.mock('cytoscape', () => {
  const fake = () => ({
    destroy: () => undefined,
    on: () => undefined,
    nodes: () => ({ map: () => [] }),
    elements: () => ({
      addClass: () => undefined,
      removeClass: () => undefined,
    }),
    resize: () => undefined,
    fit: () => undefined,
  });
  return { default: fake };
});

const mocked = vi.mocked(api, true);

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = '#/p/p1/graph';
});

describe('R1 the graph page loads the project graph', () => {
  it('shows node and edge counts and the legend', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('关系图');
    });
    await waitFor(() => expect(screen.getByText(/3 张卡 · 2 条关系/)).toBeTruthy());
    expect(screen.getByText('角色')).toBeTruthy();
    expect(screen.getByText('章节')).toBeTruthy();
  });

  it('lists declared relation types with their inverse', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('出现在')).toBeTruthy());
    expect(screen.getByText(/出场于/)).toBeTruthy();
  });
});

describe('R2 filtering and orphans', () => {
  it('hides a type from the canvas when toggled off', async () => {
    const { container } = render(<App />);
    await waitFor(() => expect(screen.getByText(/3 张卡/)).toBeTruthy());
    // The canvas itself is a cytoscape instance; assert the API contract instead of
    // pixels: toggling calls the type filter and the subtitle shrinks.
    const chapterButton = screen.getAllByRole('button').find((button) => button.textContent?.includes('章节'));
    expect(chapterButton).toBeTruthy();
    chapterButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitFor(() => {
      expect(container.textContent).toContain('1 张卡');
    });
  });
});

describe('R3 the graph is reachable from the workspace', () => {
  it('offers a relation-graph button on a card-based project', async () => {
    window.location.hash = '#/p/p1';
    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '关系图' })).toBeTruthy();
    });
  });
});

describe('R4 isolated cards are opt-in', () => {
  it('hides unconnected cards by default and can show them', async () => {
    mocked.projectGraph.mockResolvedValueOnce({
      ...GRAPH,
      nodes: [...GRAPH.nodes, card('c9', 'character', '孤零零', { name: '孤零零', role: '主角' })],
    });
    const { container } = render(<App />);
    await waitFor(() => expect(container.textContent).toContain('张孤立卡（已隐藏）'));
    const toggle = screen.getByRole('button', { name: /显示孤立卡/ });
    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitFor(() => expect(container.textContent).not.toContain('（已隐藏）'));
  });
});
