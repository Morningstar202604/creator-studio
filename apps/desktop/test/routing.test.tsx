import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';

vi.mock('../src/api', async () => {
  const actual = await vi.importActual<typeof import('../src/api')>('../src/api');
  return {
    ...actual,
    api: {
      health: vi.fn(async () => ({ ok: true, version: 1, workspaceRoot: 'C:/ws', os: 'win32', pid: 1 })),
      tools: vi.fn(async () => ({
        tools: [
          { name: 'fs.read', risk: 'low', approvalKind: null },
          { name: 'fs.write', risk: 'medium', approvalKind: null },
          { name: 'fs.delete', risk: 'high', approvalKind: 'delete' },
        ],
      })),
      listProjects: vi.fn(async () => ({ projects: [] })),
      getProject: vi.fn(async () => ({
        project: {
          id: 'p1',
          ownerId: 'u1',
          title: '真实项目',
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
      getRun: vi.fn(),
      runEvents: vi.fn(),
      listApprovals: vi.fn(async () => ({ approvals: [] })),
      decideApproval: vi.fn(),
      audit: vi.fn(async () => ({ records: [] })),
    },
  };
});

function setHash(hash: string): void {
  window.location.hash = hash;
}

describe('R1 route coverage', () => {
  beforeEach(() => {
    setHash('#/');
  });

  const cases: Array<[string, string]> = [
    ['#/', '项目'],
    ['#/p/p1', '真实项目'],
    ['#/approvals', '待办'],
    ['#/runs', '任务'],
    ['#/library', '资料库'],
    ['#/automations', '自动化'],
    ['#/settings', '设置'],
    ['#/onboarding', '首次引导'],
    ['#/p/p1/topic', '选题'],
    ['#/p/p1/research', '资料'],
    ['#/p/p1/script', '脚本'],
    ['#/p/p1/shotlist', '分镜'],
    ['#/p/p1/package', '包装'],
    ['#/p/p1/publish', '发布'],
    ['#/p/p1/review', '复盘'],
  ];

  for (const [hash, heading] of cases) {
    it(`renders ${hash} with heading ${heading}`, async () => {
      window.location.hash = hash;
      render(<App />);
      await waitFor(() => {
        const headings = screen.getAllByRole('heading', { level: 1 });
        expect(headings.some((node) => node.textContent?.includes(heading))).toBe(true);
      });
    });
  }

  it('renders a not-found placeholder for an unknown route', async () => {
    window.location.hash = '#/does-not-exist';
    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('页面不存在');
    });
  });
});

describe('R2 shell structure', () => {
  it('exposes topbar, sidenav, main and skip link', async () => {
    window.location.hash = '#/';
    const { container } = render(<App />);
    await waitFor(() => {
      expect(container.querySelectorAll('header.topbar')).toHaveLength(1);
    });
    expect(container.querySelectorAll('nav.sidenav')).toHaveLength(1);
    expect(container.querySelectorAll('main#main')).toHaveLength(1);
    const skip = container.querySelector('a.skip');
    expect(skip?.textContent).toBe('跳到主内容');
    expect(skip?.getAttribute('href')).toBe('#main');
  });

  it('highlights the active nav item', async () => {
    window.location.hash = '#/approvals';
    const { container } = render(<App />);
    await waitFor(() => {
      expect(container.querySelectorAll('a.nav-item.active')).toHaveLength(1);
    });
    expect(container.querySelector('a.nav-item.active')?.textContent).toContain('待办');
  });
});

describe('layout regression guards', () => {
  it('keeps the skip link outside the two-row app grid', async () => {
    window.location.hash = '#/';
    const { container } = render(<App />);
    await waitFor(() => {
      expect(container.querySelector('.app')).toBeTruthy();
    });
    const app = container.querySelector('.app');
    const skip = container.querySelector('a.skip');
    expect(skip).toBeTruthy();
    // The app grid has exactly two rows; a third child would collapse the layout.
    expect(app?.contains(skip as Node)).toBe(false);
    expect(app?.children.length).toBe(2);
  });
});

describe('stale daemon detection', () => {
  it('warns when the daemon lacks required capabilities', async () => {
    const apiModule = await import('../src/api');
    const healthMock = vi.mocked(apiModule.api.health);
    healthMock.mockResolvedValueOnce({
      ok: true,
      version: 1,
      apiVersion: 1,
      capabilities: ['runs'],
      workspaceRoot: 'C:/ws',
      os: 'win32',
      pid: 42,
    });

    window.location.hash = '#/';
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/daemon 版本过旧/)).toBeTruthy();
    });
  });
});
