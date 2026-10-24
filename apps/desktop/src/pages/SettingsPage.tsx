import { useCallback, useEffect, useState } from 'react';
import type React from 'react';
import { ApiError, api, apiExtra, type BudgetSettings, type GrantTool, type ModelInfo } from '../api';
import { AppShell } from '../components/AppShell';
import { useTheme, type ThemeMode } from '../lib/theme';
import { formatCny } from '../lib/format';

type Tab = 'models' | 'grants' | 'budget' | 'appearance';

type FullModel = ModelInfo & { apiKeyRef: string; keyConfigured: boolean };

const PROVIDERS = [
  { value: 'openai-compatible', label: 'OpenAI 兼容' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'ollama', label: 'Ollama（本地）' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'qwen', label: '通义千问' },
];

export function SettingsPage(): React.ReactElement {
  const [tab, setTab] = useState<Tab>('models');
  return (
    <AppShell title={<b>设置</b>}>
      <div className="page-head">
        <div>
          <h1 className="page-title">设置</h1>
          <div className="page-sub">模型、工具权限、预算与外观</div>
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
          <button aria-pressed={tab === 'appearance'} onClick={() => setTab('appearance')}>
            外观
          </button>
        </nav>

        <section>
          {tab === 'models' && <ModelsPanel />}
          {tab === 'grants' && <GrantsPanel />}
          {tab === 'budget' && <BudgetPanel />}
          {tab === 'appearance' && <AppearancePanel />}
        </section>
      </div>
    </AppShell>
  );
}

function ModelsPanel(): React.ReactElement {
  const [models, setModels] = useState<FullModel[]>([]);
  const [source, setSource] = useState('runtime');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [model, setModel] = useState('');
  const [provider, setProvider] = useState('openai-compatible');
  const [apiKey, setApiKey] = useState('');
  const [priceIn, setPriceIn] = useState('0');
  const [priceOut, setPriceOut] = useState('0');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const result = await apiExtra.listModelsFull();
      setModels(result.models);
      setSource(result.source);
      setError(null);
    } catch {
      try {
        const fallback = await api.listModels();
        setModels(
          fallback.models.map((model) => ({
            ...model,
            apiKeyRef: 'env:MODEL_API_KEY',
            keyConfigured: false,
          })),
        );
        setSource(fallback.source);
        setError(null);
      } catch (cause) {
        setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async (): Promise<void> => {
    if (name.trim() === '' || model.trim() === '') return;
    setBusy(true);
    try {
      await apiExtra.saveModelFull({
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        provider,
        priceInPerM: Number.parseFloat(priceIn) || 0,
        priceOutPerM: Number.parseFloat(priceOut) || 0,
        ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
        isLocal: baseUrl.includes('127.0.0.1') || baseUrl.includes('localhost'),
      });
      setName('');
      setModel('');
      setApiKey('');
      setNotice('模型已保存');
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const saveKey = async (id: string): Promise<void> => {
    const value = keyDraft[id] ?? '';
    if (value.trim() === '') return;
    setBusy(true);
    try {
      await apiExtra.setModelKey(id, value.trim());
      setKeyDraft({ ...keyDraft, [id]: '' });
      setNotice('密钥已保存到本机密钥库');
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const test = async (id: string): Promise<void> => {
    setTesting(id);
    setNotice(null);
    setError(null);
    try {
      const result = await apiExtra.testModel(id);
      setNotice(`连接成功：${result.latencyMs}ms，返回「${result.sample ?? ''}」`);
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    } finally {
      setTesting(null);
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
          <p className="hint">还没有模型。下面添加一个，或启动 daemon 时用环境变量注入。</p>
        ) : (
          <ul className="model-list">
            {models.map((item) => (
              <li key={item.id} className="model-row">
                <div className="model-main">
                  <span className="label">{item.name}</span>
                  <span className="mono hint">{item.model}</span>
                  <span className="hint">{item.baseUrl}</span>
                  <span className="hint">
                    {formatCny(item.priceInPerM)} / {formatCny(item.priceOutPerM)} 每百万 token
                  </span>
                  <span className={`badge ${item.keyConfigured ? 'ok' : 'warn'}`}>
                    {item.keyConfigured ? '密钥已配置' : '缺密钥'}
                  </span>
                </div>
                <div className="row wrap">
                  <input
                    className="input key-input"
                    type="password"
                    placeholder={item.keyConfigured ? '替换密钥' : '填入 API Key'}
                    value={keyDraft[item.id] ?? ''}
                    aria-label={`${item.name} 密钥`}
                    onChange={(event) => setKeyDraft({ ...keyDraft, [item.id]: event.target.value })}
                  />
                  <button className="btn sm" disabled={busy} onClick={() => void saveKey(item.id)}>
                    保存密钥
                  </button>
                  <button className="btn sm" disabled={testing === item.id} onClick={() => void test(item.id)}>
                    {testing === item.id ? '测试中…' : '测试连接'}
                  </button>
                  <button
                    className="btn sm ghost"
                    onClick={() => {
                      void api.deleteModel(item.id).then(load);
                    }}
                  >
                    移除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {notice !== null && <div className="panel notice-panel">{notice}</div>}
      {error !== null && <div className="panel error-panel">{error}</div>}

      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">添加模型</span>
          <span className="hint">密钥写入本机密钥库（secrets.json，0600），不写数据库、不入日志</span>
        </div>
        <div className="form-grid">
          <label>
            名称
            <input className="input" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            提供方
            <select className="input select" value={provider} onChange={(event) => setProvider(event.target.value)}>
              {PROVIDERS.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Base URL
            <input className="input" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
          </label>
          <label>
            模型名
            <input className="input" value={model} onChange={(event) => setModel(event.target.value)} />
          </label>
          <label>
            API Key
            <input
              className="input"
              type="password"
              value={apiKey}
              placeholder="sk-…（可留空，先用环境变量）"
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
          <label>
            输入价（元/百万）
            <input className="input" value={priceIn} onChange={(event) => setPriceIn(event.target.value)} />
          </label>
          <label>
            输出价（元/百万）
            <input className="input" value={priceOut} onChange={(event) => setPriceOut(event.target.value)} />
          </label>
        </div>
        <div className="row">
          <button className="btn primary" disabled={busy} onClick={() => void add()}>
            {busy ? '保存中…' : '保存'}
          </button>
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
        <span className="hint">deny 优先于 ask 优先于 auto；高风险工具无论设置都会请求审批</span>
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
        <span className="hint">触顶时 Run 自动暂停，不会静默超支</span>
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

function AppearancePanel(): React.ReactElement {
  const { mode, setMode } = useTheme();
  const options: Array<{ value: ThemeMode; label: string; hint: string }> = [
    { value: 'light', label: '浅色', hint: '暖灰纸面 + 墨绿强调' },
    { value: 'dark', label: '深色', hint: '低照度环境' },
    { value: 'system', label: '跟随系统', hint: '按操作系统主题切换' },
  ];

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">外观</span>
      </div>
      <div className="theme-options">
        {options.map((option) => (
          <button
            key={option.value}
            className={`theme-option${mode === option.value ? ' active' : ''}`}
            aria-pressed={mode === option.value}
            onClick={() => setMode(option.value)}
          >
            <span className={`theme-preview theme-${option.value}`} aria-hidden="true" />
            <span className="theme-label">{option.label}</span>
            <span className="hint">{option.hint}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
