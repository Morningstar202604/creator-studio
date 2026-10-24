import { useCallback, useEffect, useState } from 'react';
import type React from 'react';
import { ApiError, api, apiExtra, type Approval } from '../api';
import { AppShell, ApprovalList, EmptyState, PageHead } from '../components/AppShell';

export function ApprovalsPage(): React.ReactElement {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
      setNotice(decision === 'approved' ? '已批准。点「批准并继续执行」让 Agent 接着跑完。' : '已拒绝。');
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    }
  };

  const approveAndResume = async (runId: string, approvalId: string): Promise<void> => {
    try {
      await api.decideApproval(approvalId, 'approved');
      const result = await apiExtra.resumeRun(runId, approvalId);
      setNotice(
        result.outcome.status === 'succeeded' ? '已批准并执行完成。' : `已批准，当前状态：${result.outcome.status}`,
      );
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <AppShell title={<b>待办</b>}>
      <PageHead
        title="待办"
        subtitle={loading ? '加载中…' : `${approvals.length} 项等待你决定 · 危险操作永远逐次确认`}
      >
        <button className="btn" onClick={() => void load()}>
          刷新
        </button>
      </PageHead>

      {error !== null && <div className="panel error-panel">{error}</div>}
      {notice !== null && <div className="panel notice-panel">{notice}</div>}

      {approvals.length === 0 && !loading ? (
        <EmptyState title="没有待办" hint="Agent 在等你派活。需要审批的操作会出现在这里。" />
      ) : (
        <ApprovalList approvals={approvals} onDecide={decide} onResume={approveAndResume} />
      )}
    </AppShell>
  );
}
