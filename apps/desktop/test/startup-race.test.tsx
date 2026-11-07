import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api';
import { ProjectsPage } from '../src/pages/ProjectsPage';

/**
 * The packaged shell spawns the daemon as a child process. The first paint can
 * beat listen(), so the first project-list request fails while the connection
 * chip is still `offline`; two seconds later DaemonProvider reports `online`.
 * These tests drive that transition directly instead of waiting on a real timer.
 */
const state = vi.hoisted(() => ({ connection: 'offline' as 'checking' | 'online' | 'offline' }));

vi.mock('../src/app/DaemonProvider', () => ({
  useDaemon: () => ({
    connection: state.connection,
    health: null,
    tools: [],
    lastError: null,
    staleDaemon: false,
    refresh: async () => {},
  }),
}));

vi.mock('../src/api', async () => {
  const actual = await vi.importActual<typeof import('../src/api')>('../src/api');
  return {
    ...actual,
    api: {
      listProjects: vi.fn(),
      scenarios: vi.fn(),
      createProject: vi.fn(),
      listApprovals: vi.fn(async () => ({ approvals: [] })),
      getBudget: vi.fn(async () => ({ budget: null })),
      listModels: vi.fn(async () => ({ models: [] })),
    },
    apiExtra: {
      ...actual.apiExtra,
      usage: vi.fn(async () => null),
      restoreProject: vi.fn(),
    },
  };
});

const mocked = vi.mocked(api, true);
const UNREACHABLE = () =>
  new ApiError('DAEMON_UNREACHABLE', '无法连接本地 daemon（http://127.0.0.1:7878）：Failed to fetch', 0);

const PROJECT = {
  id: 'p1',
  ownerId: 'u1',
  title: '雾港纪事',
  platform: 'generic' as const,
  stage: 'topic',
  scenarioId: 'video',
  workspacePath: null,
  styleProfileId: null,
  createdAt: '2026-11-07T00:00:00.000Z',
  updatedAt: '2026-11-07T00:00:00.000Z',
  deletedAt: null,
};

function renderPage() {
  return render(
    <MemoryRouter>
      <ProjectsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps queued *Once implementations. A test that never gets to
  // its retry would otherwise leak that response into the next test's first call.
  mocked.listProjects.mockReset();
  mocked.scenarios.mockReset();
  state.connection = 'offline';
  mocked.listProjects.mockResolvedValue({ projects: [] });
  mocked.scenarios.mockResolvedValue({ scenarios: [], defaultId: 'video' });
});

describe('R8 packaged startup recovers from the daemon race', () => {
  it('clears the stale connection error and loads projects when the daemon comes online', async () => {
    mocked.listProjects.mockRejectedValueOnce(UNREACHABLE());
    const { rerender } = renderPage();

    await waitFor(() => {
      expect(screen.getByText(/无法连接本地 daemon/)).toBeTruthy();
    });
    expect(mocked.listProjects).toHaveBeenCalledTimes(1);

    mocked.listProjects.mockResolvedValueOnce({ projects: [PROJECT] });
    state.connection = 'online';
    rerender(
      <MemoryRouter>
        <ProjectsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.queryByText(/无法连接本地 daemon/)).toBeNull();
    });
    expect(await screen.findByText('雾港纪事')).toBeTruthy();
    expect(mocked.listProjects).toHaveBeenCalledTimes(2);
  });

  it('does not issue a second request on a startup that was healthy all along', async () => {
    state.connection = 'online';
    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/还没有项目/)).toBeTruthy();
    });
    expect(mocked.listProjects).toHaveBeenCalledTimes(1);
  });

  it('shows the error again if the daemon really is still down', async () => {
    mocked.listProjects.mockReset().mockRejectedValue(UNREACHABLE());
    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/无法连接本地 daemon/)).toBeTruthy();
    });
    expect(mocked.listProjects).toHaveBeenCalledTimes(1);
  });
});
