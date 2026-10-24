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
      onboardingStatus: vi.fn(async () => ({
        completed: false,
        modelConfigured: true,
        workspaceRoot: 'C:/ws',
        tools: 3,
      })),
      completeOnboarding: vi.fn(async () => ({ completed: true })),
      listModels: vi.fn(async () => ({
        models: [
          {
            id: 'm1',
            name: 'OpenAI',
            provider: 'openai-compatible',
            baseUrl: 'https://api.openai.com/v1',
            model: 'gpt-4o-mini',
            contextWindow: 128000,
            priceInPerM: 1,
            priceOutPerM: 2,
            isLocal: false,
          },
        ],
        activeModelId: 'm1',
        source: 'stored',
      })),
      saveModel: vi.fn(async () => ({ model: { id: 'm2', name: 'new' } })),
      deleteModel: vi.fn(async () => null),
      listGrants: vi.fn(async () => ({
        deviceId: 'dev-1',
        grants: [],
        tools: [
          { name: 'fs.read', risk: 'low', approvalKind: null, mode: 'auto' },
          { name: 'fs.delete', risk: 'high', approvalKind: 'delete', mode: 'deny' },
        ],
      })),
      setGrant: vi.fn(async () => ({ grants: [] })),
      getBudget: vi.fn(async () => ({
        budget: { monthlyCostCny: 50, perProjectCostCny: 5, warnAtPercent: 80 },
      })),
      setBudget: vi.fn(async () => ({
        budget: { monthlyCostCny: 120, perProjectCostCny: 8, warnAtPercent: 70 },
      })),
    },
    apiExtra: {
      ...actual.apiExtra,
      embeddingStatus: vi.fn(async () => ({
        modelId: null,
        active: 'hash-ngram',
        neural: false,
        indexedChunks: 12,
        mode: 'lexical-local' as const,
      })),
      setEmbeddingModel: vi.fn(async () => ({ modelId: null, reindexed: 12 })),
      listModelsFull: vi.fn(async () => ({
        models: [
          {
            id: 'm1',
            name: 'OpenAI',
            provider: 'openai-compatible',
            baseUrl: 'https://api.openai.com/v1',
            model: 'gpt-4o-mini',
            contextWindow: 128000,
            priceInPerM: 1,
            priceOutPerM: 2,
            isLocal: false,
            apiKeyRef: 'env:MODEL_API_KEY',
            keyConfigured: true,
            source: 'stored',
          },
        ],
        activeModelId: 'm1',
        source: 'stored',
      })),
    },
  };
});

const mocked = vi.mocked(api, true);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('onboarding page', () => {
  it('walks from environment to model to workspace', async () => {
    window.location.hash = '#/onboarding';
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => expect(screen.getByText(/已连接/)).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '下一步' }));

    await waitFor(() => expect(screen.getByRole('button', { name: '保存并继续' })).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '保存并继续' }));
    await waitFor(() => expect(mocked.saveModel).toHaveBeenCalled());

    await waitFor(() => expect(screen.getByRole('button', { name: '开始使用' })).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '开始使用' }));
    await waitFor(() => expect(mocked.completeOnboarding).toHaveBeenCalled());
  });

  it('allows skipping model setup', async () => {
    window.location.hash = '#/onboarding';
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(screen.getByText(/已连接/)).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await user.click(screen.getByRole('button', { name: '稍后配置' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '开始使用' })).toBeTruthy());
  });
});

describe('settings page', () => {
  it('lists models from the daemon', async () => {
    window.location.hash = '#/settings';
    render(<App />);
    await waitFor(() => expect(screen.getAllByText('OpenAI').length).toBeGreaterThan(0));
    expect(screen.getAllByText('gpt-4o-mini').length).toBeGreaterThan(0);
  });

  it('shows tool permissions with their modes', async () => {
    window.location.hash = '#/settings';
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: '工具权限' }));
    await waitFor(() => expect(screen.getByText('fs.delete')).toBeTruthy());
    const select = screen.getByLabelText('fs.delete 权限') as HTMLSelectElement;
    expect(select.value).toBe('deny');
  });

  it('persists a grant change', async () => {
    window.location.hash = '#/settings';
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: '工具权限' }));
    const select = await screen.findByLabelText('fs.read 权限');
    await user.selectOptions(select, 'ask');
    await waitFor(() => expect(mocked.setGrant).toHaveBeenCalledWith('fs.read', 'ask'));
  });

  it('edits and saves the budget', async () => {
    window.location.hash = '#/settings';
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: '预算' }));
    const monthly = await screen.findByLabelText('月度上限（元）');
    await user.clear(monthly);
    await user.type(monthly, '120');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mocked.setBudget).toHaveBeenCalled());
  });
});

describe('memory settings', () => {
  it('shows the offline lexical mode and lists embedding models', async () => {
    window.location.hash = '#/settings';
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: '记忆' }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('设置');
    });
    await waitFor(() => {
      expect(screen.getByText(/本地 n-gram 哈希向量/)).toBeTruthy();
    });
    const select = screen.getByLabelText('嵌入模型') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(screen.getByText('hash-ngram')).toBeTruthy();
  });
});
