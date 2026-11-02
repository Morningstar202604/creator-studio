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
      scenarios: vi.fn(async () => ({ scenarios: [], defaultId: 'video' })),
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
      streamUrl: vi.fn(),
      listArtifacts: vi.fn(async () => ({ artifacts: [] })),
      getArtifact: vi.fn(),
      saveArtifact: vi.fn(),
      rewrite: vi.fn(),
      generate: vi.fn(),
      checklist: vi.fn(async () => ({ items: [], ready: false, missing: [] })),
      publish: vi.fn(),
    },
    apiExtra: {
      ...actual.apiExtra,
      usage: vi.fn(async () => ({
        totals: { runs: 0, tokens: 0, cost: 0 },
        budget: { monthlyCostCny: 50, perProjectCostCny: 5, warnAtPercent: 80 },
        byAgent: [],
      })),
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = '#/';
});

describe('R1 the command palette is a controlled dialog', () => {
  it('opens on Ctrl+K, traps focus inside, and closes on Escape', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeTruthy());

    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog', { name: '命令面板' });
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '命令面板' })).toBeNull());
  });

  it('does not leave a second palette open when the shortcut fires twice', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeTruthy());

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('{Control>}k{/Control}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '命令面板' })).toBeNull());
  });
});
