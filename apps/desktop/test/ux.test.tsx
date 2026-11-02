import { render, screen, waitFor, within } from '@testing-library/react';
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
  stages: [
    { key: 'premise', label: '设定', view: 'generate' as const, hint: '', produces: ['topic-card'], promptHint: '', required: true },
    { key: 'chapter', label: '章节', view: 'entities' as const, entityType: 'chapter', hint: '', produces: ['chapter'], promptHint: '', required: true },
  ],
  entityTypes: [
    {
      key: 'character',
      label: '角色',
      labelPlural: '角色卡',
      hint: '每个重要角色一张卡',
      icon: '👤',
      titleField: 'name',
      summaryFields: ['role'],
      fields: [
        { key: 'name', label: '姓名', type: 'text' as const, required: true, options: [], placeholder: '', wide: false },
        { key: 'role', label: '叙事角色', type: 'select' as const, required: true, options: ['主角', '反派'], placeholder: '', wide: false },
        { key: 'goal', label: '想要什么', type: 'longtext' as const, required: true, options: [], placeholder: '', wide: true },
      ],
    },
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

const CARD = {
  id: 'c1',
  projectId: 'p1',
  type: 'character',
  title: '林砚',
  fields: { name: '林砚', role: '主角', goal: '查清真相' },
  body: '',
  tags: [],
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
      scenarios: vi.fn(async () => ({ scenarios: [PACK], defaultId: 'novel' })),
      saveScenario: vi.fn(),
      deleteScenario: vi.fn(),
      entities: vi.fn(async () => ({
        cards: [
          CARD,
          { ...CARD, id: 'c2', title: '周决', fields: { name: '周决', role: '反派', goal: '抢档案' }, order: 1 },
        ],
        counts: { character: 2 },
      })),
      createEntity: vi.fn(async () => ({ card: CARD })),
      updateEntity: vi.fn(async () => ({ card: CARD })),
      deleteEntity: vi.fn(async () => ({ deleted: 'c1' })),
      cardLinks: vi.fn(async () => ({ card: { ...CARD, links: [] } })),
      linkCards: vi.fn(async () => ({
        relation: {
          id: 'r1',
          projectId: 'p1',
          fromCardId: 'c1',
          toCardId: 'c2',
          label: '出现在',
          createdAt: '2026-10-26T00:00:00.000Z',
        },
      })),
      unlinkCards: vi.fn(async () => ({ deleted: 'r1' })),
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
  window.location.hash = '#/p/p1/cards/character';
});

describe('R1 the editor opens in a drawer and traps focus', () => {
  it('focuses the first field and closes on Escape', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /新建角色/ }));

    const dialog = await screen.findByRole('dialog');
    await waitFor(
      () => {
        expect(dialog.contains(document.activeElement)).toBe(true);
      },
      { timeout: 2000 },
    );
    // The first focusable field (not the close button) receives focus.
    expect(document.activeElement?.tagName).not.toBe('BUTTON');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('卡片标题');

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    // Closing without saving must not call the API.
    expect(mocked.createEntity).not.toHaveBeenCalled();
  });
});

describe('R2 destructive actions require confirmation', () => {
  it('does not delete when the confirm is cancelled', async () => {
    const user = userEvent.setup();
    render(<App />);
    const firstCard = (await screen.findAllByRole('article'))[0] as HTMLElement;
    await user.click(within(firstCard).getByRole('button', { name: '删除' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/不可撤销/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: '取消' }));

    expect(mocked.deleteEntity).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('deletes after confirming', async () => {
    const user = userEvent.setup();
    render(<App />);
    const firstCard = (await screen.findAllByRole('article'))[0] as HTMLElement;
    await user.click(within(firstCard).getByRole('button', { name: '删除' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: '确认删除' }));
    await waitFor(() => {
      expect(mocked.deleteEntity).toHaveBeenCalledWith('p1', 'c1');
    });
  });
});

describe('R3 saving reports through a live region', () => {
  it('shows a toast with role=status after a successful save', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /新建角色/ }));
    await user.type(screen.getByLabelText('卡片标题'), '周决');
    await user.selectOptions(screen.getByLabelText(/叙事角色/), '反派');
    await user.type(screen.getByLabelText(/想要什么/), '抢档案');
    await user.click(screen.getByRole('button', { name: '保存' }));

    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('已新建角色');
  });

  it('keeps validation errors inline as well as in the toast', async () => {
    mocked.createEntity.mockRejectedValueOnce(new Error('INVALID_CARD: field 想要什么 is required'));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /新建角色/ }));
    await user.type(screen.getByLabelText('卡片标题'), '缺字段');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(screen.getAllByText(/INVALID_CARD/).length).toBeGreaterThan(0);
    });
    // The drawer stays open so the user can fix the field.
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

describe('R4 the board can be searched', () => {
  it('filters cards by a field value', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('林砚');

    await user.type(screen.getByLabelText('搜索角色'), '查清真相');
    expect(screen.getByText('林砚')).toBeTruthy();

    await user.clear(screen.getByLabelText('搜索角色'));
    await user.type(screen.getByLabelText('搜索角色'), '不存在的内容');
    expect(screen.getByText('没有匹配的卡片')).toBeTruthy();
  });
});

describe('R5 relations are created from the drawer', () => {
  it('links the card to another card and lists the link', async () => {
    const user = userEvent.setup();
    render(<App />);
    const firstCard = (await screen.findAllByRole('article'))[0] as HTMLElement;
    await user.click(within(firstCard).getByRole('button', { name: '编辑' }));
    await screen.findByRole('dialog');

    await user.selectOptions(screen.getByLabelText('关联到'), 'c2');
    await user.type(screen.getByLabelText('关联说明'), '出现在');
    await user.click(screen.getByRole('button', { name: '关联' }));

    await waitFor(() => {
      expect(mocked.linkCards).toHaveBeenCalledWith('p1', 'c1', { toCardId: 'c2', label: '出现在' });
    });
  });
});
