import { useCallback, useEffect, useMemo, useState } from 'react';
import type React from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import {
  ApiError,
  api,
  isGenerateKind,
  type CardLink,
  type EntityCard,
  type EntityField,
  type EntityType,
  type Project,
  type ScenarioPack,
} from '../api';
import { AppShell, EmptyState, PageHead } from '../components/AppShell';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Drawer } from '../components/Drawer';
import { KanbanBoard } from '../components/Kanban';
import { ToastStack, useToasts } from '../components/Toast';
import { relativeTime } from '../lib/format';

const NEWLINE = String.fromCharCode(10);
/** Pseudo-column for cards whose grouping field is blank. */
const UNGROUPED = '__ungrouped__';

/**
 * Scenario-driven card board. One component serves characters, locations,
 * foreshadowing, lessons, guests — anything a pack declares as an entity type.
 * The pack supplies the field schema, so this page never learns what a "novel" is.
 *
 * Editing happens in a drawer rather than inline: an inline form pushed the whole
 * board below the fold on every edit, which made "check three character cards in a
 * row" a scroll fight.
 */
export function EntitiesPage(): React.ReactElement {
  const { id = '', entityType = '' } = useParams<{ id: string; entityType: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [project, setProject] = useState<Project | null>(null);
  const [pack, setPack] = useState<ScenarioPack | null>(null);
  const [cards, setCards] = useState<EntityCard[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [activeType, setActiveType] = useState(entityType);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<EntityCard | null>(null);
  const [draft, setDraft] = useState<{ title: string; fields: Record<string, string>; body: string; tags: string }>({
    title: '',
    fields: {},
    body: '',
    tags: '',
  });
  const [showForm, setShowForm] = useState(false);
  const [query, setQuery] = useState('');
  const [links, setLinks] = useState<CardLink[]>([]);
  const [linkDraft, setLinkDraft] = useState<{ toCardId: string; label: string }>({ toCardId: '', label: '' });
  const [pendingDelete, setPendingDelete] = useState<EntityCard | null>(null);
  const [generating, setGenerating] = useState(false);
  const { toasts, push, dismiss } = useToasts();

  const load = useCallback(async () => {
    try {
      const [projectResult, packResult, entityResult] = await Promise.all([
        api.getProject(id),
        api.scenarios(),
        api.entities(id),
      ]);
      setProject(projectResult.project);
      const own = packResult.scenarios.find((candidate) => candidate.id === projectResult.project.scenarioId) ?? null;
      setPack(own);
      setCards(entityResult.cards);
      setCounts(entityResult.counts);
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setActiveType(entityType);
  }, [entityType]);

  const entityTypes = pack?.entityTypes ?? [];
  const current: EntityType | undefined = useMemo(
    () => entityTypes.find((candidate) => candidate.key === activeType) ?? entityTypes[0],
    [entityTypes, activeType],
  );

  const resetDraft = (): void => {
    setDraft({ title: '', fields: {}, body: '', tags: '' });
    setEditing(null);
    setShowForm(false);
    setLinks([]);
    setLinkDraft({ toCardId: '', label: '' });
  };

  const startCreate = (): void => {
    const seed: Record<string, string> = {};
    for (const field of current?.fields ?? []) seed[field.key] = '';
    setDraft({ title: '', fields: seed, body: '', tags: '' });
    setEditing(null);
    setLinks([]);
    setShowForm(true);
  };

  const startEdit = (card: EntityCard): void => {
    setEditing(card);
    setDraft({ title: card.title, fields: { ...card.fields }, body: card.body, tags: card.tags.join('、') });
    setShowForm(true);
    void api
      .cardLinks(id, card.id)
      .then((result) => setLinks(result.card.links))
      .catch(() => setLinks([]));
  };

  const save = async (): Promise<void> => {
    if (current === undefined) return;
    const title = draft.title.trim() === '' ? (draft.fields[current.titleField] ?? '').trim() : draft.title.trim();
    if (title === '') {
      push('先填一个标题，或填写作为标题的字段', 'error');
      return;
    }
    setBusy(true);
    try {
      const tags = draft.tags
        .split(/[、,，\s]+/)
        .map((tag) => tag.trim())
        .filter((tag) => tag !== '');
      if (editing === null) {
        await api.createEntity(id, { type: current.key, title, fields: draft.fields, body: draft.body, tags });
        push(`已新建${current.label}「${title}」`);
      } else {
        await api.updateEntity(id, editing.id, {
          title,
          fields: draft.fields,
          body: draft.body,
          tags,
          expectedRevision: editing.revision,
        });
        push(`已保存「${title}」`);
      }
      resetDraft();
      await load();
    } catch (cause) {
      const message = cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause);
      // A concurrent edit is not a validation problem: say so in the writer's terms
      // and tell them to reopen, rather than dumping CARD_STALE in the form.
      if (cause instanceof ApiError && cause.status === 409) {
        push('这张卡在你编辑时被改过，已重新载入最新内容，请确认后再保存', 'error');
        await load();
        setError(null);
        return;
      }
      // Validation failures belong next to the form, not in a toast that disappears.
      setError(message);
      push(message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const confirmRemove = async (): Promise<void> => {
    const card = pendingDelete;
    setPendingDelete(null);
    if (card === null) return;
    setBusy(true);
    try {
      await api.deleteEntity(id, card.id);
      push(`已删除「${card.title}」`);
      if (editing?.id === card.id) resetDraft();
      await load();
    } catch (cause) {
      push(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Board drop. The column is the grouping field's value, so moving a card is a
   * field write; the destination index becomes the card's order. Both are applied
   * optimistically and rolled back if the daemon rejects the write, because a card
   * that visibly moved but silently did not persist is worse than a failed drag.
   */
  const moveCard = async (cardId: string, columnValue: string, index: number): Promise<void> => {
    if (current === undefined || boardField === undefined) return;
    const snapshot = cards;
    const card = cards.find((candidate) => candidate.id === cardId);
    if (card === undefined) return;
    const nextValue = columnValue === UNGROUPED ? '' : columnValue;
    const nextFields = { ...card.fields, [boardField.key]: nextValue };
    setCards((previous) =>
      previous.map((candidate) =>
        candidate.id === cardId ? { ...candidate, fields: nextFields, order: index } : candidate,
      ),
    );
    try {
      await api.updateEntity(id, cardId, { fields: nextFields, order: index, expectedRevision: card.revision });
      push(nextValue === '' ? `已移到未分组` : `已移到「${nextValue}」`);
    } catch (cause) {
      setCards(snapshot);
      if (cause instanceof ApiError && cause.status === 409) {
        // Someone else changed this card while it was being dragged. Reload rather
        // than leaving the board showing a position that was never stored.
        await load();
        push('这张卡刚被别处改过，看板已刷新', 'error');
        return;
      }
      push(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause), 'error');
    }
  };

  const addLink = async (): Promise<void> => {
    if (editing === null || linkDraft.toCardId === '') return;
    setBusy(true);
    try {
      await api.linkCards(id, editing.id, {
        toCardId: linkDraft.toCardId,
        ...(linkDraft.label.trim() === '' ? {} : { label: linkDraft.label.trim() }),
      });
      const refreshed = await api.cardLinks(id, editing.id);
      setLinks(refreshed.card.links);
      setLinkDraft({ toCardId: '', label: '' });
      push('已建立关联');
    } catch (cause) {
      push(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setBusy(false);
    }
  };

  const removeLink = async (relationId: string): Promise<void> => {
    if (editing === null) return;
    setBusy(true);
    try {
      await api.unlinkCards(id, relationId);
      const refreshed = await api.cardLinks(id, editing.id);
      setLinks(refreshed.card.links);
      push('已解除关联');
    } catch (cause) {
      push(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Generates the artifact this stage is meant to produce, seeded with the card
   * being edited. Goes through the same /generate endpoint as the stage page, so
   * billing, schema validation and stage advancement all still happen once.
   */
  const generateForCard = async (): Promise<void> => {
    if (pack === null || editing === null) return;
    // Stage keys and entity type keys are different namespaces — the shorts pack
    // has stage `shots` for entity `shot`, the novel pack `chapter` for `chapter`.
    // Match on the entity type the stage owns, and only then on the key.
    const stage =
      pack.stages.find((candidate) => candidate.entityType === activeType) ??
      pack.stages.find((candidate) => candidate.key === activeType);
    const kind = stage?.produces[0];
    if (!isGenerateKind(kind)) {
      push('这个阶段没有可生成的产物类型', 'error');
      return;
    }
    setGenerating(true);
    try {
      const summary = [
        `卡片：${editing.title}`,
        ...Object.entries(editing.fields)
          .filter(([, value]) => value !== '')
          .map(([key, value]) => `${key}：${value}`),
        editing.body === '' ? '' : `备注：${editing.body}`,
      ]
        .filter((line) => line !== '')
        .join(NEWLINE);
      await api.generate(id, kind, [stage?.promptHint ?? '', summary].filter((part) => part !== '').join(NEWLINE));
      push(`已按这张卡片生成${stage?.label ?? ''}产物`);
      await load();
    } catch (cause) {
      push(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setGenerating(false);
    }
  };

  const visible = useMemo(() => {
    if (current === undefined) return [];
    const needle = query.trim().toLowerCase();
    return cards
      .filter((card) => card.type === current.key)
      .filter((card) => {
        if (needle === '') return true;
        const haystack = `${card.title} ${card.body} ${card.tags.join(' ')} ${Object.values(card.fields).join(' ')}`;
        return haystack.toLowerCase().includes(needle);
      });
  }, [cards, current, query]);

  /**
   * Board mode: a stage with view `board` declares a select field to group by. The
   * columns come from the pack (declared values in declared order), and cards whose
   * value is blank land in an explicit 未分组 column instead of disappearing.
   *
   * A `document` stage may carry a board config too — prose and progress are two
   * presentations of the same cards, not two card types.
   */
  const boardMode = searchParams.get('board') === '1';
  const boardStage = useMemo(
    () =>
      pack?.stages.find(
        (stage) => stage.entityType === (current?.key ?? '') && stage.board !== undefined,
      ),
    [pack, current],
  );
  const boardField = useMemo(
    () => current?.fields.find((field) => field.key === boardStage?.board?.groupBy),
    [current, boardStage],
  );
  const columns = useMemo(() => {
    if (boardField === undefined) return [];
    const declared = boardStage?.board?.order ?? [];
    const values = boardField.options.length > 0 ? boardField.options : declared;
    const ordered = [
      ...declared.filter((value) => values.includes(value)),
      ...values.filter((value) => !declared.includes(value)),
    ];
    const extras = [...new Set(visible.map((card) => card.fields[boardField.key] ?? '').filter((value) => value !== ''))]
      .filter((value) => !ordered.includes(value));
    return [...ordered, ...extras];
  }, [boardField, boardStage, visible]);

  const grouped = useMemo(() => {
    if (boardField === undefined) return { columns: [], ungrouped: [] as EntityCard[] };
    const buckets = columns.map((value) => ({
      value,
      cards: visible.filter((card) => (card.fields[boardField.key] ?? '') === value),
    }));
    const ungrouped = visible.filter((card) => (card.fields[boardField.key] ?? '') === '');
    return { columns: buckets, ungrouped };
  }, [boardField, columns, visible]);

  const linkTargets = useMemo(() => {
    const seen = new Set<string>();
    if (editing === null) return [];
    return cards.filter((card) => {
      if (card.id === editing.id || seen.has(card.id)) return false;
      seen.add(card.id);
      return true;
    });
  }, [cards, editing]);

  if (pack === null) {
    return (
      <AppShell title={<b>卡片</b>}>
        <div className="empty">{error ?? '正在读取场景…'}</div>
      </AppShell>
    );
  }

  if (entityTypes.length === 0 || current === undefined) {
    return (
      <AppShell title={<b>{project?.title ?? id.slice(0, 8)}</b>}>
        <EmptyState
          title="这个场景没有卡片"
          hint="当前场景包没有定义实体类型；视频流水线用阶段产物而不是卡片。"
        />
      </AppShell>
    );
  }

  return (
    <AppShell
      title={
        <>
          <span>{current.labelPlural === '' ? current.label : current.labelPlural}</span>
          <span className="sep">›</span>
          <b>{project?.title ?? id.slice(0, 8)}</b>
        </>
      }
    >
      <PageHead
        title={current.labelPlural === '' ? current.label : current.labelPlural}
        subtitle={current.hint === '' ? `共 ${visible.length} 张` : `${visible.length} 张 · ${current.hint}`}
      >
        <button className="btn primary" onClick={startCreate}>
          新建{current.label}
        </button>
      </PageHead>

      <div className="toolbar">
        {entityTypes.length > 1 && (
          <div className="segmented" role="group" aria-label="卡片类型">
            {entityTypes.map((type) => (
              <button
                key={type.key}
                aria-pressed={type.key === current.key}
                onClick={() => {
                  setActiveType(type.key);
                  resetDraft();
                }}
              >
                {type.icon} {type.labelPlural === '' ? type.label : type.labelPlural}
                {counts[type.key] === undefined ? '' : ` ${counts[type.key]}`}
              </button>
            ))}
          </div>
        )}
        <div className="spacer" />
        {boardStage !== undefined && (
          <button
            className="btn sm"
            aria-pressed={boardMode}
            onClick={() => {
              const next = new URLSearchParams(searchParams);
              if (boardMode) next.delete('board');
              else next.set('board', '1');
              setSearchParams(next, { replace: true });
            }}
          >
            {boardMode ? '切到卡片视图' : '切到看板视图'}
          </button>
        )}
        <input
          className="input search"
          placeholder={`搜索${current.label}：标题、标签、字段`}
          aria-label={`搜索${current.label}`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {error !== null && showForm && <div className="panel error-panel">{error}</div>}

      {visible.length === 0 ? (
        <EmptyState
          title={query === '' ? `还没有${current.label}` : '没有匹配的卡片'}
          hint={
            query === ''
              ? current.hint === ''
                ? '点右上角新建一张。'
                : current.hint
              : '换个关键词，或清空搜索。'
          }
          action={
            query === '' ? (
              <button className="btn primary" onClick={startCreate}>
                新建{current.label}
              </button>
            ) : (
              <button className="btn" onClick={() => setQuery('')}>
                清空搜索
              </button>
            )
          }
        />
      ) : boardMode && boardField !== undefined && grouped.columns.length > 0 ? (
        <KanbanBoard
          columns={[
            ...grouped.columns.map((column) => ({
              value: column.value,
              label: column.value,
              cards: column.cards.map((card) => ({
                id: card.id,
                title: card.title,
                summary: current.summaryFields
                  .map((key) => card.fields[key])
                  .filter((value) => value !== undefined && value !== '')
                  .join(' · '),
              })),
            })),
            {
              value: UNGROUPED,
              label: '未分组',
              cards: grouped.ungrouped.map((card) => ({
                id: card.id,
                title: card.title,
                summary: `未设置${boardField.label}`,
              })),
            },
          ]}
          onOpen={(cardId) => {
            const card = cards.find((candidate) => candidate.id === cardId);
            if (card !== undefined) startEdit(card);
          }}
          onMove={(cardId, columnValue, index) => void moveCard(cardId, columnValue, index)}
        />
      ) : (
        <div className="entity-grid">
          {visible.map((card) => (
            <article key={card.id} className="entity-card">
              <div className="entity-card-head">
                <span className="entity-icon" aria-hidden="true">
                  {current.icon}
                </span>
                <h3>{card.title}</h3>
                <span className="hint">{relativeTime(card.updatedAt)}</span>
              </div>
              <dl className="entity-fields">
                {current.summaryFields.map((key) => {
                  const field = current.fields.find((candidate) => candidate.key === key);
                  const value = card.fields[key];
                  if (field === undefined || value === undefined || value === '') return null;
                  return (
                    <div key={key}>
                      <dt>{field.label}</dt>
                      <dd>{value}</dd>
                    </div>
                  );
                })}
              </dl>
              {card.body !== '' && <p className="entity-body">{card.body.slice(0, 160)}</p>}
              {card.tags.length > 0 && (
                <div className="tag-row">
                  {card.tags.map((tag) => (
                    <span key={tag} className="tag">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              <div className="row">
                <button className="btn sm" onClick={() => startEdit(card)}>
                  编辑
                </button>
                <button className="btn sm ghost danger-text" disabled={busy} onClick={() => setPendingDelete(card)}>
                  删除
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      <Drawer
        open={showForm}
        width={editing === null ? 560 : 640}
        title={editing === null ? `新建${current.label}` : `编辑 · ${editing.title}`}
        onClose={resetDraft}
        footer={
          <>
            <button className="btn" onClick={resetDraft}>
              取消
            </button>
            {editing !== null && (
              <button
                className="btn"
                disabled={busy || generating}
                title="用这张卡片的字段作为上下文，调用与阶段页相同的生成接口"
                onClick={() => void generateForCard()}
              >
                {generating ? '生成中…' : '按此卡生成'}
              </button>
            )}
            <button className="btn primary" disabled={busy} onClick={() => void save()}>
              {busy ? '保存中…' : '保存'}
            </button>
          </>
        }
      >
        {editing !== null && (
          <details className="stack relation-block" open>
            <summary>关联（{links.length}）</summary>
            {links.length === 0 ? (
              <p className="hint">还没有关联。可以把角色连到章节、把伏笔连到回收它的那一章。</p>
            ) : (
              <ul className="entity-links">
                {links.map((link) => (
                  <li key={link.relation.id}>
                    <span className="link-label">{link.direction === 'out' ? '指向' : '被引用'}</span>
                    <span>
                      {link.card.title}
                      {link.relation.label === '' ? '' : `（${link.relation.label}）`}
                    </span>
                    <span className="spacer" />
                    <button className="btn sm ghost" onClick={() => void removeLink(link.relation.id)}>
                      解除
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="row">
              <select
                className="input select"
                aria-label="关联到"
                value={linkDraft.toCardId}
                onChange={(event) => setLinkDraft({ ...linkDraft, toCardId: event.target.value })}
              >
                <option value="">选择要关联的卡片…</option>
                {linkTargets.map((card) => (
                  <option key={card.id} value={card.id}>
                    {card.title}
                  </option>
                ))}
              </select>
              <input
                className="input"
                aria-label="关联说明"
                placeholder="关系，例如 出现在 / 回收于"
                value={linkDraft.label}
                onChange={(event) => setLinkDraft({ ...linkDraft, label: event.target.value })}
              />
              <button className="btn" disabled={busy || linkDraft.toCardId === ''} onClick={() => void addLink()}>
                关联
              </button>
            </div>
          </details>
        )}
        <label className="stack">
          卡片标题
          <input
            className="input"
            aria-label="卡片标题"
            value={draft.title}
            placeholder={`留空则用「${current.fields.find((field) => field.key === current.titleField)?.label ?? current.titleField}」`}
            onChange={(event) => {
              const next = event.target.value;
              setDraft((prev) => ({
                ...prev,
                title: next,
                fields: { ...prev.fields, [current.titleField]: prev.fields[current.titleField] ?? next },
              }));
            }}
          />
        </label>
        <div className="field-grid">
          {current.fields.map((field) => (
            <label key={field.key} className={field.wide || field.type === 'longtext' ? 'span-2' : undefined}>
              {field.label}
              {field.required ? ' *' : ''}
              <EntityFieldInput
                field={field}
                value={draft.fields[field.key] ?? ''}
                onChange={(value) => setDraft((prev) => ({ ...prev, fields: { ...prev.fields, [field.key]: value } }))}
              />
            </label>
          ))}
        </div>
        <label className="stack">
          标签（顿号或逗号分隔）
          <input
            className="input"
            aria-label="标签"
            value={draft.tags}
            onChange={(event) => setDraft({ ...draft, tags: event.target.value })}
          />
        </label>
        <label className="stack">
          长文本 / 备注
          <textarea
            className="input textarea"
            aria-label="长文本备注"
            rows={4}
            value={draft.body}
            onChange={(event) => setDraft({ ...draft, body: event.target.value })}
          />
        </label>


      </Drawer>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除这张卡片？"
        message={
          pendingDelete === null
            ? ''
            : `「${pendingDelete.title}」会被删除，指向它的关联也会一并解除。此操作不可撤销。`
        }
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void confirmRemove()}
      />

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </AppShell>
  );
}

function EntityFieldInput({
  field,
  value,
  onChange,
}: {
  field: EntityField;
  value: string;
  onChange: (value: string) => void;
}): React.ReactElement {
  if (field.type === 'longtext') {
    return (
      <textarea
        className="input textarea"
        rows={3}
        aria-label={field.label}
        placeholder={field.placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }
  if (field.type === 'select') {
    return (
      <select className="input select" aria-label={field.label} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">未选择</option>
        {field.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      className="input"
      aria-label={field.label}
      type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
      placeholder={field.placeholder}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
