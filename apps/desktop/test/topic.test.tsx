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
          title: '选题项目',
          platform: 'bilibili',
          stage: 'topic',
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
      saveArtifact: vi.fn(),
      rewrite: vi.fn(),
      generate: vi.fn(async () => ({
        artifact: {
          id: 'a1',
          projectId: 'p1',
          runId: null,
          kind: 'topic-card',
          path: 'topic/topic-card.v1.md',
          sha256: 'a'.repeat(64),
          mime: 'text/markdown',
          size: 100,
          visibility: 'local' as const,
          createdAt: '2026-10-21T10:00:00.000Z',
        },
        payload: {},
      })),
    },
  };
});

const mocked = vi.mocked(api, true);

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = '#/p/p1/topic';
});

describe('R5 topic page uses real data', () => {
  it('shows an empty state with no hardcoded sample cards', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('选题');
    });
    expect(screen.getByText(/还没有生成过/)).toBeTruthy();
    expect(screen.queryByText(/AI 正在杀死初级岗位吗/)).toBeNull();
  });

  it('calls generate with the typed context and renders the result', async () => {
    mocked.getArtifact.mockResolvedValueOnce({
      artifact: {
        id: 'a1',
        projectId: 'p1',
        runId: null,
        kind: 'topic-card',
        path: 'topic/topic-card.v1.md',
        sha256: 'a'.repeat(64),
        mime: 'text/markdown',
        size: 100,
        visibility: 'local',
        createdAt: '2026-10-21T10:00:00.000Z',
      },
      content: '## 1. 真实选题标题\n\n- 综合分：76',
    });

    const user = userEvent.setup();
    render(<App />);

    await user.type(await screen.findByPlaceholderText(/AI 对初级程序员的影响/), 'AI 与就业');
    await user.click(screen.getByRole('button', { name: '开始生成' }));

    await waitFor(() => {
      expect(mocked.generate).toHaveBeenCalledWith('p1', 'topic-card', 'AI 与就业');
    });
    await waitFor(() => {
      expect(screen.getByText(/真实选题标题/)).toBeTruthy();
    });
  });

  it('surfaces a MODEL_BAD_OUTPUT error without rendering content', async () => {
    mocked.generate.mockRejectedValueOnce(new Error('MODEL_BAD_OUTPUT: cards.0.scores missing'));
    const user = userEvent.setup();
    render(<App />);

    await user.type(await screen.findByPlaceholderText(/AI 对初级程序员的影响/), 'x');
    await user.click(screen.getByRole('button', { name: '开始生成' }));

    await waitFor(() => {
      expect(screen.getByText(/MODEL_BAD_OUTPUT/)).toBeTruthy();
    });
  });

  it('lists existing versions on mount', async () => {
    mocked.listArtifacts.mockResolvedValueOnce({
      artifacts: [
        {
          id: 'a1',
          projectId: 'p1',
          runId: null,
          kind: 'topic-card',
          path: 'topic/topic-card.v1.md',
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
        kind: 'topic-card',
        path: 'topic/topic-card.v1.md',
        sha256: 'a'.repeat(64),
        mime: 'text/markdown',
        size: 10,
        visibility: 'local',
        createdAt: '2026-10-21T10:00:00.000Z',
      },
      content: '历史内容',
    });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/历史内容/)).toBeTruthy();
    });
    expect(screen.getByText('topic-card.v1.md')).toBeTruthy();
  });
});
