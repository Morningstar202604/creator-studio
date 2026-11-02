import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { api } from '../src/api';

const NOVEL_PACK = {
  id: 'novel',
  name: '长篇小说',
  description: '',
  icon: '📖',
  builtin: true,
  defaultPlatform: 'generic' as const,
  stages: [
    { key: 'premise', label: '设定', view: 'generate' as const, hint: '', produces: ['topic-card'], promptHint: '', required: true },
    { key: 'world', label: '世界观', view: 'generate' as const, hint: '', produces: ['research-notes'], promptHint: '', required: true },
    { key: 'outline', label: '大纲', view: 'generate' as const, hint: '', produces: ['outline'], promptHint: '', required: true },
    { key: 'chapter', label: '章节', view: 'entities' as const, entityType: 'chapter', hint: '', produces: ['chapter'], promptHint: '', required: true },
    { key: 'revision', label: '修订', view: 'review' as const, hint: '', produces: ['review-report'], promptHint: '', required: false },
    { key: 'published', label: '投稿', view: 'publish' as const, hint: '', produces: ['publish-pack'], promptHint: '', required: false },
  ],
  entityTypes: [
    {
      key: 'character',
      label: '角色',
      labelPlural: '角色卡',
      hint: '每个重要角色一张卡',
      icon: '👤',
      titleField: 'name',
      summaryFields: ['role', 'status'],
      fields: [
        { key: 'name', label: '姓名', type: 'text' as const, required: true, options: [], placeholder: '', wide: false },
        { key: 'role', label: '叙事角色', type: 'select' as const, required: true, options: ['主角', '反派'], placeholder: '', wide: false },
        { key: 'goal', label: '想要什么', type: 'longtext' as const, required: true, options: [], placeholder: '', wide: true },
      ],
    },
    {
      key: 'chapter',
      label: '章节',
      labelPlural: '章节卡',
      hint: '一章一张卡',
      icon: '📄',
      titleField: 'title',
      summaryFields: ['status'],
      fields: [
        { key: 'title', label: '章节标题', type: 'text' as const, required: true, options: [], placeholder: '', wide: false },
        { key: 'status', label: '状态', type: 'select' as const, required: false, options: ['待写', '定稿'], placeholder: '', wide: false },
      ],
    },
  ],
};

const VIDEO_PACK = {
  id: 'video',
  name: '中长视频',
  description: '',
  icon: '🎬',
  builtin: true,
  defaultPlatform: 'bilibili' as const,
  stages: [
    { key: 'topic', label: '选题', view: 'generate' as const, hint: '', produces: ['topic-card'], promptHint: '', required: true },
    { key: 'published', label: '发布', view: 'publish' as const, hint: '', produces: [], promptHint: '', required: false },
  ],
  entityTypes: [],
};

const project = {
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
  createdAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:00:00.000Z',
  deletedAt: null,
};

const character = {
  id: 'c1',
  projectId: 'p1',
  type: 'character',
  title: '林砚',
  fields: { name: '林砚', role: '主角', goal: '查清父亲失踪' },
  body: '海港警局前法医。',
  tags: ['主角'],
  order: 0,
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
      listProjects: vi.fn(async () => ({ projects: [project] })),
      getProject: vi.fn(async () => ({ project })),
      createProject: vi.fn(async () => ({ project, scenario: NOVEL_PACK })),
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
      scenarios: vi.fn(async () => ({ scenarios: [VIDEO_PACK, NOVEL_PACK], defaultId: 'video' })),
      saveScenario: vi.fn(),
      deleteScenario: vi.fn(),
      entities: vi.fn(async () => ({ cards: [character], counts: { character: 1, chapter: 0 } })),
      createEntity: vi.fn(async () => ({ card: character })),
      updateEntity: vi.fn(async () => ({ card: character })),
      deleteEntity: vi.fn(async () => ({ deleted: 'c1' })),
    },
    apiExtra: {
      ...actual.apiExtra,
      projectDetail: vi.fn(async () => ({
        project,
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

describe('R1 the workspace rail follows the project scenario', () => {
  it('shows novel stages instead of video stages', async () => {
    window.location.hash = '#/p/p1';
    const { container } = render(<App />);

    await waitFor(() => {
      const labels = Array.from(container.querySelectorAll('.stage-list .stage-link')).map((node) => node.textContent);
      expect(labels).toEqual(['设定', '世界观', '大纲', '章节', '修订', '投稿']);
    });
    expect(container.textContent).not.toContain('分镜');
    // The pack name is surfaced next to the platform so the user knows the shape.
    expect(container.textContent).toContain('长篇小说');
  });
});

describe('R2 entity cards render from the pack schema', () => {
  it('lists cards and switches type tabs', async () => {
    window.location.hash = '#/p/p1/cards/character';
    const user = userEvent.setup();
    const { container } = render(<App />);

    await waitFor(() => {
      expect(container.querySelectorAll('.entity-card')).toHaveLength(1);
    });
    expect(container.textContent).toContain('林砚');
    expect(container.textContent).toContain('角色卡');

    await user.click(screen.getByRole('button', { name: /章节卡/ }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('章节卡');
    });
  });

  it('creates a card through the generated form fields', async () => {
    window.location.hash = '#/p/p1/cards/character';
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: /新建角色/ }));
    await user.type(screen.getByLabelText('姓名'), '周决');
    await user.selectOptions(screen.getByLabelText(/叙事角色/), '反派');
    await user.type(screen.getByLabelText(/想要什么/), '抢档案');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(mocked.createEntity).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({
          type: 'character',
          fields: expect.objectContaining({ name: '周决', role: '反派', goal: '抢档案' }),
        }),
      );
    });
  });
});

describe('R3 project creation offers scenarios', () => {
  it('creates a project with the chosen scenario id', async () => {
    window.location.hash = '#/';
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => expect(mocked.scenarios).toHaveBeenCalled());
    await user.selectOptions(await screen.findByLabelText('场景'), 'novel');
    await user.type(screen.getByPlaceholderText('新项目标题'), '新小说');
    await user.click(screen.getByRole('button', { name: '新建项目' }));

    await waitFor(() => {
      expect(mocked.createProject).toHaveBeenCalledWith('新小说', expect.any(String), 'novel');
    });
  });
});
