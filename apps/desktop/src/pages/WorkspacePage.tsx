import { useCallback, useEffect, useState } from 'react';
import type React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError, api, apiExtra, type Project, type Run, type Step } from '../api';
import { AppShell, PageHead } from '../components/AppShell';
import { MemoryPanel } from './MemoryPage';
import { useRunStream } from '../features/useRunStream';
import { STAGES, formatCny, relativeTime, stageLink, stageIndex } from '../lib/format';

type ProjectStats = { artifacts: number; runs: number; tokens: number; costCny: number };
type ChecklistEntry = { key: string; label: string; ok: boolean; required?: boolean };

export function WorkspacePage(): React.ReactElement {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [stats, setStats] = useState<ProjectStats | null>(null);
  const [checklist, setChecklist] = useState<ChecklistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await apiExtra.projectDetail(id);
      setProject(result.project);
      setStats(result.stats);
      setChecklist(result.checklist);
      setError(null);
    } catch {
      // Fall back to the stable per-resource routes; the aggregate route is newer.
      try {
        const projectResult = await api.getProject(id);
        setProject(projectResult.project);
        const artifacts = await api.listArtifacts(id).catch(() => ({ artifacts: [] }));
        setStats({ artifacts: artifacts.artifacts.length, runs: 0, tokens: 0, costCny: 0 });
        const checklistResult = await api.checklist(id).catch(() => ({ items: [], ready: false, missing: [] }));
        setChecklist(checklistResult.items);
        setError(null);
      } catch (cause) {
        setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <AppShell title={<b>加载中</b>}>
        <div className="empty">正在读取项目…</div>
      </AppShell>
    );
  }

  if (project === null) {
    return (
      <AppShell title={<b>项目不存在</b>}>
        <div className="panel error-panel">{error ?? '找不到该项目'}</div>
        <button className="btn" onClick={() => navigate('/')}>
          返回项目列表
        </button>
      </AppShell>
    );
  }

  const current = stageIndex(project.stage);
  const required = checklist.filter((item) => item.required !== false);
  const done = required.filter((item) => item.ok).length;

  return (
    <AppShell
      title={
        <>
          <span>项目</span>
          <span className="sep">›</span>
          <b>{project.title}</b>
        </>
      }
    >
      <PageHead
        title={project.title}
        subtitle={
          <>
            {STAGES[current]?.label ?? project.stage} · {project.platform}
            {stats !== null && (
              <>
                {' · '}
                {stats.artifacts} 个产物 · {stats.runs} 次运行 · {formatCny(stats.costCny)}
              </>
            )}
          </>
        }
      >
        <button className="btn" onClick={() => void load()}>
          刷新
        </button>
        <button className="btn primary" onClick={() => navigate(stageLink(project.id, project.stage))}>
          继续当前阶段
        </button>
      </PageHead>

      {error !== null && <div className="panel error-panel">{error}</div>}

      <div className="workspace">
        <aside className="rail">
          <div className="rail-title">阶段</div>
          <ol className="stage-list">
            {STAGES.map((stage, index) => (
              <li key={stage.key} className={index < current ? 'done' : index === current ? 'now' : ''}>
                <button
                  className="stage-link"
                  onClick={() => navigate(stageLink(project.id, stage.key))}
                  aria-current={index === current ? 'step' : undefined}
                >
                  {stage.label}
                </button>
              </li>
            ))}
          </ol>
          <div className="rail-title">发布检查表</div>
          <div className="rail-progress">
            <span style={{ width: `${required.length === 0 ? 0 : (done / required.length) * 100}%` }} />
          </div>
          <p className="hint">
            {done}/{required.length} 项必备产物
          </p>
        </aside>

        <section className="doc">
          <div className="overview-grid">
            <div className="panel">
              <div className="panel-head">
                <span className="panel-title">阶段产物</span>
              </div>
              <ol className="checklist">
                {checklist.map((item) => (
                  <li key={item.key} className={item.ok ? 'ok' : item.required === false ? 'optional' : 'missing'}>
                    <span className="check" aria-hidden="true">
                      {item.ok ? '✓' : '·'}
                    </span>
                    <span className="label">{item.label}</span>
                    <span className="detail">{item.ok ? '已就绪' : item.required === false ? '可选' : '缺失'}</span>
                  </li>
                ))}
              </ol>
            </div>

            <div className="panel">
              <div className="panel-head">
                <span className="panel-title">项目信息</span>
              </div>
              <div className="kv">
                <span>平台</span>
                <span>{project.platform}</span>
                <span>创建</span>
                <span>{relativeTime(project.createdAt)}</span>
                <span>更新</span>
                <span>{relativeTime(project.updatedAt)}</span>
                <span>花费</span>
                <span>{formatCny(stats?.costCny ?? 0)}</span>
              </div>
              <ProjectSettings project={project} onSaved={load} />
            </div>
          </div>

          <MemoryPanel project={project} />
          <RunPanel project={project} onDone={load} />
          <RecentRuns projectId={project.id} />
        </section>
      </div>
    </AppShell>
  );
}

function ProjectSettings({ project, onSaved }: { project: Project; onSaved: () => Promise<void> }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(project.title);
  const [description, setDescription] = useState(project.description ?? '');
  const [tags, setTags] = useState((project.tags ?? []).join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const navigate = useNavigate();

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      await apiExtra.updateProject(project.id, {
        title: title.trim(),
        description,
        tags: tags
          .split(',')
          .map((tag) => tag.trim())
          .filter((tag) => tag !== '')
          .slice(0, 12),
      });
      await onSaved();
      setOpen(false);
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      await apiExtra.deleteProject(project.id);
      navigate('/');
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="row">
        <button className="btn sm" onClick={() => setOpen(true)}>
          编辑项目
        </button>
      </div>
    );
  }

  return (
    <div className="stack">
      <label>
        标题
        <input className="input" value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label>
        简介
        <textarea
          className="input textarea"
          rows={2}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <label>
        标签（逗号分隔）
        <input className="input" value={tags} onChange={(event) => setTags(event.target.value)} />
      </label>
      {error !== null && <p className="error-text">{error}</p>}
      <div className="row">
        <button className="btn sm primary" disabled={busy} onClick={() => void save()}>
          保存
        </button>
        <button className="btn sm" onClick={() => setOpen(false)}>
          取消
        </button>
        {!confirmDelete ? (
          <button className="btn sm ghost danger-text" onClick={() => setConfirmDelete(true)}>
            删除项目
          </button>
        ) : (
          <button className="btn sm danger" disabled={busy} onClick={() => void remove()}>
            确认删除（可恢复）
          </button>
        )}
      </div>
    </div>
  );
}

function RunPanel({ project, onDone }: { project: Project; onDone: () => Promise<void> }): React.ReactElement {
  const [prompt, setPrompt] = useState('');
  const [run, setRun] = useState<Run | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runAgent = async (agentId: 'scriptwriter' | 'editor' | 'producer' | 'critic'): Promise<void> => {
    if (prompt.trim() === '') return;
    setBusy(true);
    setError(null);
    setOutput('');
    try {
      const created = await api.createRun(project.id, prompt.trim(), agentId);
      setRun(created.run);
      const executed = await api.executeRun(created.run.id, prompt.trim(), agentId);
      setRun(executed.run);
      setOutput(executed.outcome.text ?? '');
      if (executed.outcome.status === 'failed') {
        setError(`${executed.outcome.code ?? 'ERROR'}: ${executed.outcome.message ?? ''}`);
      }
      if (executed.outcome.status === 'waiting_approval') {
        setError('该操作需要你批准，去「待办」批准后可直接继续执行。');
      }
      const detail = await api.getRun(created.run.id);
      setSteps(detail.steps);
      await onDone();
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
          <span className="panel-title">派活给 Agent</span>
          <span className="hint">工具调用受权限与审批约束，每一步都会留痕</span>
        </div>
        <textarea
          className="input textarea"
          rows={3}
          placeholder="例如：读 ref.md，写一段 800 字的开场，输出到 script/opening.md"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <div className="row wrap">
          <button
            className="btn primary"
            disabled={busy || prompt.trim() === ''}
            onClick={() => void runAgent('scriptwriter')}
          >
            {busy ? '运行中…' : '编剧 Agent'}
          </button>
          <button className="btn" disabled={busy || prompt.trim() === ''} onClick={() => void runAgent('producer')}>
            制片人
          </button>
          <button className="btn" disabled={busy || prompt.trim() === ''} onClick={() => void runAgent('critic')}>
            审片人
          </button>
          <button className="btn" disabled={busy || prompt.trim() === ''} onClick={() => void runAgent('editor')}>
            剪辑 Agent
          </button>
          {busy && <span className="hint">正在调用模型，可能需要几十秒</span>}
        </div>
      </div>

      {error !== null && <div className="panel error-panel">{error}</div>}

      {output !== '' && (
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">输出</span>
          </div>
          <pre className="output">{output}</pre>
        </div>
      )}

      {run !== null && (
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">运行状态</span>
            <span className={`badge ${run.status === 'succeeded' ? 'ok' : run.status === 'failed' ? 'danger' : 'warn'}`}>
              {run.status}
            </span>
          </div>
          <div className="kv">
            <span>步骤</span>
            <span>{steps.length}</span>
            <span>tokens</span>
            <span>{run.budget.usedTokens}</span>
            <span>花费</span>
            <span>¥{run.budget.usedCostCny.toFixed(4)}</span>
          </div>
          {steps.length > 0 && (
            <ol className="steps">
              {steps.map((step) => (
                <li key={step.id} className={step.status === 'succeeded' ? 'done' : ''}>
                  <span className="st">#{step.index}</span>
                  {step.kind} · {step.status}
                </li>
              ))}
            </ol>
          )}
          {run.status === 'waiting_approval' && (
            <div className="row">
              <button
                className="btn sm primary"
                onClick={() => {
                  void apiExtra
                    .resumeRun(run.id)
                    .then(async (result) => {
                      setRun(result.run);
                      setOutput(result.outcome.text ?? output);
                      const detail = await api.getRun(run.id);
                      setSteps(detail.steps);
                      await onDone();
                    })
                    .catch((cause: unknown) => {
                      setError(cause instanceof Error ? cause.message : String(cause));
                    });
                }}
              >
                继续执行
              </button>
            </div>
          )}
        </div>
      )}

      {run !== null && <EventStreamPanel key={run.id} runId={run.id} />}
    </>
  );
}

function EventStreamPanel({ runId }: { runId: string | null }): React.ReactElement {
  const fetcher = useCallback(
    async (after: number) => {
      if (runId === null) return [];
      const result = await api.runEvents(runId, after);
      return result.events;
    },
    [runId],
  );
  const { events, state } = useRunStream(runId, runId === null ? '' : api.streamUrl(runId), fetcher);

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">事件流</span>
        <span className="hint" data-stream-state={state}>
          {state === 'open' ? '实时' : state === 'connecting' ? '连接中' : state === 'error' ? '轮询兜底' : '未订阅'}
        </span>
      </div>
      {events.length === 0 ? (
        <p className="hint">暂无事件。发起一次运行后会在这里实时出现。</p>
      ) : (
        <ol className="events">
          {events.map((event) => (
            <li key={event.id}>
              <span className="mono">{event.seq}</span> {event.type}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function RecentRuns({ projectId }: { projectId: string }): React.ReactElement {
  const [runs, setRuns] = useState<Run[]>([]);

  useEffect(() => {
    if (typeof api.listRuns !== 'function') {
      setRuns([]);
      return;
    }
    void api
      .listRuns({ projectId, limit: 5 })
      .then((result) => setRuns(result.runs))
      .catch(() => setRuns([]));
  }, [projectId]);

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">最近运行</span>
      </div>
      {runs.length === 0 ? (
        <p className="hint">还没有运行记录。</p>
      ) : (
        <ul className="version-list">
          {runs.map((run) => (
            <li key={run.id}>
              <span className="mono">{run.agentId}</span>
              <span className={`badge ${run.status === 'succeeded' ? 'ok' : run.status === 'failed' ? 'danger' : 'warn'}`}>
                {run.status}
              </span>
              <span className="hint">{relativeTime(run.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
