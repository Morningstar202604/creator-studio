import { useCallback, useEffect, useState } from 'react';
import type React from 'react';
import { ApiError, api, type BudgetSettings, type GrantTool, type ModelInfo } from '../api';
import { AppShell } from '../components/AppShell';

type Tab = 'models' | 'grants' | 'budget';

export function SettingsPage(): React.ReactElement {
  const [tab, setTab] = useState<Tab>('models');

  return (
    <AppShell title={<b>设置</b>}>
      <div className="page-head">
        <div>
          <h1 className="page-title">设置</h1>
          <div className="page-sub">模型、工具权限、预算</div>
        </div>
      </div>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分区">
          <button aria-pressed={tab === 'models'} onClick={() => setTab('models')}>
            模型
          </button>
          <button aria-pressed={tab === 'grants'} onClick={() => setTab('grants')}>
            工具权限
          </button>
          <button aria-pressed={tab === 'budget'} onClick={() => setTab('budget')}>
            预算
          </button>
        </nav>

        <section>
          {tab === 'models' && <ModelsPanel />}
          {tab === 'grants' && <GrantsPanel />}
          {tab === 'budget' && <BudgetPanel />}
        </section>
      </div>
    </AppShell>
  );
}

function ModelsPanel(): React.ReactElement {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [source, setSource] = useState('runtime');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [model, setModel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api.listModels();
      setModels(result.models);
      setSource(result.source);
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async (): Promise<void> => {
    if (name.trim() === '' || model.trim() === '') return;
    setBusy(true);
    try {
      await api.saveModel({ name: name.trim(), baseUrl: baseUrl.trim(), model: model.trim() });
      setName('');
      setModel('');
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">已配置模型</span>
          <span className="hint">{source === 'stored' ? '来自设置' : '来自启动参数'}</span>
        </div>
        {models.length === 0 ? (
          <p className="hint">还没有模型。下面添加一个。</p>
        ) : (
          <ul className="model-list">
            {models.map((item) => (
              <li key={item.id}>
                <span className="label">{item.name}</span>
                <span className="mono hint">{item.model}</span>
                <span className="hint">
                  ¥{item.priceInPerM} / ¥{item.priceOutPerM} 每百万
                </span>
                <button
                  className="btn sm"
                  onClick={() => {
                    void api.deleteModel(item.id).then(load);
                  }}
                >
                  移除
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">添加模型</span>
        </div>
        <div className="form-grid">
          <label>
            名称
            <input className="input" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            Base URL
            <input className="input" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
          </label>
          <label>
            模型名
            <input className="input" value={model} onChange={(event) => setModel(event.target.value)} />
          </label>
        </div>
        {error !== null && <p className="error-text">{error}</p>}
        <div className="row">
          <button className="btn primary" disabled={busy} onClick={() => void add()}>
            {busy ? '保存中…' : '保存'}
          </button>
          <span className="hint">密钥请放在环境变量 MODEL_API_KEY，界面不存明文</span>
        </div>
      </div>
    </>
  );
}

function GrantsPanel(): React.ReactElement {
  const [tools, setTools] = useState<GrantTool[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.listGrants();
      setTools(result.tools);
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const change = async (tool: string, mode: 'auto' | 'ask' | 'deny'): Promise<void> => {
    try {
      await api.setGrant(tool, mode);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">工具权限</span>
        <span className="hint">deny 优先于 ask 优先于 auto；高风险工具始终需要审批</span>
      </div>
      {error !== null && <p className="error-text">{error}</p>}
      <ul className="grant-list">
        {tools.map((tool) => (
          <li key={tool.name}>
            <span className="label">{tool.name}</span>
            <span className={`badge ${tool.risk === 'high' ? 'danger' : tool.risk === 'medium' ? 'warn' : ''}`}>
              {tool.risk}
            </span>
            <select
              className="input select sm-select"
              value={tool.mode}
              aria-label={`${tool.name} 权限`}
              onChange={(event) => void change(tool.name, event.target.value as 'auto')}
            >
              <option value="auto">auto</option>
              <option value="ask">ask</option>
              <option value="deny">deny</option>
            </select>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BudgetPanel(): React.ReactElement {
  const [budget, setBudget] = useState<BudgetSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.getBudget();
      setBudget(result.budget);
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (): Promise<void> => {
    if (budget === null) return;
    setBusy(true);
    try {
      const result = await api.setBudget(budget);
      setBudget(result.budget);
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">预算</span>
      </div>
      {error !== null && <p className="error-text">{error}</p>}
      {budget !== null && (
        <div className="form-grid">
          <label>
            月度上限（元）
            <input
              className="input"
              type="number"
              value={budget.monthlyCostCny}
              onChange={(event) => setBudget({ ...budget, monthlyCostCny: Number(event.target.value) })}
            />
          </label>
          <label>
            单项目上限（元）
            <input
              className="input"
              type="number"
              value={budget.perProjectCostCny}
              onChange={(event) => setBudget({ ...budget, perProjectCostCny: Number(event.target.value) })}
            />
          </label>
          <label>
            预警阈值（%）
            <input
              className="input"
              type="number"
              value={budget.warnAtPercent}
              onChange={(event) => setBudget({ ...budget, warnAtPercent: Number(event.target.value) })}
            />
          </label>
        </div>
      )}
      <div className="row">
        <button className="btn primary" disabled={busy || budget === null} onClick={() => void save()}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  );
}
