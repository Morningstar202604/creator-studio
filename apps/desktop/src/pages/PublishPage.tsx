import { useCallback, useEffect, useState } from 'react';
import type React from 'react';
import { useParams } from 'react-router-dom';
import { ApiError, api, type Artifact, type ChecklistItem, type Project } from '../api';
import { AppShell } from '../components/AppShell';

const STAGE_LINKS: Record<string, string> = {
  topic: 'topic',
  research: 'research',
  script: 'script',
  package: 'package',
};

export function PublishPage(): React.ReactElement {
  const { id = '' } = useParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [ready, setReady] = useState(false);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [busy, setBusy] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ file: string; bytes: number; entries: string[] } | null>(null);

  const load = useCallback(async () => {
    try {
      const [projectResult, checklistResult, artifactResult] = await Promise.all([
        api.getProject(id),
        api.checklist(id),
        api.listArtifacts(id),
      ]);
      setProject(projectResult.project);
      setChecklist(checklistResult.items);
      setReady(checklistResult.ready);
      setArtifacts(artifactResult.artifacts);
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Artifacts can be produced in another page (or by an agent run) while this page
  // is open, so re-read the checklist whenever the window regains focus.
  useEffect(() => {
    const onFocus = (): void => {
      void load();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  // A window that never loses focus (e.g. an agent run writing in the background)
  // still needs fresh data, so poll at a slow interval on top of the focus refresh.
  useEffect(() => {
    const timer = window.setInterval(() => {
      void load();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const refresh = async (): Promise<void> => {
    if (reloading) return;
    setReloading(true);
    try {
      await load();
    } finally {
      setReloading(false);
    }
  };

  const exportPack = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const response = await api.publish(id);
      setResult(response);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const openable = artifacts.filter((artifact) =>
    ['topic-card', 'research-notes', 'script', 'publish-pack'].includes(artifact.kind),
  );

  return (
    <AppShell
      title={
        <>
          <span>发布</span>
          <span className="sep">›</span>
          <b>{project?.title ?? id.slice(0, 8)}</b>
        </>
      }
    >
      <div className="page-head">
        <div>
          <h1 className="page-title">发布</h1>
          <div className="page-sub">
            {ready ? '检查表已通过，可以导出' : '检查表未通过，下方列出缺项'}
          </div>
        </div>
        <div className="spacer" />
        <button className="btn" disabled={reloading} onClick={() => void refresh()}>
          {reloading ? '刷新中…' : '刷新检查表'}
        </button>
        <button className="btn primary" disabled={busy || !ready} onClick={() => void exportPack()}>
          {busy ? '打包中…' : '导出发布包'}
        </button>
      </div>

      {error !== null && <div className="panel error-panel">{error}</div>}

      <div className="publish-layout">
        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">检查表</span>
            <span className={`badge ${ready ? 'ok' : 'warn'}`}>{ready ? '通过' : '未通过'}</span>
          </div>
          <ol className="checklist">
            {checklist.map((item) => (
              <li key={item.key} className={item.ok ? 'ok' : 'missing'}>
                <span className="check" aria-hidden="true">
                  {item.ok ? '✓' : '·'}
                </span>
                <span className="label">{item.label}</span>
                <span className="detail">{item.detail}</span>
                {!item.ok && STAGE_LINKS[item.stage] !== undefined && (
                  <a className="link-btn" href={`#/p/${id}/${STAGE_LINKS[item.stage]}`}>
                    去补
                  </a>
                )}
              </li>
            ))}
          </ol>
        </section>

        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">文件清单</span>
            <span className="hint">{openable.length} 个产物</span>
          </div>
          {openable.length === 0 ? (
            <p className="hint">还没有可发布的产物。</p>
          ) : (
            <ul className="file-list">
              {openable.map((artifact) => (
                <li key={artifact.id}>
                  <span className="mono">{artifact.path}</span>
                  <span className="hint">{artifact.size} B</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {result !== null && (
        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">导出结果</span>
          </div>
          <p>
            <span className="mono">{result.file}</span>
            <span className="hint"> · {(result.bytes / 1024).toFixed(1)} KB · {result.entries.length} 个文件</span>
          </p>
          <p className="hint">文件位于项目工作区的 publish-exports 目录，用系统文件管理器打开即可。</p>
        </section>
      )}
    </AppShell>
  );
}
