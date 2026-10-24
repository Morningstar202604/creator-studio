import { useCallback, useEffect, useState } from 'react';
import type React from 'react';
import { useParams } from 'react-router-dom';
import { ApiError, api, apiExtra, type Project } from '../api';
import { AppShell } from '../components/AppShell';
import { ARTIFACT_LABELS, relativeTime } from '../lib/format';

type Hit = Awaited<ReturnType<typeof apiExtra.memorySearch>>['hits'][number];

const VIA_LABEL: Record<Hit['via'], string> = {
  lexical: '关键词命中',
  vector: '语义相近',
  hybrid: '两种都命中',
};

/**
 * Memory search over everything this project has produced, plus user-authored
 * notes. It is a retrieval surface, not a chat box: every hit shows its source and
 * the match reason so the user can judge the evidence before copying it.
 */
export function MemoryPanel({ project }: { project: Project }): React.ReactElement {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [meta, setMeta] = useState<{ embedder: string; neural: boolean; indexed: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ content: string; sourceRef: string } | null>(null);

  const search = useCallback(async (): Promise<void> => {
    if (query.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiExtra.memorySearch(query.trim(), project.id);
      setHits(result.hits);
      setMeta({ embedder: result.embedder, neural: result.neural, indexed: result.indexed });
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [query, project.id]);

  const reindex = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiExtra.memoryReindex(project.id);
      setMeta((current) => ({
        embedder: current?.embedder ?? 'hash-ngram',
        neural: current?.neural ?? false,
        indexed: result.totalChunks,
      }));
      setHits([]);
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">项目记忆检索</span>
        <span className="hint">
          {meta === null
            ? '跨版本、跨阶段检索本项目已产出的内容'
            : `${meta.indexed} 个切片 · ${meta.neural ? '模型向量' : '本地词法向量'}（${meta.embedder}）`}
        </span>
      </div>
      <div className="row">
        <input
          className="input search"
          placeholder="例如：土地出让金、留存率下滑的原因"
          aria-label="检索项目记忆"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void search();
          }}
        />
        <button className="btn primary" disabled={busy || query.trim() === ''} onClick={() => void search()}>
          {busy ? '检索中…' : '检索'}
        </button>
        <button className="btn ghost" disabled={busy} onClick={() => void reindex()}>
          重建索引
        </button>
      </div>

      {error !== null && <p className="error-text">{error}</p>}

      {hits.length === 0 ? (
        <p className="hint">输入关键词检索；短词走子串匹配，长句会同时做语义相近匹配。</p>
      ) : (
        <ul className="memory-list">
          {hits.map((hit) => (
            <li key={hit.id}>
              <button className="memory-hit" onClick={() => setPreview({ content: hit.content, sourceRef: hit.sourceRef })}>
                <span className={`badge ${hit.via === 'lexical' ? 'info' : hit.via === 'vector' ? 'ok' : 'warn'}`}>
                  {VIA_LABEL[hit.via]}
                </span>
                <span className="memory-kind">{ARTIFACT_LABELS[hit.kind] ?? hit.kind}</span>
                <span className="memory-snippet">{hit.content.slice(0, 120)}</span>
                <span className="hint mono">#{hit.chunkIndex}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {preview !== null && (
        <div className="memory-preview">
          <div className="row">
            <span className="hint mono">{preview.sourceRef}</span>
            <span className="spacer" />
            <button className="btn sm ghost" onClick={() => setPreview(null)}>
              收起
            </button>
          </div>
          <pre className="output preview-text">{preview.content}</pre>
        </div>
      )}
    </div>
  );
}

/**
 * Global memory search used by the library page: same API, all projects, so an
 * idea from one video can be found while working on another.
 */
export function useMemorySearch(projectId?: string): {
  query: string;
  setQuery: (value: string) => void;
  hits: Hit[];
  meta: { embedder: string; neural: boolean; indexed: number } | null;
  busy: boolean;
  error: string | null;
  run: () => Promise<void>;
} {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [meta, setMeta] = useState<{ embedder: string; neural: boolean; indexed: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (): Promise<void> => {
    if (query.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiExtra.memorySearch(query.trim(), projectId);
      setHits(result.hits);
      setMeta({ embedder: result.embedder, neural: result.neural, indexed: result.indexed });
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [query, projectId]);

  return { query, setQuery, hits, meta, busy, error, run };
}

export function MemoryHits({ hits }: { hits: Hit[] }): React.ReactElement {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ul className="memory-list">
      {hits.map((hit) => (
        <li key={hit.id}>
          <button className="memory-hit" onClick={() => setOpen(open === hit.id ? null : hit.id)}>
            <span className={`badge ${hit.via === 'lexical' ? 'info' : hit.via === 'vector' ? 'ok' : 'warn'}`}>
              {VIA_LABEL[hit.via]}
            </span>
            <span className="memory-kind">{ARTIFACT_LABELS[hit.kind] ?? hit.kind}</span>
            <span className="memory-snippet">{hit.content.slice(0, 110)}</span>
            <span className="hint">{relativeTime(null)}</span>
          </button>
          {open === hit.id && <pre className="output preview-text">{hit.content}</pre>}
        </li>
      ))}
    </ul>
  );
}

export function ProjectMemoryRoute(): React.ReactElement {
  const { id = '' } = useParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);

  useEffect(() => {
    void api
      .getProject(id)
      .then((result) => setProject(result.project))
      .catch(() => setProject(null));
  }, [id]);

  return (
    <AppShell
      title={
        <>
          <span>记忆</span>
          <span className="sep">›</span>
          <b>{project?.title ?? id.slice(0, 8)}</b>
        </>
      }
    >
      <div className="page-head">
        <div>
          <h1 className="page-title">记忆</h1>
          <div className="page-sub">检索本项目所有产物切片，结果带来源与命中方式</div>
        </div>
      </div>
      {project !== null && <MemoryPanel project={project} />}
    </AppShell>
  );
}
