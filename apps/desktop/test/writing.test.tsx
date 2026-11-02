import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { api } from '../src/api';
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
