import { useCallback, useEffect, useMemo, useState } from 'react';
import type React from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api, apiExtra, type Artifact, type Dashboard, type LibraryItem } from '../api';
import { AppShell, EmptyState, PageHead } from '../components/AppShell';
import { ARTIFACT_LABELS, formatBytes, formatCny, formatNumber, relativeTime } from '../lib/format';

const KIND_FILTERS = [
  { value: '', label: '全部' },
  { value: 'topic-card', label: '选题卡' },
  { value: 'research-notes', label: '资料卡' },
  { value: 'script', label: '脚本' },
  { value: 'shot-list', label: '分镜' },
  { value: 'publish-pack', label: '发布包' },
  { value: 'review-report', label: '复盘' },
];

export function LibraryPage(): React.ReactElement {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [kind, setKind] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ item: LibraryItem; content: string } | null>(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [library, board] = await Promise.all([apiExtra.library({ kind, q: query }), apiExtra.dashboard()]);
      setItems(library.items);
      setDashboard(board);
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [kind, query]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = async (item: LibraryItem): Promise<void> => {
    try {
      const detail = await api.getArtifact(item.id);
      setPreview({ item, content: detail.content });
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    }
  };

  const totals = useMemo(() => {
    if (dashboard === null) return { artifacts: 0, projects: 0, cost: 0, views: 0 };
    const artifacts = dashboard.artifactsByKind.reduce((sum, entry) => sum + entry.count, 0);
    const views = dashboard.metricsSummary.reduce((sum, entry) => sum + entry.views, 0);
    return { artifacts, projects: dashboard.counts.active, cost: dashboard.spend.costCny, views };
  }, [dashboard]);

  return (
    <AppShell title={<b>资料库</b>}>
      <PageHead
        title="资料库"
        subtitle={
          loading
            ? '加载中…'
            : `${items.length} 个产物 · 跨 ${totals.projects} 个项目 · 累计播放 ${formatNumber(totals.views)}`
        }
      >
        <button className="btn" onClick={() => void load()}>
          刷新
        </button>
      </PageHead>

      {error !== null && <div className="panel error-panel">{error}</div>}

      <div className="metric-grid">
        <Metric label="产物总数" value={String(totals.artifacts)} hint="所有版本，含历史" />
        <Metric label="进行中项目" value={String(totals.projects)} hint="软删除的不计" />
        <Metric label="模型花费" value={formatCny(totals.cost)} hint="本机累计" />
        <Metric label="累计播放" value={formatNumber(totals.views)} hint="来自复盘录入" />
      </div>

      <div className="toolbar">
        <div className="segmented" role="group" aria-label="类型筛选">
          {KIND_FILTERS.map((filter) => (
            <button key={filter.value} aria-pressed={kind === filter.value} onClick={() => setKind(filter.value)}>
              {filter.label}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <input
          className="input search"
          placeholder="搜索路径、类型、项目名"
          aria-label="搜索资料库"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <div className="library-layout">
        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">全部产物</span>
            <span className="hint">按创建时间倒序</span>
          </div>
          {items.length === 0 && !loading ? (
            <EmptyState title="资料库是空的" hint="生成一次选题或脚本后，产物会自动出现在这里。" />
          ) : (
            <ul className="library-list">
              {items.map((item) => (
                <li key={item.id}>
                  <button className="library-item" onClick={() => void open(item)}>
                    <span className={`kind-dot kind-${item.kind}`} aria-hidden="true" />
                    <span className="library-path">
                      <span className="mono">{item.path.split('/').pop()}</span>
                      <span className="hint">
                        {item.projectTitle} · {ARTIFACT_LABELS[item.kind] ?? item.kind}
                      </span>
                    </span>
                    <span className="hint">{formatBytes(item.size)}</span>
                    <span className="hint">{relativeTime(item.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside className="panel library-preview">
          <div className="panel-head">
            <span className="panel-title">{preview === null ? '预览' : preview.item.path}</span>
          </div>
          {preview === null ? (
            <p className="hint">点左侧任意产物查看内容。</p>
          ) : (
            <>
              <div className="row">
                <button
                  className="btn sm"
                  onClick={() => navigate(`/p/${preview.item.projectId}`)}
                >
                  打开项目
                </button>
                <span className="hint">{preview.item.projectTitle}</span>
              </div>
              <pre className="output preview-text">{preview.content}</pre>
            </>
          )}
        </aside>
      </div>
    </AppShell>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }): React.ReactElement {
  return (
    <div className="metric-card">
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
      <span className="hint">{hint}</span>
    </div>
  );
}

export type { Artifact };
