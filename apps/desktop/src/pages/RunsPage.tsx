import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api, type Run } from '../api';
import { AppShell } from '../components/AppShell';

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
};

export function RunsPage(): React.ReactElement {
  const [runs, setRuns] = useState<Run[]>([]);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <AppShell title={<b>任务</b>}>
      <div className="page-head">
        <div>
          <h1 className="page-title">任务</h1>
          <div className="page-sub">{loading ? '加载中…' : `${runs.length} 条运行记录`}</div>
        </div>
        <div className="spacer" />
        <div className="segmented" role="group" aria-label="状态筛选">
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.value}
              aria-pressed={status === filter.value}
              onClick={() => setStatus(filter.value)}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <button className="btn" onClick={() => void load()}>
          刷新
        </button>
      </div>

      {error !== null && <div className="panel error-panel">{error}</div>}

      {runs.length === 0 && !loading ? (
        <div className="empty">还没有运行记录。去项目里派活给 Agent。</div>
      ) : (
        <div className="ledger runs-ledger">
          <div className="ledger-head">
            <span>运行</span>
            <span>状态</span>
            <span>tokens</span>
            <span>开始</span>
          </div>
          {runs.map((run) => (
            <div key={run.id} className="ledger-row static">
              <span className="run-title">
                <Link to={`/p/${run.projectId}`}>{run.agentId}</Link>
                <span className="hint mono">{run.id.slice(0, 8)}</span>
              </span>
              <span>
                <span className={`badge ${STATUS_CLASS[run.status] ?? ''}`}>{run.status}</span>
                {run.error !== null && <span className="hint run-error">{run.error.code}</span>}
              </span>
              <span className="mono">{run.budget.usedTokens}</span>
              <span className="hint">
                {run.startedAt === null ? '—' : new Date(run.startedAt).toLocaleString('zh-CN')}
              </span>
            </div>
          ))}
        </div>
      )}
    </AppShell>
  );
}
