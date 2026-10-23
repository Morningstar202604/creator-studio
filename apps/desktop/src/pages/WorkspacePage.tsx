import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError, api, type Project, type Run, type Step } from '../api';
import { AppShell } from '../components/AppShell';
import { useRunStream } from '../features/useRunStream';

const STAGES: Array<{ key: Project['stage']; label: string }> = [
  { key: 'topic', label: '选题' },
  { key: 'research', label: '资料' },
  { key: 'script', label: '脚本' },
  { key: 'shotlist', label: '分镜' },
  { key: 'package', label: '包装' },
  { key: 'published', label: '发布' },
  { key: 'review', label: '复盘' },
];

export function WorkspacePage(): React.ReactElement {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.getProject(id);
      setProject(result.project);
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
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

  const currentIndex = STAGES.findIndex((stage) => stage.key === project.stage);
  const next = STAGES[currentIndex + 1];

  const advance = async (): Promise<void> => {
    if (next === undefined) return;
    try {
      const result = await api.advanceStage(project.id, next.key);
      setProject(result.project);
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <AppShell
      title={
        <>
          <span>项目</span>
          <span className="sep">›</span>
          <b>{STAGES[currentIndex]?.label ?? project.stage}</b>
        </>
      }
    >
      <div className="workspace">
        <aside className="rail">
          <div className="rail-title">阶段</div>
          <ol className="stage-list">
            {STAGES.map((stage, index) => (
              <li key={stage.key} className={index < currentIndex ? 'done' : index === currentIndex ? 'now' : ''}>
                {stage.label}
              </li>
            ))}
          </ol>
          {next !== undefined && (
            <button className="btn sm" onClick={() => void advance()}>
              进入{next.label}
            </button>
          )}
        </aside>

        <section className="doc">
          <div className="page-head">
            <div>
              <h1 className="page-title">{project.title}</h1>
              <div className="page-sub">
                {STAGES[currentIndex]?.label ?? project.stage} · {project.platform}
              </div>
            </div>
          </div>
          {error !== null && <div className="panel error-panel">{error}</div>}
          <RunPanel project={project} />
        </section>
      </div>
    </AppShell>
  );
}

function RunPanel({ project }: { project: Project }): React.ReactElement {
  const [prompt, setPrompt] = useState('');
  const [run, setRun] = useState<Run | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runAgent = async (agentId: 'scriptwriter' | 'editor'): Promise<void> => {
    if (prompt.trim() === '') return;
    setBusy(true);
    setError(null);
    setOutput('');
    try {
      const created = await api.createRun(project.id, prompt.trim(), agentId);
      // The panel subscribes as soon as the run exists; the server replays persisted
      // events on connect, so a late subscribe still receives the full sequence.
      setRun(created.run);
      const executed = await api.executeRun(created.run.id, prompt.trim(), agentId);
      setRun(executed.run);
      setOutput(executed.outcome.text ?? '');
      if (executed.outcome.status === 'failed') {
        setError(`${executed.outcome.code ?? 'ERROR'}: ${executed.outcome.message ?? ''}`);
      }
      if (executed.outcome.status === 'waiting_approval') {
        setError('该操作需要你批准，去「待办」处理。');
      }
      const detail = await api.getRun(created.run.id);
      setSteps(detail.steps);
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
        </div>
        <textarea
          className="input textarea"
          rows={3}
          placeholder="例如：读 ref.md，写一段 800 字的开场，输出到 script/opening.md"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <div className="row">
          <button
            className="btn primary"
            disabled={busy || prompt.trim() === ''}
            onClick={() => void runAgent('scriptwriter')}
          >
            {busy ? '运行中…' : '编剧 Agent'}
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
            <span
              className={`badge ${run.status === 'succeeded' ? 'ok' : run.status === 'failed' ? 'danger' : 'warn'}`}
            >
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
