import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type Approval } from '../api';
import { AppShell } from '../components/AppShell';

export function ApprovalsPage(): React.ReactElement {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.listApprovals('pending');
      setApprovals(result.approvals);
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

  const decide = async (id: string, decision: 'approved' | 'rejected'): Promise<void> => {
    try {
      await api.decideApproval(id, decision);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <AppShell title={<b>待办</b>}>
      <div className="page-head">
        <div>
          <h1 className="page-title">待办</h1>
          <div className="page-sub">{loading ? '加载中…' : `${approvals.length} 项等待你决定`}</div>
        </div>
        <div className="spacer" />
        <button className="btn" onClick={() => void load()}>
          刷新
        </button>
      </div>

      {error !== null && <div className="panel error-panel">{error}</div>}

      {approvals.length === 0 && !loading ? (
        <div className="empty">没有待办。</div>
      ) : (
        <div className="appr-list">
          {approvals.map((approval) => (
            <article
              key={approval.id}
              className={`appr ${approval.kind === 'delete' ? 'risk-high' : 'risk-mid'}`}
            >
              <div className="appr-top">
                <span className={`badge ${approval.kind === 'delete' ? 'danger' : 'warn'}`}>{approval.kind}</span>
                <span className="when">{new Date(approval.requestedAt).toLocaleString('zh-CN')}</span>
              </div>
              <div className="appr-body">
                Run <code>{approval.runId.slice(0, 8)}</code> · step <code>{approval.stepId}</code>
              </div>
              <div className="appr-actions">
                <button className="btn sm" onClick={() => void decide(approval.id, 'rejected')}>
                  拒绝
                </button>
                <button className="btn sm primary" onClick={() => void decide(approval.id, 'approved')}>
                  批准
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </AppShell>
  );
}
