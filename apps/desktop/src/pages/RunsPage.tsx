import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, api, apiExtra, type Run } from '../api';
import { AppShell, EmptyState, PageHead } from '../components/AppShell';
import { formatCny, relativeTime } from '../lib/format';

const STATUS_FILTERS = [
  { value: '', label: '全部' },
  { value: 'running', label: '运行中' },
  { value: 'waiting_approval', label: '待审批' },
  { value: 'succeeded', label: '成功' },
  { value: 'failed', label: '失败' },
  { value: 'paused', label: '已暂停' },
];

const STATUS_CLASS: Record<string, string> = {
  succeeded: 'ok',
  failed: 'danger',
  waiting_approval: 'warn',
  paused: 'warn',
  running: 'info',
  cancelled: '',
};

const STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  waiting_approval: '等确认',
  paused: '已暂停',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
};

export function RunsPage(): React.ReactElement {
  const [runs, setRuns] = useState<Run[]>([]);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.listRuns(status === '' ? {} : { status });
      setRuns(result.runs);
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  const cancel = async (runId: string): Promise<void> => {
    setCancelTarget(runId);
    try {
      await apiExtra.cancelRun(runId);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCancelTarget(null);
    }
  };

  return (
    <AppShell title={<b>任务</b>}>
      <PageHead title="任务" subtitle={loading ? '加载中…' : `${runs.length} 条运行记录 · 每次运行都有事件流与花费明细`}>
        <div className="segmented" role="group" aria-label="状态筛选">
          {STATUS_FILTERS.map((filter) => (
            <button key={filter.value} aria-pressed={status === filter.value} onClick={() => setStatus(filter.value)}>
              {filter.label}
            </button>
          ))}
        </div>
        <button className="btn" onClick={() => void load()}>
          刷新
        </button>
      </PageHead>

      {error !== null && <div className="panel error-panel">{error}</div>}

      {runs.length === 0 && !loading ? (
        <EmptyState title="还没有运行记录" hint="去项目里派活给 Agent，运行会实时出现在这里。" />
      ) : (
        <div className="ledger">
          <div className="ledger-head runs-ledger">
            <span>运行</span>
            <span>状态</span>
            <span>tokens</span>
            <span>花费</span>
            <span>开始</span>
            <span />
          </div>
          {runs.map((run) => (
            <div key={run.id} className="ledger-row static runs-ledger">
              <span className="run-title">
                <Link to={`/p/${run.projectId}`}>{run.agentId}</Link>
                <span className="hint mono">{run.id.slice(0, 8)}</span>
              </span>
              <span>
                <span className={`badge ${STATUS_CLASS[run.status] ?? ''}`}>
                  {STATUS_LABEL[run.status] ?? run.status}
                </span>
                {run.error !== null && <span className="hint run-error">{run.error.code}</span>}
              </span>
              <span className="mono">{run.budget.usedTokens}</span>
              <span className="mono">{formatCny(run.budget.usedCostCny)}</span>
              <span className="hint">{run.startedAt === null ? '—' : relativeTime(run.startedAt)}</span>
              <span className="row-end">
                <button className="btn sm" onClick={() => navigate(`/p/${run.projectId}`)}>
                  项目
                </button>
                {(run.status === 'running' || run.status === 'queued' || run.status === 'waiting_approval') && (
                  <button
                    className="btn sm ghost"
                    disabled={cancelTarget === run.id}
                    onClick={() => void cancel(run.id)}
                  >
                    {cancelTarget === run.id ? '取消中…' : '取消'}
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </AppShell>
  );
}
