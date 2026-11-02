import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ApiError,
  api,
  type DocumentConfig,
  type EntityCard,
  type EntityField,
  type Project,
  type ScenarioPack,
} from '../api';
import { AppShell, EmptyState, PageHead } from '../components/AppShell';
import { ToastStack, useToasts } from '../components/Toast';
import { relativeTime } from '../lib/format';

/**
 * The writing desk.
 *
 * Cards stay the source of truth — a chapter is a card whose body holds the prose.
 * This page is a projection of that card type into something a writer can actually
 * use: a chapter rail, a distraction-free editor, a live word count and a Word
 * export. Because the text never leaves the card, the editor, the board, the graph
 * and the exported book can never disagree.
 *
 * Text is plain Markdown, not a rich-text document model: a portable file that
 * survives any editor is worth more than inline bold buttons, and it keeps the
 * export path to one well-understood format.
 */

const AUTOSAVE_MS = 900;

/** Counts CJK characters plus Latin words the way a writer counts them. */
export function countWords(text: string): number {
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z0-9]+/g) ?? []).length;
  return cjk + latin;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~`>]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
}

export function DocumentPage(): React.ReactElement {
  const { id = '', entityType = '' } = useParams<{ id: string; entityType: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [project, setProject] = useState<Project | null>(null);
  const [pack, setPack] = useState<ScenarioPack | null>(null);
  const [cards, setCards] = useState<EntityCard[]>([]);
  const [config, setConfig] = useState<(DocumentConfig & { stage: string; label: string }) | null>(null);
  const [fields, setFields] = useState<EntityField[]>([]);
  // The entity type's own title field (e.g. chapter.title) is a required *field*,
  // separate from the document config's optional titleField override. Creating a
  // card without it fails validation, so it is filled from the generated name.
  const [typeTitleField, setTypeTitleField] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string>(searchParams.get('chapter') ?? '');
  const [text, setText] = useState('');
  const [savedText, setSavedText] = useState('');
  const [status, setStatus] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [lastExport, setLastExport] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const { toasts, push, dismiss } = useToasts();
  const timer = useRef<number | null>(null);
  const pendingCard = useRef<string>('');

  const load = useCallback(async () => {
    try {
      const [projectResult, packResult, cardsResult] = await Promise.all([
        api.getProject(id),
        api.scenarios(),
        api.entities(id, entityType),
      ]);
      setProject(projectResult.project);
      const own = packResult.scenarios.find((candidate) => candidate.id === projectResult.project.scenarioId) ?? null;
      setPack(own);
      setCards(cardsResult.cards);
      setConfig(cardsResult.document ?? null);
      const type = own?.entityTypes.find((candidate) => candidate.key === entityType);
      setFields(type?.fields ?? []);
      setTypeTitleField(type?.titleField ?? null);
      setError(null);
      setActiveId((previous) => {
        if (previous !== '' && cardsResult.cards.some((card) => card.id === previous)) return previous;
        return cardsResult.cards[0]?.id ?? '';
      });
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    }
  }, [id, entityType]);

  useEffect(() => {
    void load();
  }, [load]);

  const bodyField = config?.bodyField;
  const titleField = config?.titleField;
  const orderField = config?.orderField;

  const cardText = useCallback(
    (card: EntityCard): string => (bodyField === undefined ? card.body : (card.fields[bodyField] ?? '')),
    [bodyField],
  );

  const active = useMemo(() => cards.find((card) => card.id === activeId) ?? null, [cards, activeId]);
  // Keyboard shortcuts are registered once; these refs keep them pointing at the
  // current chapter without re-binding the listener on every keystroke.
  const activeRef = useRef<EntityCard | null>(null);
  const textRef = useRef('');
  activeRef.current = active;
  textRef.current = text;

  // Switching chapters must flush the old text, otherwise the debounce would write
  // the previous chapter into the newly selected card. The effect keys on the id
  // only: a save response also replaces the card object, and re-syncing the editor
  // then would throw away whatever the writer typed while the request was in flight.
  const loadedId = useRef('');
  useEffect(() => {
    if (active === null) {
      loadedId.current = '';
      setText('');
      setSavedText('');
      setStatus('idle');
      return;
    }
    if (loadedId.current === active.id) return;
    loadedId.current = active.id;
    const next = cardText(active);
    setText(next);
    setSavedText(next);
    setStatus('saved');
  }, [active, cardText]);

  const flush = useCallback(
    async (cardId: string, value: string): Promise<void> => {
      if (cardId === '') return;
      setStatus('saving');
      try {
        const card = cards.find((candidate) => candidate.id === cardId);
        if (card === undefined) return;
        await api.updateEntity(id, cardId, {
          ...(bodyField === undefined ? { body: value } : { fields: { ...card.fields, [bodyField]: value } }),
        });
        setSavedText(value);
        setStatus('saved');
        setCards((previous) =>
          previous.map((candidate) =>
            candidate.id === cardId
              ? {
                  ...candidate,
                  ...(bodyField === undefined ? { body: value } : { fields: { ...candidate.fields, [bodyField]: value } }),
                }
              : candidate,
          ),
        );
      } catch (cause) {
        setStatus('error');
        setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
      }
    },
    [bodyField, cards, id],
  );

  const onChange = (value: string): void => {
    setText(value);
    setStatus(value === savedText ? 'saved' : 'dirty');
    if (active === null) return;
    pendingCard.current = active.id;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const target = pendingCard.current;
      timer.current = null;
      void flush(target, value);
    }, AUTOSAVE_MS);
  };

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  // Ctrl/Cmd+S is what every writer's hands do; intercept it so the browser does
  // not open its save dialog over a page that already autosaves.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (activeRef.current !== null) void flush(activeRef.current.id, textRef.current);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flush]);

  const saveNow = (): void => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (active !== null) void flush(active.id, text);
  };

  const createChapter = async (): Promise<void> => {
    const nextNumber = String(
      cards.reduce((max, card) => Math.max(max, Number.parseInt(card.fields[orderField ?? ''] ?? '', 10) || 0), 0) + 1,
    );
    setCreating(true);
    try {
      const title = `第${nextNumber}章`;
      const created = await api.createEntity(id, {
        type: entityType,
        title,
        fields: {
          ...(titleField === undefined ? {} : { [titleField]: title }),
          ...(typeTitleField === null ? {} : { [typeTitleField]: title }),
          ...(orderField === undefined ? {} : { [orderField]: nextNumber }),
        },
      });
      await load();
      setActiveId(created.card.id);
      push(`已新建「${title}」`);
    } catch (cause) {
      push(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setCreating(false);
    }
  };

  const exportManuscript = async (): Promise<void> => {
    setExporting(true);
    try {
      const result = await api.exportManuscript(id);
      // Offer the file immediately: the daemon wrote it to the workspace, but a
      // writer expects the usual "save as" behaviour, not a path to copy.
      const name = result.file.split('/').pop() ?? 'manuscript.docx';
      const anchor = document.createElement('a');
      anchor.href = api.manuscriptDownloadUrl(id, name);
      anchor.download = name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setLastExport(name);
      push(`已导出 Word：${result.chapters} 章 / ${result.chars} 字`);
    } catch (cause) {
      push(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setExporting(false);
    }
  };

  const ordered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const list = needle === '' ? cards : cards.filter((card) => card.title.toLowerCase().includes(needle));
    return [...list].sort((a, b) => {
      const left = Number.parseInt(a.fields[orderField ?? ''] ?? '', 10);
      const right = Number.parseInt(b.fields[orderField ?? ''] ?? '', 10);
      if (!Number.isNaN(left) && !Number.isNaN(right) && left !== right) return left - right;
      return a.order - b.order;
    });
  }, [cards, filter, orderField]);

  const words = useMemo(() => countWords(stripMarkdown(text)), [text]);
  const totalWords = useMemo(
    () => cards.reduce((sum, card) => sum + countWords(stripMarkdown(cardText(card))), 0),
    [cards, cardText],
  );

  // A status select is the closest thing a pack gives us to "how done is this
  // chapter"; when the pack has none the bar falls back to plain text lengths.
  const statusField = useMemo(
    () => fields.find((field) => field.type === 'select' && field.key === 'status'),
    [fields],
  );
  const targetField = useMemo(
    () => fields.find((field) => field.type === 'number' && field.key === 'word_target'),
    [fields],
  );
  const chapterWords = useCallback(
    (card: EntityCard) => countWords(stripMarkdown(cardText(card))),
    [cardText],
  );
  const activeTarget = targetField === undefined ? 0 : Number.parseInt(active?.fields[targetField.key] ?? '', 10) || 0;
  const bookTarget = useMemo(
    () =>
      cards.reduce((sum, card) => {
        const target = targetField === undefined ? 0 : Number.parseInt(card.fields[targetField.key] ?? '', 10) || 0;
        return sum + target;
      }, 0),
    [cards, targetField],
  );
  const statusOrder = statusField?.options ?? [];
  const maxChapterWords = useMemo(
    () => Math.max(1, ...cards.map((card) => countWords(stripMarkdown(cardText(card))))),
    [cards, cardText],
  );

  useEffect(() => {
    if (active === null) return;
    const next = new URLSearchParams(searchParams);
    next.set('chapter', active.id);
    setSearchParams(next, { replace: true });
    // Only the chapter id belongs in the URL; rewriting on every keystroke would
    // spam history.
  }, [active?.id]);

  if (config === null && pack !== null) {
    return (
      <AppShell title={<b>{project?.title ?? id.slice(0, 8)}</b>}>
        <EmptyState
          title="这个场景没有写作阶段"
          hint="写作台需要场景包声明一个 view 为 document 的阶段。可以先在卡片页里编辑内容。"
        />
        <button className="btn" onClick={() => navigate(`/p/${id}/cards/${entityType}`)}>
          去卡片页
        </button>
      </AppShell>
    );
  }

  return (
    <AppShell
      title={
        <>
          <span>{config?.label ?? '写作台'}</span>
          <span className="sep">›</span>
          <b>{project?.title ?? id.slice(0, 8)}</b>
        </>
      }
    >
      <PageHead
        title="写作台"
        subtitle={`${config?.label ?? '章节'} · ${cards.length} 章 · 全书 ${totalWords.toLocaleString('zh-CN')} 字 · 自动保存`}
      >
        <button className="btn" onClick={() => void load()}>
          刷新
        </button>
        <button className="btn" onClick={() => navigate(`/p/${id}/timeline`)}>
          时间轴
        </button>
        <button className="btn primary" disabled={exporting || cards.length === 0} onClick={() => void exportManuscript()}>
          {exporting ? '导出中…' : '导出 Word'}
        </button>
      </PageHead>

      {error !== null && <div className="panel error-panel">{error}</div>}

      <div className="desk">
        <aside className="desk-rail">
          <div className="desk-rail-head">
            <span>章节</span>
            <button className="btn sm" disabled={creating} onClick={() => void createChapter()}>
              新建
            </button>
          </div>
          <input
            className="input search"
            aria-label="筛选章节"
            placeholder="筛选章节…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <ol className="desk-list">
            {ordered.map((card) => {
              const number = card.fields[orderField ?? ''] ?? '';
              const cardWords = countWords(stripMarkdown(cardText(card)));
              return (
                <li key={card.id}>
                  <button
                    className={`desk-item${card.id === activeId ? ' active' : ''}`}
                    aria-current={card.id === activeId ? 'true' : undefined}
                    onClick={() => setActiveId(card.id)}
                  >
                    <span className="desk-item-title">
                      <i
                        className={`status-dot ${statusTone(statusField === undefined ? '' : (card.fields[statusField.key] ?? ''), statusOrder)}`}
                        aria-hidden="true"
                      />
                      {number === '' ? '' : <span className="desk-item-num">{number}</span>}
                      {card.title}
                    </span>
                    <span className="hint">
                      {cardWords === 0 ? '空白' : `${cardWords} 字`}
                      {targetField === undefined
                        ? ''
                        : ` / ${Number.parseInt(card.fields[targetField.key] ?? '', 10) || 0}`}
                    </span>
                  </button>
                </li>
              );
            })}
            {ordered.length === 0 && <li className="hint">还没有章节，点「新建」开始。</li>}
          </ol>
        </aside>

        <section className="desk-doc">
          {active === null ? (
            <EmptyState title="选一章开始写" hint="左边是章节列表；每章的正文都存在卡片里。" />
          ) : (
            <>
              <div className="desk-title-row">
                <h2>{active.title}</h2>
                <span className={`desk-status ${status}`}>
                  {status === 'saving'
                    ? '保存中…'
                    : status === 'dirty'
                      ? '未保存'
                      : status === 'error'
                        ? '保存失败'
                        : '已保存'}
                </span>
              </div>
              <div className="desk-meta">
                <span>{words.toLocaleString('zh-CN')} 字</span>
                <span>更新于 {relativeTime(active.updatedAt)}</span>
                {fields
                  .filter((field) => field.key !== bodyField && field.key !== titleField && field.key !== orderField)
                  .slice(0, 3)
                  .map((field) => {
                    const value = active.fields[field.key];
                    if (value === undefined || value === '') return null;
                    return (
                      <span key={field.key} className="hint">
                        {field.label}：{value}
                      </span>
                    );
                  })}
              </div>
              <textarea
                className="input desk-editor"
                aria-label={`${active.title} 正文`}
                placeholder="从这里开始写。支持 Markdown：## 小标题、**重点**、> 引用。"
                value={text}
                onChange={(event) => onChange(event.target.value)}
                onBlur={saveNow}
                spellCheck={false}
              />
              <div className="desk-footer">
                <span className="hint">Ctrl/⌘ + S 手动保存 · 切章自动保存</span>
                <span className="spacer" />
                <button className="btn sm" onClick={saveNow} disabled={status === 'saving'}>
                  保存
                </button>
              </div>
            </>
          )}
        </section>

        <aside className="desk-side">
          <div className="panel-head">
            <span className="panel-title">本章</span>
            {statusField !== undefined && active !== null && (
              <span className="badge">{active.fields[statusField.key] || '未设置'}</span>
            )}
          </div>
          {activeTarget > 0 ? (
            <div className="ring-wrap">
              <ProgressRing value={words} max={activeTarget} />
              <div className="ring-legend">
                <span>
                  <b>{words.toLocaleString('zh-CN')}</b> / {activeTarget.toLocaleString('zh-CN')} 字
                </span>
                <span className="hint">
                  {words >= activeTarget ? '已达到目标' : `还差 ${(activeTarget - words).toLocaleString('zh-CN')} 字`}
                </span>
              </div>
            </div>
          ) : (
            <div className="ring-legend">
              <span>
                <b>{words.toLocaleString('zh-CN')}</b> 字
              </span>
              <span className="hint">{cards.length === 0 ? '先新建一章' : '卡片未设置目标字数'}</span>
            </div>
          )}
          <dl className="desk-stats">
            <div>
              <dt>段落</dt>
              <dd>{text.split(/\n{2,}/).filter((part) => part.trim() !== '').length}</dd>
            </div>
            <div>
              <dt>全书</dt>
              <dd>{totalWords.toLocaleString('zh-CN')}</dd>
            </div>
          </dl>
          {bookTarget > 0 && (
            <div className="book-progress">
              <div className="book-progress-head">
                <span>全书进度</span>
                <span className="hint">{Math.round((totalWords / bookTarget) * 100)}%</span>
              </div>
              <div className="book-progress-track">
                <i style={{ width: `${Math.min(100, Math.round((totalWords / bookTarget) * 100))}%` }} />
              </div>
            </div>
          )}
          {ordered.length > 0 && (
            <div className="book-bars-head">
              <span>章节篇幅</span>
              <span className="hint">越高越长</span>
            </div>
          )}
          {ordered.length > 0 && (
            <div className="book-bars" aria-label="章节篇幅与状态">
              {ordered.map((card) => {
                const count = chapterWords(card);
                const status = statusField === undefined ? '' : (card.fields[statusField.key] ?? '');
                const height = Math.max(12, Math.round((count / Math.max(1, maxChapterWords)) * 100));
                return (
                  <button
                    key={card.id}
                    type="button"
                    className={`book-bar ${statusTone(status, statusOrder)}${card.id === activeId ? ' active' : ''}`}
                    style={{ height: `${height}%` }}
                    title={`${card.title} · ${count} 字${status === '' ? '' : ` · ${status}`}`}
                    aria-label={`跳到 ${card.title}`}
                    onClick={() => setActiveId(card.id)}
                  />
                );
              })}
            </div>
          )}
          {statusOrder.length > 0 && ordered.length > 0 && (
            <div className="book-legend">
              {statusOrder.map((value) => (
                <span key={value} className="legend-item">
                  <i className={`dot ${statusTone(value, statusOrder)}`} aria-hidden="true" />
                  {value}
                </span>
              ))}
            </div>
          )}
        </aside>
      </div>

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </AppShell>
  );
}

/** Progress ring for the current chapter; SVG so it scales with the panel. */
function ProgressRing({ value, max }: { value: number; max: number }): React.ReactElement {
  const ratio = max <= 0 ? 0 : Math.min(1, value / max);
  const radius = 34;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg className="ring" viewBox="0 0 84 84" role="img" aria-label={`本章进度 ${Math.round(ratio * 100)}%`}>
      <circle className="ring-track" cx="42" cy="42" r={radius} />
      <circle
        className="ring-value"
        cx="42"
        cy="42"
        r={radius}
        strokeDasharray={`${circumference * ratio} ${circumference}`}
        transform="rotate(-90 42 42)"
      />
      <text className="ring-text" x="42" y="47" textAnchor="middle">
        {Math.round(ratio * 100)}%
      </text>
    </svg>
  );
}

/** Maps a status value to a tone class; unknown values get a neutral tone. */
function statusTone(value: string, order: string[]): string {
  if (value === '') return 'tone-empty';
  const index = order.indexOf(value);
  if (index === -1) return 'tone-other';
  if (index === order.length - 1) return 'tone-done';
  if (index === 0) return 'tone-todo';
  return 'tone-doing';
}
