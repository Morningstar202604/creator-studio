import { useCallback, useEffect, useMemo, useState } from 'react';
import type React from 'react';
import { useParams } from 'react-router-dom';
import { ApiError, api, type Artifact, type ChecklistItem, type Project, type ScenarioPack } from '../api';
import { AppShell, PageHead } from '../components/AppShell';
import { ARTIFACT_LABELS, formatBytes, relativeTime, stageHref } from '../lib/format';

export function PublishPage(): React.ReactElement {
  const { id = '' } = useParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [ready, setReady] = useState(false);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [pack, setPack] = useState<ScenarioPack | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    file: string;
    bytes: number;
    entries: string[];
    absolutePath?: string;
  } | null>(null);

  const load = useCallback(async () => {
    try {
      const [projectResult, checklistResult, artifactResult, scenarioResult] = await Promise.all([
        api.getProject(id),
        api.checklist(id),
        api.listArtifacts(id),
        typeof api.scenarios === 'function' ? api.scenarios() : Promise.resolve({ scenarios: [] }),
      ]);
      setProject(projectResult.project);
      setChecklist(checklistResult.items);
      setReady(checklistResult.ready);
      setArtifacts(artifactResult.artifacts);
      setPack(scenarioResult.scenarios.find((candidate) => candidate.id === projectResult.project.scenarioId) ?? null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onFocus = (): void => {
      void load();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

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

  // Everything the export can actually ship: the zip writer's own allow-list, so
  // the count on screen matches the files in the archive (novel outlines and
  // chapters were missing here while the exporter already included them).
  const openable = useMemo(
    () =>
      artifacts.filter((artifact) =>
        ['topic-card', 'research-notes', 'script', 'shot-list', 'subtitle', 'publish-pack', 'outline', 'chapter'].includes(
          artifact.kind,
        ),
      ),
    [artifacts],
  );

  const missingStageLink = useCallback(
    (stageKey: string): string | null => {
      const stage = pack?.stages.find((candidate) => candidate.key === stageKey);
      return stage === undefined ? null : stageHref(id, stage);
    },
    [id, pack],
  );

  const required = checklist.filter((item) => item.required !== false);
  const done = required.filter((item) => item.ok).length;

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
      <PageHead
        title="发布"
        subtitle={
          ready
            ? `检查表 ${done}/${required.length} 通过，可以导出发布包`
            : `检查表 ${done}/${required.length}，下方列出缺项`
        }
      >
        <button className="btn" disabled={reloading} onClick={() => void refresh()}>
          {reloading ? '刷新中…' : '刷新检查表'}
        </button>
        <button className="btn primary" disabled={busy || !ready} onClick={() => void exportPack()}>
          {busy ? '打包中…' : '导出发布包'}
        </button>
      </PageHead>

      {error !== null && <div className="panel error-panel">{error}</div>}

      <div className="publish-layout">
        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">检查表</span>
            <span className={`badge ${ready ? 'ok' : 'warn'}`}>{ready ? '通过' : '未通过'}</span>
          </div>
          <ol className="checklist">
            {checklist.map((item) => (
              <li key={item.key} className={item.ok ? 'ok' : item.required === false ? 'optional' : 'missing'}>
                <span className="check" aria-hidden="true">
                  {item.ok ? '✓' : '·'}
                </span>
                <span className="label">{item.label}</span>
                <span className="detail">{item.detail}</span>
                {!item.ok && missingStageLink(item.stage) !== null && (
                  <a className="link-btn" href={`#${missingStageLink(item.stage) as string}`}>
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
            <span className="hint">
              {openable.length} 个产物 + README + manifest，共 {openable.length + 2} 个文件
            </span>
          </div>
          {openable.length === 0 ? (
            <p className="hint">还没有可发布的产物。</p>
          ) : (
            <ul className="file-list">
              {openable.map((artifact) => (
                <li key={artifact.id}>
                  <span className="mono">{artifact.path}</span>
                  <span className="hint">{ARTIFACT_LABELS[artifact.kind] ?? artifact.kind}</span>
                  <span className="hint">{formatBytes(artifact.size)}</span>
                  <span className="hint">{relativeTime(artifact.createdAt)}</span>
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
            <span className="badge ok">完成</span>
          </div>
          <p>
            <span className="mono">{result.file}</span>
            <span className="hint">
              {' '}
              · {formatBytes(result.bytes)} · {result.entries.length} 个文件
            </span>
          </p>
          {result.absolutePath !== undefined && <p className="hint mono">{result.absolutePath}</p>}
          <ul className="file-list">
            {result.entries.map((entry) => (
              <li key={entry}>
                <span className="mono">{entry}</span>
              </li>
            ))}
          </ul>
          <p className="hint">文件位于工作区 publish-exports 目录，zip 里还有一份自动生成的 README。</p>
        </section>
      )}
    </AppShell>
  );
}
