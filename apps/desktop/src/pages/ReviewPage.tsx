import { useCallback, useEffect, useMemo, useState } from 'react';
import type React from 'react';
import { useParams } from 'react-router-dom';
import { ApiError, api, apiExtra, type Project, type ProjectMetrics } from '../api';
import { AppShell, EmptyState, PageHead } from '../components/AppShell';
import { Chart, barsOption, trendOption } from '../components/Chart';
import { formatCny, formatNumber } from '../lib/format';

export function ReviewPage(): React.ReactElement {
  const { id = '' } = useParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [metrics, setMetrics] = useState<ProjectMetrics[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    views: '',
    likes: '',
    comments: '',
    shares: '',
    retentionPercent: '',
    revenueCny: '',
    note: '',
  });

  const load = useCallback(async () => {
    try {
      const [projectResult, metricsResult] = await Promise.all([api.getProject(id), apiExtra.metrics(id)]);
      setProject(projectResult.project);
      setMetrics(metricsResult.metrics);
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (): Promise<void> => {
    if (form.views === '' || form.likes === '' || form.comments === '') return;
    setBusy(true);
    try {
      await apiExtra.addMetrics(id, {
        views: Number(form.views),
        likes: Number(form.likes),
        comments: Number(form.comments),
        shares: Number(form.shares) || 0,
        retentionPercent: Math.min(100, Math.max(0, Number(form.retentionPercent) || 0)),
        revenueCny: Number(form.revenueCny) || 0,
        note: form.note,
      });
      setForm({ views: '', likes: '', comments: '', shares: '', retentionPercent: '', revenueCny: '', note: '' });
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const ordered = useMemo(() => [...metrics].reverse(), [metrics]);

  const chart = useMemo(() => {
    const labels = ordered.map((entry) =>
      new Date(entry.recordedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    );
    return trendOption(labels, [
      { name: '播放', values: ordered.map((entry) => entry.views) },
      { name: '点赞', values: ordered.map((entry) => entry.likes) },
      { name: '评论', values: ordered.map((entry) => entry.comments) },
    ]);
  }, [ordered]);

  const retention = useMemo(() => {
    const labels = ordered.map((entry) =>
      new Date(entry.recordedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    );
    return barsOption(labels, ordered.map((entry) => entry.retentionPercent), '完播率 %');
  }, [ordered]);

  const latest = metrics[0];
  const previous = metrics[1];
  const delta = (key: 'views' | 'likes' | 'comments'): number | null => {
    if (latest === undefined || previous === undefined) return null;
    if (previous[key] === 0) return null;
    return Math.round(((latest[key] - previous[key]) / previous[key]) * 100);
  };

  const engagement =
    latest === undefined || latest.views === 0
      ? 0
      : ((latest.likes + latest.comments + latest.shares) / latest.views) * 100;

  return (
    <AppShell
      title={
        <>
          <span>复盘</span>
          <span className="sep">›</span>
          <b>{project?.title ?? id.slice(0, 8)}</b>
        </>
      }
    >
      <PageHead
        title="复盘"
        subtitle={project === null ? '加载中…' : `${metrics.length} 次数据回填 · 手工录入或从后台复制数字`}
      >
        <button className="btn" onClick={() => void load()}>
          刷新
        </button>
      </PageHead>

      {error !== null && <div className="panel error-panel">{error}</div>}

      {metrics.length === 0 ? (
        <EmptyState title="还没有数据" hint="在下方录入本期播放、点赞、评论，之后可以看趋势与归因。" />
      ) : (
        <>
          <div className="metric-grid">
            <MetricCard label="最近播放" value={formatNumber(latest?.views ?? 0)} delta={delta('views')} />
            <MetricCard label="最近点赞" value={formatNumber(latest?.likes ?? 0)} delta={delta('likes')} />
            <MetricCard label="最近评论" value={formatNumber(latest?.comments ?? 0)} delta={delta('comments')} />
            <MetricCard label="互动率" value={`${engagement.toFixed(2)}%`} delta={null} />
            <MetricCard label="完播率" value={`${(latest?.retentionPercent ?? 0).toFixed(1)}%`} delta={null} />
            <MetricCard label="收益" value={formatCny(latest?.revenueCny ?? 0)} delta={null} />
          </div>

          <div className="review-grid">
            <section className="panel">
              <div className="panel-head">
                <span className="panel-title">播放 / 点赞 / 评论趋势</span>
              </div>
              <Chart option={chart} height={280} />
            </section>
            <section className="panel">
              <div className="panel-head">
                <span className="panel-title">完播率</span>
              </div>
              <Chart option={retention} height={280} />
            </section>
          </div>
        </>
      )}

      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">回填本期数据</span>
          <span className="hint">数字来自平台后台，手动录入，不上传任何素材</span>
        </div>
        <div className="form-grid">
          <label>
            播放
            <input
              className="input"
              type="number"
              min={0}
              value={form.views}
              onChange={(event) => setForm({ ...form, views: event.target.value })}
            />
          </label>
          <label>
            点赞
            <input
              className="input"
              type="number"
              min={0}
              value={form.likes}
              onChange={(event) => setForm({ ...form, likes: event.target.value })}
            />
          </label>
          <label>
            评论
            <input
              className="input"
              type="number"
              min={0}
              value={form.comments}
              onChange={(event) => setForm({ ...form, comments: event.target.value })}
            />
          </label>
          <label>
            分享
            <input
              className="input"
              type="number"
              min={0}
              value={form.shares}
              onChange={(event) => setForm({ ...form, shares: event.target.value })}
            />
          </label>
          <label>
            完播率 %
            <input
              className="input"
              type="number"
              min={0}
              max={100}
              value={form.retentionPercent}
              onChange={(event) => setForm({ ...form, retentionPercent: event.target.value })}
            />
          </label>
          <label>
            收益（元）
            <input
              className="input"
              type="number"
              min={0}
              step="0.01"
              value={form.revenueCny}
              onChange={(event) => setForm({ ...form, revenueCny: event.target.value })}
            />
          </label>
        </div>
        <label className="stack">
          备注
          <input
            className="input"
            value={form.note}
            placeholder="例如：换封面后 48 小时数据"
            onChange={(event) => setForm({ ...form, note: event.target.value })}
          />
        </label>
        <div className="row">
          <button
            className="btn primary"
            disabled={busy || form.views === '' || form.likes === '' || form.comments === ''}
            onClick={() => void submit()}
          >
            {busy ? '保存中…' : '保存数据'}
          </button>
        </div>
      </section>

      {metrics.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">历史记录</span>
          </div>
          <div className="ledger">
            <div className="ledger-head review-ledger">
              <span>时间</span>
              <span>播放</span>
              <span>点赞</span>
              <span>评论</span>
              <span>完播</span>
              <span>收益</span>
              <span />
            </div>
            {metrics.map((entry) => (
              <div key={entry.id} className="ledger-row static review-ledger">
                <span className="hint">{new Date(entry.recordedAt).toLocaleString('zh-CN')}</span>
                <span className="mono">{formatNumber(entry.views)}</span>
                <span className="mono">{formatNumber(entry.likes)}</span>
                <span className="mono">{formatNumber(entry.comments)}</span>
                <span className="mono">{entry.retentionPercent.toFixed(1)}%</span>
                <span className="mono">{formatCny(entry.revenueCny)}</span>
                <button
                  className="btn sm ghost"
                  onClick={() => {
                    void apiExtra.deleteMetrics(entry.id).then(load);
                  }}
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </AppShell>
  );
}

function MetricCard({ label, value, delta }: { label: string; value: string; delta: number | null }): React.ReactElement {
  return (
    <div className="metric-card">
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
      {delta !== null && (
        <span className={`hint ${delta >= 0 ? 'up' : 'down'}`}>
          {delta >= 0 ? '▲' : '▼'} {Math.abs(delta)}% 环比
        </span>
      )}
    </div>
  );
}
