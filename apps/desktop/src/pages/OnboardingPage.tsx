import { useCallback, useEffect, useState } from 'react';
import type React from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api } from '../api';

const STEPS = ['环境检查', '模型配置', '工作区'] as const;

export function OnboardingPage(): React.ReactElement {
  const [step, setStep] = useState(0);
  const [status, setStatus] = useState<{ workspaceRoot: string; tools: number; modelConfigured: boolean } | null>(null);
  const [name, setName] = useState('OpenAI');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [model, setModel] = useState('gpt-4o-mini');
  const [priceIn, setPriceIn] = useState('1');
  const [priceOut, setPriceOut] = useState('2');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    try {
      const result = await api.onboardingStatus();
      setStatus(result);
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveModel = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.saveModel({
        name,
        baseUrl,
        model,
        priceInPerM: Number.parseFloat(priceIn) || 0,
        priceOutPerM: Number.parseFloat(priceOut) || 0,
        contextWindow: 128000,
        isLocal: baseUrl.includes('127.0.0.1') || baseUrl.includes('localhost'),
      });
      setStep(2);
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const finish = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.completeOnboarding();
      navigate('/');
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="onboarding">
      <header className="onboarding-head">
        <span className="wordmark">稿台</span>
        <span className="wordmark-sub">首次设置</span>
      </header>

      <h1 className="page-title">首次引导</h1>

      <ol className="stepper">
        {STEPS.map((label, index) => (
          <li key={label} className={index === step ? 'now' : index < step ? 'done' : ''}>
            <span className="num">{index + 1}</span>
            {label}
          </li>
        ))}
      </ol>

      {error !== null && <div className="panel error-panel">{error}</div>}

      {step === 0 && (
        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">环境检查</span>
          </div>
          <ul className="checklist">
            <li className={status === null ? 'missing' : 'ok'}>
              <span className="check">{status === null ? '·' : '✓'}</span>
              <span className="label">本地 daemon</span>
              <span className="detail">{status === null ? '未连接' : '已连接'}</span>
            </li>
            <li className={status === null ? 'missing' : 'ok'}>
              <span className="check">{status === null ? '·' : '✓'}</span>
              <span className="label">工作区</span>
              <span className="detail">{status?.workspaceRoot ?? '—'}</span>
            </li>
            <li className={status === null ? 'missing' : 'ok'}>
              <span className="check">{status === null ? '·' : '✓'}</span>
              <span className="label">可用工具</span>
              <span className="detail">{status === null ? '—' : `${status.tools} 个`}</span>
            </li>
          </ul>
          <div className="row">
            <button className="btn primary" disabled={status === null} onClick={() => setStep(1)}>
              下一步
            </button>
          </div>
        </section>
      )}

      {step === 1 && (
        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">模型配置</span>
            <span className="hint">密钥不落在项目文件里，由 daemon 侧环境变量或钥匙串提供</span>
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
              模型
              <input className="input" value={model} onChange={(event) => setModel(event.target.value)} />
            </label>
            <label>
              输入价（元/百万 token）
              <input className="input" value={priceIn} onChange={(event) => setPriceIn(event.target.value)} />
            </label>
            <label>
              输出价（元/百万 token）
              <input className="input" value={priceOut} onChange={(event) => setPriceOut(event.target.value)} />
            </label>
          </div>
          <div className="row">
            <button className="btn" onClick={() => setStep(0)}>
              上一步
            </button>
            <button className="btn primary" disabled={busy} onClick={() => void saveModel()}>
              {busy ? '保存中…' : '保存并继续'}
            </button>
            <button className="btn ghost" onClick={() => setStep(2)}>
              稍后配置
            </button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">工作区</span>
          </div>
          <p>
            项目文件保存在 <span className="mono">{status?.workspaceRoot ?? '默认目录'}</span>
            。原始素材不会离开这台机器。
          </p>
          <div className="row">
            <button className="btn" onClick={() => setStep(1)}>
              上一步
            </button>
            <button className="btn primary" disabled={busy} onClick={() => void finish()}>
              {busy ? '完成中…' : '开始使用'}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
