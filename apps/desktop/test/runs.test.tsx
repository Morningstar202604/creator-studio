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
      getProject: vi.fn(),
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
    },
  };
});

const mocked = vi.mocked(api, true);

const sampleRun = {
  id: 'run-abcdef12-3456',
  projectId: 'p1',
  agentId: 'scriptwriter',
  status: 'succeeded' as const,
  budget: { maxTokens: 1000, maxCostCny: 5, usedTokens: 342, usedCostCny: 0.12 },
  error: null,
  startedAt: '2026-10-21T10:00:00.000Z',
  endedAt: '2026-10-21T10:01:00.000Z',
  createdAt: '2026-10-21T10:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = '#/runs';
});

describe('R5 runs list', () => {
  it('shows the empty state when there are no runs', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/还没有运行记录/)).toBeTruthy();
    });
    expect(mocked.listRuns).toHaveBeenCalled();
  });

  it('renders a run with status, tokens and agent', async () => {
    mocked.listRuns.mockResolvedValueOnce({ runs: [sampleRun] });
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('scriptwriter')).toBeTruthy();
    });
    expect(screen.getByText('succeeded')).toBeTruthy();
    expect(screen.getByText('342')).toBeTruthy();
    expect(screen.getByText('run-abcd')).toBeTruthy();
  });

  it('renders a failed run with its error code', async () => {
    mocked.listRuns.mockResolvedValueOnce({
      runs: [
        {
          ...sampleRun,
          status: 'failed',
          error: { code: 'MODEL_AUTH', message: 'no key', retryable: false },
        },
      ],
    });
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('MODEL_AUTH')).toBeTruthy();
    });
    expect(screen.getByText('failed')).toBeTruthy();
  });

  it('passes the selected status filter to the API', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(mocked.listRuns).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: '失败' }));
    await waitFor(() => {
      expect(mocked.listRuns).toHaveBeenCalledWith({ status: 'failed' });
    });
  });

  it('surfaces a daemon error instead of crashing', async () => {
    mocked.listRuns.mockRejectedValueOnce(new Error('daemon down'));
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('daemon down')).toBeTruthy();
    });
  });
});
