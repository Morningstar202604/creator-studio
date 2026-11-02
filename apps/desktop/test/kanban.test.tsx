import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { api } from '../src/api';

const PACK = {
  id: 'novel', name: '长篇小说', description: '', icon: '📖', builtin: true,
  defaultPlatform: 'generic' as const, formatVersion: 2, requiresViews: ['document'],
  stages: [
    { key: 'chapter', label: '章节', view: 'document' as const, entityType: 'chapter',
      board: { groupBy: 'status', order: ['待写', '定稿'] },
      document: { orderField: 'number' }, hint: '', produces: ['chapter'], promptHint: '', required: true },
    { key: 'published', label: '投稿', view: 'publish' as const, hint: '', produces: [], promptHint: '', required: false },
  ],
  entityTypes: [
    { key: 'chapter', label: '章节', labelPlural: '章节卡', hint: '', icon: '📄', titleField: 'title', summaryFields: ['status'],
      fields: [
        { key: 'title', label: '章节标题', type: 'text' as const, required: true, options: [], placeholder: '', wide: false },
        { key: 'number', label: '章节序号', type: 'number' as const, required: false, options: [], placeholder: '', wide: false },
        { key: 'status', label: '状态', type: 'select' as const, required: false, options: ['待写', '定稿'], placeholder: '', wide: false },
      ] },
  ],
  relationTypes: [],
};

const PROJECT = { id: 'p1', ownerId: 'u1', title: '雾港纪事', platform: 'generic' as const, stage: 'chapter', scenarioId: 'novel', workspacePath: null, styleProfileId: null, description: '', tags: [], createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z', deletedAt: null };

const card = (id: string, title: string, status: string) => ({
  id, projectId: 'p1', type: 'chapter', title,
  fields: { title, number: '1', status }, body: '', tags: [], order: 0,
  createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z',
});

vi.mock('../src/api', async () => {
  const actual = await vi.importActual<typeof import('../src/api')>('../src/api');
  return { ...actual, api: {
    health: vi.fn(async () => ({ ok: true, version: 1, workspaceRoot: 'C:/ws', os: 'win32', pid: 1 })),
    tools: vi.fn(async () => ({ tools: [] })), listProjects: vi.fn(async () => ({ projects: [PROJECT] })),
    getProject: vi.fn(async () => ({ project: PROJECT })), createProject: vi.fn(), advanceStage: vi.fn(),
    createRun: vi.fn(), executeRun: vi.fn(), listRuns: vi.fn(async () => ({ runs: [] })), getRun: vi.fn(), runEvents: vi.fn(),
    listApprovals: vi.fn(async () => ({ approvals: [] })), decideApproval: vi.fn(), audit: vi.fn(async () => ({ records: [] })),
    streamUrl: vi.fn(), listArtifacts: vi.fn(async () => ({ artifacts: [] })), getArtifact: vi.fn(), saveArtifact: vi.fn(),
    rewrite: vi.fn(), generate: vi.fn(), checklist: vi.fn(async () => ({ items: [], ready: false, missing: [] })), publish: vi.fn(),
    scenarios: vi.fn(async () => ({ scenarios: [PACK], defaultId: 'novel' })), saveScenario: vi.fn(), deleteScenario: vi.fn(),
    entities: vi.fn(async () => ({ cards: [card('c1', '第一章', '待写'), card('c2', '第二章', '定稿')], counts: { chapter: 2 } })),
    createEntity: vi.fn(), updateEntity: vi.fn(async (_p: string, id: string) => ({ card: card(id, '第一章', '定稿') })),
    deleteEntity: vi.fn(), manuscript: vi.fn(), exportManuscript: vi.fn(),
    projectGraph: vi.fn(), foreshadowHealth: vi.fn(), cardLinks: vi.fn(), linkCards: vi.fn(), unlinkCards: vi.fn(),
  }, apiExtra: { ...actual.apiExtra, projectDetail: vi.fn(async () => ({ project: PROJECT, stats: { artifacts: 0, runs: 0, tokens: 0, costCny: 0 }, checklist: [] })), usage: vi.fn(async () => ({ totals: { runs: 0, tokens: 0, cost: 0 }, budget: { monthlyCostCny: 50, perProjectCostCny: 5, warnAtPercent: 80 }, byAgent: [] })) } };
});

beforeEach(() => { vi.clearAllMocks(); window.location.hash = '#/p/p1/cards/chapter?board=1'; });

describe('board drag', () => {
  it('renders columns and drag handles', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText('待写')).toBeTruthy());
    expect(screen.getByLabelText('定稿')).toBeTruthy();
    expect(screen.getByRole('button', { name: '拖动 第一章' })).toBeTruthy();
  });
});
