import { render, screen, waitFor } from '@testing-library/react';
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
      scenarios: vi.fn(async () => ({
        scenarios: [
          {
            id: 'video',
            name: '中长视频',
            description: '',
            icon: '',
            builtin: true,
            defaultPlatform: 'bilibili',
            stages: [
              { key: 'topic', label: '选题', hint: '', produces: ['topic-card'], promptHint: '', required: true },
              { key: 'research', label: '资料', hint: '', produces: ['research-notes'], promptHint: '', required: true },
              { key: 'script', label: '脚本', hint: '', produces: ['script'], promptHint: '', required: true },
              { key: 'shotlist', label: '分镜', hint: '', produces: ['shot-list'], promptHint: '', required: false },
              { key: 'package', label: '包装', hint: '', produces: ['publish-pack'], promptHint: '', required: true },
              { key: 'published', label: '发布', hint: '', produces: [], promptHint: '', required: false },
              { key: 'review', label: '复盘', hint: '', produces: ['review-report'], promptHint: '', required: false },
            ],
            entityTypes: [],
          },
        ],
        defaultId: 'video',
      })),
      getProject: vi.fn(),
      createProject: vi.fn(async () => ({
        project: {
          id: 'new-1',
          ownerId: 'u1',
          title: '测试项目',
          platform: 'bilibili' as const,
          stage: 'topic' as const,
          workspacePath: null,
          styleProfileId: null,
          createdAt: '2026-10-21T10:00:00.000Z',
          updatedAt: '2026-10-21T10:00:00.000Z',
          deletedAt: null,
        },
      })),
      advanceStage: vi.fn(),
      createRun: vi.fn(),
      executeRun: vi.fn(),
      getRun: vi.fn(),
      runEvents: vi.fn(),
      listApprovals: vi.fn(async () => ({ approvals: [] })),
      decideApproval: vi.fn(),
      audit: vi.fn(async () => ({ records: [] })),
    },
  };
});

const mocked = vi.mocked(api, true);

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = '#/';
});

describe('R3 project list', () => {
  it('shows the empty state when the daemon returns no projects', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/还没有项目/)).toBeTruthy();
    });
    expect(mocked.listProjects).toHaveBeenCalledTimes(1);
  });

  it('renders project titles returned by the daemon', async () => {
    mocked.listProjects.mockResolvedValueOnce({
      projects: [
        {
          id: 'p1',
          ownerId: 'u1',
          title: '为什么 AI 编程正在杀死初级开发者',
          platform: 'bilibili',
          stage: 'script',
          workspacePath: null,
          styleProfileId: null,
          createdAt: '2026-10-21T10:00:00.000Z',
          updatedAt: '2026-10-21T10:00:00.000Z',
          deletedAt: null,
        },
      ],
    });
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('为什么 AI 编程正在杀死初级开发者')).toBeTruthy();
    });
  });

  it('reports a daemon error instead of crashing', async () => {
    mocked.listProjects.mockRejectedValueOnce(new Error('boom'));
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('boom')).toBeTruthy();
    });
  });
});

describe('R4 create project', () => {
  it('calls createProject then refreshes the list', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(screen.getByText(/还没有项目/)).toBeTruthy());

    const input = screen.getByPlaceholderText('新项目标题');
    await user.type(input, '测试项目');
    await user.click(screen.getByRole('button', { name: '新建项目' }));

    await waitFor(() => {
      // The scenario id is now part of the call so the pack decides the stages.
      expect(mocked.createProject).toHaveBeenCalledWith('测试项目', 'bilibili', 'video');
    });
    expect(mocked.listProjects.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('does not call the API with an empty title', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(screen.getByText(/还没有项目/)).toBeTruthy());
    const button = screen.getByRole('button', { name: '新建项目' });
    expect(button.hasAttribute('disabled')).toBe(true);
    await user.click(button);
    expect(mocked.createProject).not.toHaveBeenCalled();
  });
});
