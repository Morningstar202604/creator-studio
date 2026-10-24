import { useCallback, useEffect, useState } from 'react';
import type React from 'react';
import { Link } from 'react-router-dom';
import {
  ApiError,
  api,
  apiExtra,
  type Automation,
  type Project,
} from '../api';
import { AppShell, EmptyState, PageHead } from '../components/AppShell';
import { INTERVAL_PRESETS, intervalLabel, relativeTime } from '../lib/format';

const KIND_OPTIONS: Array<{ value: Automation['kind']; label: string }> = [
  { value: 'topic-card', label: '选题卡' },
  { value: 'research-notes', label: '资料卡' },
  { value: 'publish-pack', label: '发布包' },
];

export function AutomationsPage(): React.ReactElement {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({
    projectId: '',
    name: '',
    kind: 'topic-card' as Automation['kind'],
    prompt: '',
    intervalMinutes: 1440,
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [automationResult, projectResult] = await Promise.all([apiExtra.automations(), api.listProjects()]);
      setAutomations(automationResult.automations);
      setProjects(projectResult.projects);
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (): Promise<void> => {
    if (form.projectId === '' || form.name.trim() === '' || form.prompt.trim() === '') return;
    setBusy('create');
    try {
      await apiExtra.createAutomation({
        projectId: form.projectId,
        name: form.name.trim(),
        kind: form.kind,
        prompt: form.prompt.trim(),
        intervalMinutes: form.intervalMinutes,
      });
      setForm({ ...form, name: '', prompt: '' });
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (automation: Automation): Promise<void> => {
    setBusy(automation.id);
    try {
      await apiExtra.toggleAutomation(automation.id, !automation.enabled);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const runNow = async (automation: Automation): Promise<void> => {
    setBusy(automation.id);
    setError(null);
    try {
      const result = await apiExtra.runAutomation(automation.id);
      if (result.status !== 'succeeded') {
        setError(result.error ?? '自动化执行失败');
      }
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (automation: Automation): Promise<void> => {
    setBusy(automation.id);
    try {
      await apiExtra.deleteAutomation(automation.id);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <AppShell title={<b>自动化</b>}>
      <PageHead
        title="自动化"
        subtitle={
          loading
            ? '加载中…'
            : `${automations.length} 条规则 · 到点由本地 daemon 自动生成新版本，关机不运行`
        }
      >
        <button className="btn" onClick={() => void load()}>
          刷新
        </button>
      </PageHead>

      {error !== null && <div className="panel error-panel">{error}</div>}

      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">新建规则</span>
          <span className="hint">按固定间隔为某个项目重新生成一类产物</span>
        </div>
        <div className="form-grid">
          <label>
            项目
            <select
              className="input select"
              value={form.projectId}
              onChange={(event) => setForm({ ...form, projectId: event.target.value })}
              aria-label="自动化项目"
            >
              <option value="">选择项目</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            名称
            <input
              className="input"
              value={form.name}
              placeholder="例如：每日选题刷新"
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </label>
          <label>
            产物类型
            <select
              className="input select"
              value={form.kind}
              onChange={(event) => setForm({ ...form, kind: event.target.value as Automation['kind'] })}
              aria-label="产物类型"
            >
              {KIND_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            间隔
            <select
              className="input select"
              value={form.intervalMinutes}
              onChange={(event) => setForm({ ...form, intervalMinutes: Number(event.target.value) })}
              aria-label="运行间隔"
            >
              {INTERVAL_PRESETS.map((preset) => (
                <option key={preset.minutes} value={preset.minutes}>
                  {preset.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="stack">
          指令 / 上下文
          <textarea
            className="input textarea"
            rows={2}
            placeholder="例如：围绕 AI 编程工具的最新变化，给出 3 个差异化选题"
            value={form.prompt}
            onChange={(event) => setForm({ ...form, prompt: event.target.value })}
          />
        </label>
        <div className="row">
          <button
            className="btn primary"
            disabled={busy !== null || form.projectId === '' || form.name.trim() === '' || form.prompt.trim() === ''}
            onClick={() => void create()}
          >
            {busy === 'create' ? '创建中…' : '创建规则'}
          </button>
          <span className="hint">规则由 daemon 每 30 秒检查一次到期时间；关闭应用则暂停。</span>
        </div>
      </div>

      {automations.length === 0 && !loading ? (
        <EmptyState title="还没有自动化" hint="先建一个项目，再回来添加定时规则。" />
      ) : (
        <div className="automation-list">
          {automations.map((automation) => (
            <article key={automation.id} className={`automation-card${automation.enabled ? '' : ' paused'}`}>
              <div className="automation-head">
                <span className={`switch${automation.enabled ? ' on' : ''}`} aria-hidden="true" />
                <span className="automation-name">{automation.name}</span>
                <span className="badge">{KIND_OPTIONS.find((option) => option.value === automation.kind)?.label}</span>
                <span className="spacer" />
                <span className="hint">{intervalLabel(automation.intervalMinutes)}</span>
              </div>
              <p className="hint automation-prompt">{automation.prompt}</p>
              <div className="automation-meta hint">
                <span>上次：{relativeTime(automation.lastRunAt)}</span>
                <span>下次：{automation.enabled ? relativeTime(automation.nextRunAt) : '已暂停'}</span>
                {automation.recentRuns[0] !== undefined && (
                  <span className={`badge ${automation.recentRuns[0].status === 'succeeded' ? 'ok' : 'danger'}`}>
                    最近 {automation.recentRuns[0].status}
                  </span>
                )}
                <Link className="link-btn" to={`/p/${automation.projectId}`}>
                  打开项目
                </Link>
              </div>
              <div className="row">
                <button className="btn sm primary" disabled={busy !== null} onClick={() => void runNow(automation)}>
                  {busy === automation.id ? '执行中…' : '立即运行'}
                </button>
                <button className="btn sm" disabled={busy !== null} onClick={() => void toggle(automation)}>
                  {automation.enabled ? '暂停' : '启用'}
                </button>
                <button className="btn sm ghost" disabled={busy !== null} onClick={() => void remove(automation)}>
                  删除
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </AppShell>
  );
}
