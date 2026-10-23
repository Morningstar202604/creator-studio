import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { api } from '../src/api';

vi.mock('../src/api', async () => {
  const actual = await vi.importActual<typeof import('../src/api')>('../src/api');
  return {
    ...actual,
    api: {
      health: vi.fn(async () => ({ ok: true, version: 1, workspaceRoot: 'C:/ws', os: 'win32', pid: 1 })),
      tools: vi.fn(async () => ({ tools: [] })),
      listProjects: vi.fn(async () => ({ projects: [] })),
      getProject: vi.fn(async () => ({
        project: {
          id: 'p1',
          ownerId: 'u1',
          title: '脚本项目',
          platform: 'bilibili',
          stage: 'script',
          workspacePath: null,
          styleProfileId: null,
          createdAt: '2026-10-21T10:00:00.000Z',
          updatedAt: '2026-10-21T10:00:00.000Z',
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
      streamUrl: vi.fn((id: string) => `/v1/runs/${id}/stream`),
      listArtifacts: vi.fn(async () => ({ artifacts: [] })),
      getArtifact: vi.fn(),
      saveArtifact: vi.fn(async () => ({ artifact: { id: 'a1', path: 'script/script.v1.md' } })),
      rewrite: vi.fn(),
    },
  };
});

const mocked = vi.mocked(api, true);

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = '#/p/p1/script';
});

describe('script page', () => {
  it('renders an empty editor with no versions', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('脚本');
    });
    expect(screen.getByText(/还没有保存过版本/)).toBeTruthy();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
  });

  it('saves the current text as a new version', async () => {
    const user = userEvent.setup();
    render(<App />);
    const textarea = await screen.findByRole('textbox');
    await user.type(textarea, '第一版正文');
    await user.click(screen.getByRole('button', { name: '保存为新版本' }));

    await waitFor(() => {
      expect(mocked.saveArtifact).toHaveBeenCalledWith('p1', {
        kind: 'script',
        path: 'script/script.v1.md',
        content: '第一版正文',
      });
    });
  });

  it('loads the latest version on mount', async () => {
    mocked.listArtifacts.mockResolvedValueOnce({
      artifacts: [
        {
          id: 'a1',
          projectId: 'p1',
          runId: null,
          kind: 'script',
          path: 'script/script.v1.md',
          sha256: 'a'.repeat(64),
          mime: 'text/markdown',
          size: 10,
          visibility: 'local',
          createdAt: '2026-10-21T10:00:00.000Z',
        },
      ],
    });
    mocked.getArtifact.mockResolvedValueOnce({
      artifact: {
        id: 'a1',
        projectId: 'p1',
        runId: null,
        kind: 'script',
        path: 'script/script.v1.md',
        sha256: 'a'.repeat(64),
        mime: 'text/markdown',
        size: 10,
        visibility: 'local',
        createdAt: '2026-10-21T10:00:00.000Z',
      },
      content: '已保存的正文',
    });

    render(<App />);
    await waitFor(() => {
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('已保存的正文');
    });
  });

  it('surfaces a rewrite failure and keeps the original text', async () => {
    mocked.rewrite.mockRejectedValueOnce(new Error('MODEL_AUTH: missing credential'));
    const user = userEvent.setup();
    render(<App />);

    const textarea = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
    await user.type(textarea, '原始正文');
    // jsdom does not emit `select` from userEvent, so fire it after setting a range.
    textarea.setSelectionRange(0, 4);
    fireEvent.select(textarea);
    await user.click(screen.getByRole('button', { name: '改写选中' }));

    await waitFor(() => {
      expect(screen.getByText(/MODEL_AUTH/)).toBeTruthy();
    });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('原始正文');
  });
});

describe('rewrite placement', () => {
  it('replaces at the selected offset, not the first textual match', async () => {
    mocked.listArtifacts.mockResolvedValueOnce({
      artifacts: [
        {
          id: 'a1',
          projectId: 'p1',
          runId: null,
          kind: 'script',
          path: 'script/script.v1.md',
          sha256: 'a'.repeat(64),
          mime: 'text/markdown',
          size: 20,
          visibility: 'local',
          createdAt: '2026-10-21T10:00:00.000Z',
        },
      ],
    });
    mocked.getArtifact.mockResolvedValueOnce({
      artifact: {
        id: 'a1',
        projectId: 'p1',
        runId: null,
        kind: 'script',
        path: 'script/script.v1.md',
        sha256: 'a'.repeat(64),
        mime: 'text/markdown',
        size: 20,
        visibility: 'local',
        createdAt: '2026-10-21T10:00:00.000Z',
      },
      content: '重复\n重复\n结尾',
    });
    mocked.rewrite.mockResolvedValueOnce({ rewritten: '改后', durationMs: 5 });

    const user = userEvent.setup();
    render(<App />);

    const textarea = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
    // Select the SECOND occurrence (offset 3..5) to prove position-based replacement.
    textarea.setSelectionRange(3, 5);
    fireEvent.select(textarea);
    await user.click(screen.getByRole('button', { name: '改写选中' }));

    const acceptAll = await screen.findByRole('button', { name: '全部接受' });
    await user.click(acceptAll);

    const value = (screen.getByRole('textbox') as HTMLTextAreaElement).value;
    expect(value).toBe('重复\n改后\n结尾');
  });
});

describe('import upstream into script', () => {
  const upstreamArtifacts = [
    {
      id: 'r1',
      projectId: 'p1',
      runId: null,
      kind: 'research-notes',
      path: 'research/research-notes.v1.md',
      sha256: 'b'.repeat(64),
      mime: 'text/markdown',
      size: 30,
      visibility: 'local',
      createdAt: '2026-10-21T10:01:00.000Z',
    },
    {
      id: 't1',
      projectId: 'p1',
      runId: null,
      kind: 'topic-card',
      path: 'topic/topic-card.v1.md',
      sha256: 'c'.repeat(64),
      mime: 'text/markdown',
      size: 30,
      visibility: 'local',
      createdAt: '2026-10-21T10:00:00.000Z',
    },
  ] as const;

  it('fills the empty editor with the latest topic and research artifacts', async () => {
    mocked.listArtifacts.mockResolvedValueOnce({
      artifacts: upstreamArtifacts.map((artifact) => ({ ...artifact })),
    });
    mocked.getArtifact.mockImplementation(async (artifactId: string) => ({
      artifact: {
        ...upstreamArtifacts.find((artifact) => artifact.id === artifactId)!,
      },
      content: artifactId === 't1' ? '选题一：AI 与就业' : '要点：数据来源 x',
    }));

    const user = userEvent.setup();
    render(<App />);

    const button = await screen.findByRole('button', { name: '带入选题与资料' });
    await user.click(button);

    await waitFor(() => {
      const value = (screen.getByRole('textbox') as HTMLTextAreaElement).value;
      expect(value).toContain('选题一：AI 与就业');
      expect(value).toContain('要点：数据来源 x');
    });

    const save = screen.getByRole('button', { name: '保存为新版本' });
    expect(save.hasAttribute('disabled')).toBe(false);
    await user.click(save);
    await waitFor(() => {
      expect(mocked.saveArtifact).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ kind: 'script', content: expect.stringContaining('选题一') }),
      );
    });
  });

  it('hides the import action once the editor has content', async () => {
    mocked.listArtifacts.mockResolvedValueOnce({
      artifacts: [
        {
          id: 'a1',
          projectId: 'p1',
          runId: null,
          kind: 'script',
          path: 'script/script.v1.md',
          sha256: 'a'.repeat(64),
          mime: 'text/markdown',
          size: 10,
          visibility: 'local',
          createdAt: '2026-10-21T10:02:00.000Z',
        },
        ...upstreamArtifacts.map((artifact) => ({ ...artifact })),
      ],
    });
    mocked.getArtifact.mockResolvedValueOnce({
      artifact: {
        id: 'a1',
        projectId: 'p1',
        runId: null,
        kind: 'script',
        path: 'script/script.v1.md',
        sha256: 'a'.repeat(64),
        mime: 'text/markdown',
        size: 10,
        visibility: 'local',
        createdAt: '2026-10-21T10:02:00.000Z',
      },
      content: '已有正文',
    });

    render(<App />);
    await waitFor(() => {
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('已有正文');
    });
    expect(screen.queryByRole('button', { name: '带入选题与资料' })).toBeNull();
  });

  it('hides the import action when no upstream artifacts exist', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/还没有保存过版本/)).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: '带入选题与资料' })).toBeNull();
  });
});
