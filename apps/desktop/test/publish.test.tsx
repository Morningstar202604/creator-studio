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
      health: vi.fn(async () => ({
        ok: true,
        version: 1,
        apiVersion: 2,
        capabilities: ['artifacts', 'generate', 'stream', 'runs'],
        workspaceRoot: 'C:/ws',
        os: 'win32',
        pid: 1,
      })),
      tools: vi.fn(async () => ({ tools: [] })),
      listProjects: vi.fn(async () => ({ projects: [] })),
      getProject: vi.fn(async () => ({
        project: {
          id: 'p1',
          ownerId: 'u1',
          title: '发布项目',
          platform: 'bilibili',
          stage: 'published',
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
      generate: vi.fn(),
      checklist: vi.fn(async () => ({
        items: [
          { key: 'topic', label: '选题卡', ok: true, detail: '1 个版本', stage: 'topic' },
          { key: 'script', label: '脚本', ok: false, detail: '尚未生成', stage: 'script' },
        ],
        ready: false,
        missing: ['script'],
      })),
      publish: vi.fn(async () => ({ file: 'publish-exports/x.zip', bytes: 2048, entries: ['script/a.md'] })),
    },
  };
});

const mocked = vi.mocked(api, true);

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = '#/p/p1/publish';
});

describe('R3 manual refresh', () => {
  it('re-reads the checklist when the refresh button is clicked', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(mocked.checklist).toHaveBeenCalledTimes(1));

    mocked.checklist.mockResolvedValueOnce({
      items: [{ key: 'script', label: '脚本', ok: true, detail: '1 个版本', stage: 'script' }],
      ready: true,
      missing: [],
    });

    await user.click(screen.getByRole('button', { name: '刷新检查表' }));
    await waitFor(() => expect(mocked.checklist).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('通过')).toBeTruthy());
  });

  it('re-reads the checklist when the window regains focus', async () => {
    render(<App />);
    await waitFor(() => expect(mocked.checklist).toHaveBeenCalledTimes(1));
    mocked.checklist.mockResolvedValueOnce({
      items: [{ key: 'script', label: '脚本', ok: true, detail: 'ok', stage: 'script' }],
      ready: true,
      missing: [],
    });
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(mocked.checklist).toHaveBeenCalledTimes(2));
  });

  it('re-reads the checklist on a 30s interval while the page stays open', async () => {
    vi.useFakeTimers();
    try {
      render(<App />);
      await vi.advanceTimersByTimeAsync(0);
      expect(mocked.checklist).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mocked.checklist.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('publish page', () => {
  it('disables export while the checklist fails and shows missing items', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('尚未生成')).toBeTruthy();
    });
    const button = screen.getByRole('button', { name: '导出发布包' });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('未通过')).toBeTruthy();
  });

  it('offers a link to the stage that is missing', async () => {
    render(<App />);
    const link = await screen.findByRole('link', { name: '去补' });
    expect(link.getAttribute('href')).toBe('#/p/p1/script');
  });

  it('exports when the checklist passes', async () => {
    mocked.checklist.mockResolvedValueOnce({
      items: [{ key: 'script', label: '脚本', ok: true, detail: '1 个版本', stage: 'script' }],
      ready: true,
      missing: [],
    });
    const user = userEvent.setup();
    render(<App />);

    const button = await screen.findByRole('button', { name: '导出发布包' });
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
    await user.click(button);

    await waitFor(() => {
      expect(mocked.publish).toHaveBeenCalledWith('p1');
    });
    await waitFor(() => {
      expect(screen.getByText(/publish-exports\/x.zip/)).toBeTruthy();
    });
  });

  it('shows the daemon error when export is refused', async () => {
    mocked.checklist.mockResolvedValueOnce({
      items: [{ key: 'script', label: '脚本', ok: true, detail: 'ok', stage: 'script' }],
      ready: true,
      missing: [],
    });
    mocked.publish.mockRejectedValueOnce(new Error('CHECKLIST_INCOMPLETE: missing script'));
    const user = userEvent.setup();
    render(<App />);

    const button = await screen.findByRole('button', { name: '导出发布包' });
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
    await user.click(button);

    await waitFor(() => {
      expect(screen.getByText(/CHECKLIST_INCOMPLETE/)).toBeTruthy();
    });
  });

  it('lists the files that will be packed', async () => {
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
          size: 120,
          visibility: 'local',
          createdAt: '2026-10-21T10:00:00.000Z',
        },
      ],
    });
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('script/script.v1.md')).toBeTruthy();
    });
  });
});
