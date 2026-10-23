import { useCallback, useEffect, useMemo, useState } from 'react';
import type React from 'react';
import { useParams } from 'react-router-dom';
import { ApiError, api, type Artifact, type Project } from '../api';
import { AppShell } from '../components/AppShell';
import { applyHunks, diffLines, type DiffHunk } from '../features/diff';

export function ScriptPage(): React.ReactElement {
  const { id = '' } = useParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [text, setText] = useState('');
  const [savedText, setSavedText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ before: string; after: string } | null>(null);
  const [selection, setSelection] = useState('');
  const [range, setRange] = useState<{ start: number; end: number }>({ start: 0, end: 0 });

  const load = useCallback(async () => {
    try {
      const [projectResult, artifactResult] = await Promise.all([
        api.getProject(id),
        api.listArtifacts(id),
      ]);
      setProject(projectResult.project);
      setArtifacts(artifactResult.artifacts);
      const latest = artifactResult.artifacts.find((artifact) => artifact.kind === 'script');
      if (latest !== undefined) {
        const { content } = await api.getArtifact(latest.id);
        setText(content);
        setSavedText(content);
      }
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (): Promise<void> => {
    if (project === null) return;
    setBusy(true);
    try {
      const version = artifacts.filter((artifact) => artifact.kind === 'script').length + 1;
      await api.saveArtifact(project.id, {
        kind: 'script',
        path: `script/script.v${version}.md`,
        content: text,
      });
      setSavedText(text);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const rewrite = async (): Promise<void> => {
    if (selection.trim() === '') return;
    setBusy(true);
    try {
      const result = await api.rewrite(selection, '更口语、更短');
      const before = text;
      // Replace exactly at the selection offsets: String.replace would hit the first
      // matching occurrence anywhere in the document instead of the selected one.
      const after =
        before.slice(0, range.start) + result.rewritten + before.slice(range.end);
      setPending({ before, after });
    } catch (cause) {
      // R4: the editor content must survive a failed rewrite.
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const acceptHunk = (hunk: DiffHunk): void => {
    if (pending === null) return;
    const next = applyHunks(pending.before, pending.after, [hunk.id]);
    setText(next);
    setPending(null);
  };

  const acceptAll = (): void => {
    if (pending === null) return;
    setText(pending.after);
    setPending(null);
  };

  const diff = useMemo(
    () => (pending === null ? null : diffLines(pending.before, pending.after)),
    [pending],
  );

  const dirty = text !== savedText;

  // listArtifacts is newest-first, so the first hit per kind is the latest version.
  const latestUpstream = useMemo(() => {
    const topic = artifacts.find((artifact) => artifact.kind === 'topic-card');
    const research = artifacts.find((artifact) => artifact.kind === 'research-notes');
    return {
      topic,
      research,
      exists: topic !== undefined || research !== undefined,
    };
  }, [artifacts]);

  const importUpstream = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const sections: string[] = [];
      if (latestUpstream.topic !== undefined) {
        const detail = await api.getArtifact(latestUpstream.topic.id);
        sections.push(`## 选题\n\n${detail.content}`);
      }
      if (latestUpstream.research !== undefined) {
        const detail = await api.getArtifact(latestUpstream.research.id);
        sections.push(`## 资料\n\n${detail.content}`);
      }
      if (sections.length === 0) {
        setError('没有可带入的选题或资料产物');
        return;
      }
      setText(sections.join('\n\n'));
      // savedText stays empty so the imported scaffold is dirty until saved as a version.
      setSavedText('');
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell
      title={
        <>
          <span>脚本</span>
          <span className="sep">›</span>
          <b>{project?.title ?? id.slice(0, 8)}</b>
        </>
      }
    >
      <div className="page-head">
        <div>
          <h1 className="page-title">脚本</h1>
          <div className="page-sub">
            {project === null ? '加载中…' : `${artifacts.filter((a) => a.kind === 'script').length} 个版本`}
            {dirty && <span className="dirty"> · 未保存</span>}
          </div>
        </div>
        <div className="spacer" />
        {text === '' && latestUpstream.exists && (
          <button className="btn" disabled={busy} onClick={() => void importUpstream()}>
            {busy ? '带入中…' : '带入选题与资料'}
          </button>
        )}
        <button className="btn" disabled={busy || !dirty} onClick={() => void save()}>
          {busy ? '保存中…' : '保存为新版本'}
        </button>
      </div>

      {error !== null && <div className="panel error-panel">{error}</div>}

      <div className="script-layout">
        <section className="panel script-editor">
          <div className="panel-head">
            <span className="panel-title">正文</span>
            <span className="hint">{text.length} 字</span>
          </div>
          <textarea
            className="input script-textarea"
            value={text}
            placeholder="在这里写脚本，或让 Agent 生成后粘贴进来。"
            onChange={(event) => setText(event.target.value)}
            onSelect={(event) => {
              const target = event.target as HTMLTextAreaElement;
              const start = target.selectionStart;
              const end = target.selectionEnd;
              setSelection(target.value.slice(start, end));
              setRange({ start, end });
            }}
          />
          <div className="row">
            <button className="btn primary" disabled={busy || selection.trim() === ''} onClick={() => void rewrite()}>
              改写选中
            </button>
            <span className="hint">选中一段文字后可请求改写，结果先进入对照，不会直接覆盖</span>
          </div>
        </section>

        <aside className="panel script-side">
          <div className="panel-head">
            <span className="panel-title">{pending === null ? '版本' : '改写对照'}</span>
          </div>
          {pending === null ? (
            artifacts.filter((artifact) => artifact.kind === 'script').length === 0 ? (
              <p className="hint">还没有保存过版本。</p>
            ) : (
              <ol className="version-list">
                {artifacts
                  .filter((artifact) => artifact.kind === 'script')
                  .map((artifact) => (
                    <li key={artifact.id}>
                      <button
                        className="link-btn"
                        onClick={() => {
                          void api.getArtifact(artifact.id).then((result) => {
                            setText(result.content);
                            setSavedText(result.content);
                          });
                        }}
                      >
                        {artifact.path.split('/').pop()}
                      </button>
                      <span className="hint">{new Date(artifact.createdAt).toLocaleTimeString('zh-CN')}</span>
                    </li>
                  ))}
              </ol>
            )
          ) : (
            <>
              <ol className="diff-list">
                {diff?.hunks.map((hunk) => (
                  <li key={hunk.id} className="diff-hunk">
                    <div className="diff-removed">{hunk.removed.join('\n') || '（无）'}</div>
                    <div className="diff-added">{hunk.added.join('\n') || '（无）'}</div>
                    <button className="btn sm primary" onClick={() => acceptHunk(hunk)}>
                      接受这段
                    </button>
                  </li>
                ))}
              </ol>
              <div className="row">
                <button className="btn sm" onClick={acceptAll}>
                  全部接受
                </button>
                <button className="btn sm ghost" onClick={() => setPending(null)}>
                  放弃
                </button>
              </div>
            </>
          )}
        </aside>
      </div>
    </AppShell>
  );
}
