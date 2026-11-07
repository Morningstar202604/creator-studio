import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { ApiError, api } from '../src/api';
import { countWords } from '../src/pages/DocumentPage';

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
      hint: '',
      produces: ['topic-card'],
      promptHint: '',
      required: true,
    },
    {
      key: 'chapter',
      label: '章节',
      view: 'document' as const,
      entityType: 'chapter',
      document: { orderField: 'number', fileStem: 'novel' },
      hint: '',
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
      summaryFields: ['status'],
      fields: [
        { key: 'title', label: '章节标题', type: 'text' as const, required: true, options: [], placeholder: '', wide: false },
        { key: 'number', label: '章节序号', type: 'number' as const, required: false, options: [], placeholder: '', wide: false },
        { key: 'status', label: '状态', type: 'select' as const, required: false, options: ['待写', '定稿'], placeholder: '', wide: false },
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

const chapter = (id: string, title: string, number: string, body: string) => ({
  id,
  projectId: 'p1',
  type: 'chapter',
  title,
  fields: { title, number, status: '草稿' },
  body,
  tags: [],
  order: Number.parseInt(number, 10),
  revision: 1,
  createdAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:00:00.000Z',
});

const C1 = chapter('c1', '第一章 雾从海上来', '1', '海雾压着航道。');
const C2 = chapter('c2', '第二章 潮汐表', '2', '');

const DOCUMENT = { stage: 'chapter', label: '章节', orderField: 'number', fileStem: 'novel' };

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
        cards: [C1, C2],
        counts: { chapter: 2 },
        document: DOCUMENT,
      })),
      createEntity: vi.fn(async () => ({ card: chapter('c3', '第三章', '3', '') })),
      updateEntity: vi.fn(async (_projectId: string, cardId: string) => ({
        card: chapter(cardId, '第一章 雾从海上来', '1', '海雾压着航道。改'),
      })),
      cardRevisions: vi.fn(async () => ({ current: 1, revisions: [] })),
      restoreCardRevision: vi.fn(),
      deleteEntity: vi.fn(),
      manuscript: vi.fn(),
      exportManuscript: vi.fn(async () => ({
        file: 'manuscript/novel.docx',
        markdownFile: 'manuscript/novel.md',
        bytes: 9000,
        chapters: 2,
        chars: 120,
        downloadUrl: '/v1/projects/p1/manuscript/download/novel.docx',
      })),
      manuscriptDownloadUrl: vi.fn((projectId: string, name: string) => `/v1/projects/${projectId}/manuscript/download/${name}`),
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
  window.location.hash = '#/p/p1/write/chapter';
});

describe('R1 the desk lists chapters with their declared order', () => {
  it('renders the chapter rail and the total word count', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('写作台');
    });
    // The rail item and the length bar both point at the chapter, so the rail is
    // selected by class rather than by accessible name alone.
    await waitFor(() => expect(document.querySelectorAll('.desk-item')).toHaveLength(2));
    expect(document.querySelector('.desk-item')?.textContent).toContain('第一章 雾从海上来');
    expect(screen.getByText(/全书 .* 字/)).toBeTruthy();
  });
});

describe('R2 the editor autosaves the card body', () => {
  it('PATCHes the card after typing and reports 已保存', async () => {
    const user = userEvent.setup();
    render(<App />);
    const editor = await screen.findByLabelText('第一章 雾从海上来 正文');
    await user.click(editor);
    await user.type(editor, '再见');
    await waitFor(() => expect(mocked.updateEntity).toHaveBeenCalled(), { timeout: 4000 });
    const [projectId, cardId, patch] = mocked.updateEntity.mock.calls[0] as unknown as [
      string,
      string,
      { body?: string },
    ];
    expect(projectId).toBe('p1');
    expect(cardId).toBe('c1');
    // The novel pack keeps prose in the card body, so the autosave must send the
    // whole body rather than a field patch.
    expect(patch.body).toContain('海雾压着航道。');
    await waitFor(() => expect(screen.getByText('已保存')).toBeTruthy());
  });
});

describe('R3 switching chapters does not write into the new card', () => {
  it('keeps the edited text on the chapter it belongs to', async () => {
    const user = userEvent.setup();
    render(<App />);
    const editor = await screen.findByLabelText('第一章 雾从海上来 正文');
    await user.click(editor);
    await user.type(editor, '新');
    const railItems = Array.from(document.querySelectorAll<HTMLButtonElement>('.desk-item'));
    await user.click(railItems[1] as HTMLButtonElement);
    await waitFor(() => expect(screen.getByLabelText('第二章 潮汐表 正文')).toHaveProperty('value', ''));
    const calls = mocked.updateEntity.mock.calls as unknown as Array<[string, string, unknown]>;
    for (const call of calls) expect(call[1]).toBe('c1');
  });
});

describe('R4 export asks the daemon for a Word file', () => {
  it('calls the export endpoint and reports the result', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByLabelText('第一章 雾从海上来 正文');
    await user.click(screen.getByRole('button', { name: '导出 Word' }));
    await waitFor(() => expect(mocked.exportManuscript).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(screen.getByText(/已导出 Word：2 章/)).toBeTruthy());
  });
});

describe('word counting', () => {
  it('counts CJK characters and Latin words separately', () => {
    expect(countWords('雾从海上来')).toBe(5);
    expect(countWords('hello world')).toBe(2);
    expect(countWords('第1章 hello 世界')).toBe(6);
  });
});

describe('R5 the desk visualises progress', () => {
  it('shows a per-chapter ring and a book-length strip', async () => {
    render(<App />);
    await screen.findByLabelText('第一章 雾从海上来 正文');
    // Ring only appears when the card declares a target; the fixture sets none.
    expect(document.querySelector('.ring')).toBeNull();
    expect(document.querySelectorAll('.book-bar')).toHaveLength(2);
    // The status dot comes from the pack's select field, not a hardcoded list.
    expect(document.querySelectorAll('.status-dot').length).toBe(2);
  });
});

describe('R6 creating a chapter fills the pack title field', () => {
  it('sends the entity type title field as well as the number', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByLabelText('第一章 雾从海上来 正文');
    await user.click(screen.getByRole('button', { name: '新建' }));
    await waitFor(() => expect(mocked.createEntity).toHaveBeenCalled());
    const [, payload] = mocked.createEntity.mock.calls[0] as unknown as [
      string,
      { type: string; title: string; fields: Record<string, string> },
    ];
    expect(payload.type).toBe('chapter');
    // `chapter.title` is required by the pack; sending only `number` returned 400.
    expect(payload.fields['title']).toBe(payload.title);
    expect(payload.fields['number']).toBeDefined();
  });
});

describe('R7 autosave is conditional on the revision it read', () => {
  it('sends expectedRevision so a concurrent write is detected', async () => {
    const user = userEvent.setup();
    render(<App />);
    const editor = await screen.findByLabelText('第一章 雾从海上来 正文');
    await user.click(editor);
    await user.type(editor, '！');
    await waitFor(() => expect(mocked.updateEntity).toHaveBeenCalled(), { timeout: 4000 });
    const [, , patch] = mocked.updateEntity.mock.calls[0] as unknown as [string, string, { expectedRevision?: number }];
    expect(patch.expectedRevision).toBe(1);
  });

  it('shows a merge panel instead of losing text when the daemon answers 409', async () => {
    const user = userEvent.setup();
    mocked.updateEntity.mockRejectedValueOnce(
      new ApiError('CARD_STALE', 'card changed', 409, {
        error: { code: 'CARD_STALE' },
        card: chapter('c1', '第一章 雾从海上来', '1', '对方写的句子。'),
      }),
    );
    render(<App />);
    const editor = await screen.findByLabelText('第一章 雾从海上来 正文') as HTMLTextAreaElement;
    await user.click(editor);
    await user.type(editor, '我的句子。');
    await waitFor(() => expect(screen.getByText('这一章在别处被改过了')).toBeTruthy(), { timeout: 4000 });
    // Both sides are on screen, and the editor was not silently overwritten.
    expect(screen.getByText('对方写的句子。')).toBeTruthy();
    expect(editor.value).toContain('我的句子。');
    expect(screen.getByRole('button', { name: '保留我的' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '采用对方的' })).toBeTruthy();
  });

  it('keeps both sides when the writer asks for it', async () => {
    const user = userEvent.setup();
    mocked.updateEntity.mockRejectedValueOnce(
      new ApiError('CARD_STALE', 'card changed', 409, {
        error: { code: 'CARD_STALE' },
        card: chapter('c1', '第一章 雾从海上来', '1', '对方写的句子。'),
      }),
    );
    render(<App />);
    const editor = await screen.findByLabelText('第一章 雾从海上来 正文');
    await user.click(editor);
    await user.type(editor, '我的句子。');
    await waitFor(() => expect(screen.getByText('这一章在别处被改过了')).toBeTruthy(), { timeout: 4000 });

    mocked.updateEntity.mockResolvedValueOnce({
      card: chapter('c1', '第一章 雾从海上来', '1', '合并后的正文'),
    } as never);
    await user.click(screen.getByRole('button', { name: '两边都留' }));
    await waitFor(() => expect(mocked.updateEntity).toHaveBeenLastCalledWith(
      'p1',
      'c1',
      expect.objectContaining({ reason: 'conflict', expectedRevision: 1 }),
    ));
    await waitFor(() => expect(screen.queryByText('这一章在别处被改过了')).toBeNull());
  });
});

describe('R8 version history', () => {
  it('lists stored revisions and restores one', async () => {
    const user = userEvent.setup();
    mocked.cardRevisions.mockResolvedValueOnce({
      current: 3,
      revisions: [
        {
          id: 'r2',
          entityId: 'c1',
          projectId: 'p1',
          revision: 2,
          title: '第一章 雾从海上来',
          fields: { title: '第一章 雾从海上来', number: '1', status: '草稿' },
          body: '第二版正文。',
          tags: [],
          reason: 'save' as const,
          createdAt: '2026-10-26T00:00:00.000Z',
        },
      ],
    });
    mocked.restoreCardRevision.mockResolvedValueOnce({
      card: chapter('c1', '第一章 雾从海上来', '1', '第二版正文。'),
      restoredFrom: 2,
    });
    render(<App />);
    await screen.findByLabelText('第一章 雾从海上来 正文');
    await user.click(screen.getByRole('button', { name: '版本历史' }));
    await waitFor(() => expect(screen.getByText('第 2 版')).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '恢复到这一版' }));
    await waitFor(() => expect(mocked.restoreCardRevision).toHaveBeenCalledWith('p1', 'c1', 2));
    await waitFor(() =>
      expect((screen.getByLabelText('第一章 雾从海上来 正文') as HTMLTextAreaElement).value).toBe('第二版正文。'),
    );
  });
});
