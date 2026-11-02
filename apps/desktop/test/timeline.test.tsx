import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { loadStylesWithCleanup } from '../src/pages/WorkspacePage';
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
    { key: 'chapter', label: '章节', view: 'board' as const, entityType: 'chapter', board: { groupBy: 'status', order: [] }, hint: '', produces: ['chapter'], promptHint: '', required: true },
    { key: 'published', label: '投稿', view: 'publish' as const, hint: '', produces: [], promptHint: '', required: false },
  ],
  entityTypes: [
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
        { key: 'number', label: '章节序号', type: 'number' as const, required: false, options: [], placeholder: '', wide: false },
        { key: 'status', label: '状态', type: 'select' as const, required: false, options: ['待写', '定稿'], placeholder: '', wide: false },
      ],
    },
    {
      key: 'foreshadow',
      label: '伏笔',
      labelPlural: '伏笔表',
      hint: '',
      icon: '🧵',
      titleField: 'clue',
      summaryFields: ['status'],
      fields: [
        { key: 'clue', label: '线索', type: 'text' as const, required: true, options: [], placeholder: '', wide: false },
        { key: 'planted_at', label: '埋设章节', type: 'text' as const, required: true, options: [], placeholder: '', wide: false },
        { key: 'status', label: '状态', type: 'select' as const, required: false, options: ['已埋', '已回收'], placeholder: '', wide: false },
      ],
    },
  ],
  relationTypes: [
    { key: 'plants', label: '埋于', inverse: '埋有伏笔', fromTypes: ['foreshadow'], toTypes: ['chapter'] },
    { key: 'pays-off', label: '回收于', inverse: '回收伏笔', fromTypes: ['foreshadow'], toTypes: ['chapter'] },
  ],
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

const chapterCard = (id: string, title: string, number: string) => ({
  id,
  projectId: 'p1',
  type: 'chapter',
  title,
  fields: { title, number, status: '定稿' },
  body: '',
  tags: [],
  order: 0,
  createdAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:00:00.000Z',
});

const FORESHADOW = {
  id: 'f1',
  projectId: 'p1',
  type: 'foreshadow',
  title: '父亲留下的海图',
  fields: { clue: '父亲留下的海图', planted_at: '第 1 章', status: '已埋' },
  body: '',
  tags: [],
  order: 0,
  createdAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:00:00.000Z',
};

const GRAPH = {
  nodes: [chapterCard('c1', '第一章', '1'), chapterCard('c2', '第二章', '2'), FORESHADOW],
  edges: [
    { id: 'e1', from: 'f1', to: 'c1', label: '埋于', relationType: 'plants' },
    { id: 'e2', from: 'f1', to: 'c2', label: '回收于', relationType: 'pays-off' },
  ],
  entityTypes: PACK.entityTypes,
  relationTypes: PACK.relationTypes,
};

const HEALTH = {
  total: 3,
  open: 2,
  paidOff: 1,
  relationTypes: PACK.relationTypes,
  items: [
    {
      cardId: 'f1',
      title: '父亲留下的海图',
      status: '已埋',
      plantedAt: '第 1 章',
      plantedChapter: 1,
      lastChapter: null,
      gapChapters: null,
      note: '还没有回收',
    },
    {
      cardId: 'f2',
      title: '赵队的旧案卷',
      status: '已埋',
      plantedAt: '第 6 章',
      plantedChapter: 6,
      lastChapter: 8,
      gapChapters: 2,
      note: '埋了 2 章才回收，读者可能已经忘了',
    },
  ],
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
      entities: vi.fn(async () => ({ cards: [], counts: {} })),
      createEntity: vi.fn(),
      updateEntity: vi.fn(),
      deleteEntity: vi.fn(),
      projectGraph: vi.fn(async () => GRAPH),
      foreshadowHealth: vi.fn(async () => HEALTH),
      cardLinks: vi.fn(),
      linkCards: vi.fn(),
      unlinkCards: vi.fn(),
    },
    apiExtra: {
      ...actual.apiExtra,
      styles: vi.fn(async () => ({ styles: [] })),
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
  window.location.hash = '#/p/p1/timeline';
});

describe('R1 the timeline reports chapter and foreshadow counts', () => {
  it('summarises chapters, threads and open threads', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('叙事时间轴');
    });
    await waitFor(() => expect(screen.getByText(/2 章 · 3 条伏笔，2 条未回收/)).toBeTruthy());
    expect(mocked.foreshadowHealth).toHaveBeenCalledWith('p1');
  });
});

describe('R2 open threads are listed with a reason', () => {
  it('shows each unclosed thread and why it needs attention', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('父亲留下的海图')).toBeTruthy());
    expect(screen.getByText('赵队的旧案卷')).toBeTruthy();
    expect(screen.getByText('还没有回收')).toBeTruthy();
    expect(screen.getByText(/埋了 2 章才回收/)).toBeTruthy();
  });
});

describe('R3 chapters can be jumped to from the scrub row', () => {
  it('renders one scrub control per chapter', async () => {
    render(<App />);
    await waitFor(() => {
      expect(document.querySelectorAll('.scrub-dot')).toHaveLength(2);
    });
  });
});

describe('R4 the timeline is reachable from the workspace', () => {
  it('offers a timeline button on a card-based project', async () => {
    window.location.hash = '#/p/p1';
    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '时间轴' })).toBeTruthy();
    });
  });
});

describe('R5 optional style loading follows component lifetime', () => {
  it('does not update styles after the owner disposes a successful request', async () => {
    let resolveStyles: ((value: { styles: [] }) => void) | undefined;
    const setStyles = vi.fn();
    const dispose = loadStylesWithCleanup(
      () =>
        new Promise<{ styles: [] }>((resolve) => {
          resolveStyles = resolve;
        }),
      setStyles,
    );
    dispose();
    resolveStyles?.({ styles: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setStyles).not.toHaveBeenCalled();
  });

  it('does not update styles after the owner disposes a failed request', async () => {
    let rejectStyles: ((cause: Error) => void) | undefined;
    const setStyles = vi.fn();
    const dispose = loadStylesWithCleanup(
      () =>
        new Promise<{ styles: [] }>((_, reject) => {
          rejectStyles = reject;
        }),
      setStyles,
    );
    dispose();
    rejectStyles?.(new Error('late styles failure'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setStyles).not.toHaveBeenCalled();
  });

  it('aborts the pending styles request when the owner disposes it', () => {
    let requestSignal: AbortSignal | undefined;
    const setStyles = vi.fn();
    const dispose = loadStylesWithCleanup(
      async (signal) => {
        requestSignal = signal;
        return new Promise<{ styles: [] }>((resolve) => {
          signal?.addEventListener('abort', () => resolve({ styles: [] }), { once: true });
        });
      },
      setStyles,
    );
    expect(requestSignal).toBeDefined();
    dispose();
    expect(requestSignal?.aborted).toBe(true);
    expect(setStyles).not.toHaveBeenCalled();
  });

  it('keeps the active error fallback for a real styles failure', async () => {
    const setStyles = vi.fn();
    loadStylesWithCleanup(async () => {
      throw new Error('styles unavailable');
    }, setStyles);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setStyles).toHaveBeenCalledWith([]);
  });
});
