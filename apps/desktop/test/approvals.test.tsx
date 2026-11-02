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
      createProject: vi.fn(),
      advanceStage: vi.fn(),
      createRun: vi.fn(),
      executeRun: vi.fn(),
      getRun: vi.fn(),
      runEvents: vi.fn(),
      listApprovals: vi.fn(async () => ({ approvals: [] })),
      decideApproval: vi.fn(async () => ({
        approval: {
          id: 'ap1',
          runId: 'r1',
          stepId: 's1',
          kind: 'delete',
          decision: 'approved' as const,
          requestedAt: '2026-10-21T10:00:00.000Z',
        },
      })),
      audit: vi.fn(async () => ({ records: [] })),
    },
  };
});

const mocked = vi.mocked(api, true);

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = '#/approvals';
});

describe('R5 approvals', () => {
  it('shows the empty state when nothing is pending', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('没有待办')).toBeTruthy();
    });
  });

  it('renders a pending delete approval with a high-risk marker', async () => {
    mocked.listApprovals.mockResolvedValue({
      approvals: [
        {
          id: 'ap1',
          runId: 'run-12345678',
          stepId: 's1',
          kind: 'delete',
          decision: 'pending',
          requestedAt: '2026-10-21T10:00:00.000Z',
        },
      ],
    });
    const { container } = render(<App />);
    await waitFor(() => {
      expect(container.querySelectorAll('.appr.risk-high')).toHaveLength(1);
    });
    expect(screen.getByText('delete')).toBeTruthy();
  });

  it('calls decideApproval with approved and reloads', async () => {
    const user = userEvent.setup();
    mocked.listApprovals.mockResolvedValue({
      approvals: [
        {
          id: 'ap1',
          runId: 'run-12345678',
          stepId: 's1',
          kind: 'delete',
          decision: 'pending',
          requestedAt: '2026-10-21T10:00:00.000Z',
        },
      ],
    });
    render(<App />);

    const approve = await screen.findByRole('button', { name: '批准' });
    await user.click(approve);

    await waitFor(() => {
      expect(mocked.decideApproval).toHaveBeenCalledWith('ap1', 'approved');
    });
    expect(mocked.listApprovals.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('calls decideApproval with rejected', async () => {
    const user = userEvent.setup();
    mocked.listApprovals.mockResolvedValue({
      approvals: [
        {
          id: 'ap2',
          runId: 'run-12345678',
          stepId: 's1',
          kind: 'publish',
          decision: 'pending',
          requestedAt: '2026-10-21T10:00:00.000Z',
        },
      ],
    });
    render(<App />);

    await user.click(await screen.findByRole('button', { name: '拒绝' }));
    await waitFor(() => {
      expect(mocked.decideApproval).toHaveBeenCalledWith('ap2', 'rejected');
    });
  });
});
