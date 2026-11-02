import { useCallback, useEffect, useMemo, useState } from 'react';
import type React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ApiError,
  api,
  isGenerateKind,
  type Artifact,
  type GenerateKind,
  type Project,
  type ScenarioPack,
  type ScenarioStage,
} from '../api';
import { AppShell, EmptyState } from '../components/AppShell';
import { Markdown } from '../components/Markdown';
import { ARTIFACT_LABELS, relativeTime } from '../lib/format';

/** Copy for the four video stages; every other pack stage is data-driven. */
const LEGACY: Record<string, { kind: GenerateKind; title: string; placeholder: string; hint: string }> = {
  topic: {
    kind: 'topic-card',
    title: '选题',
    placeholder: '例如：AI 对初级程序员的影响',
    hint: '生成 3 个选题卡，按需求 / 竞争 / 差异 / 可讲性评分',
  },
  research: {
    kind: 'research-notes',
    title: '资料',
    placeholder: '例如：2026 年 AI 编程工具对校招的影响',
    hint: '生成可核查的事实要点与资料缺口',
  },
  shotlist: {
    kind: 'shot-list',
    title: '分镜',
    placeholder: '例如：按已保存的脚本拆 20 个镜头',
    hint: '生成景别、画面、B-roll、上屏字幕与时长',
  },
  package: {
    kind: 'publish-pack',
    title: '包装',
    placeholder: '例如：一期 15 分钟讲 AI 与初级岗位的视频',
    hint: '生成标题候选、简介、标签、章节与封面文案',
  },
};

/**
 * Stage page.
 *
 * The four video stages keep their own URLs, but the page itself is driven by the
 * scenario pack: the label, hint, prompt hint and artifact kind all come from the
 * stage the pack declares. That is what lets a novel's 设定/世界观/大纲 use the same
 * page as 选题/资料 without a route per scenario.
 */
export function StagePage({ stageKey }: { stageKey?: string }): React.ReactElement {
  const { id = '', stageKey: routeStage = '' } = useParams<{ id: string; stageKey: string }>();
  const key = stageKey ?? routeStage;
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [pack, setPack] = useState<ScenarioPack | null>(null);
  const [sources, setSources] = useState('');
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [context, setContext] = useState('');
  const [selected, setSelected] = useState<{ artifact: Artifact; content: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const [projectResult, artifactResult, scenarioResult] = await Promise.all([
        api.getProject(id),
        api.listArtifacts(id),
        typeof api.scenarios === 'function' ? api.scenarios() : Promise.resolve({ scenarios: [] }),
      ]);
      setProject(projectResult.project);
      setPack(scenarioResult.scenarios.find((candidate) => candidate.id === projectResult.project.scenarioId) ?? null);
      setArtifacts(artifactResult.artifacts);
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoaded(true);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const stage: ScenarioStage | undefined = useMemo(
    () => pack?.stages.find((candidate) => candidate.key === key),
    [pack, key],
  );

  // The pack wins; the legacy table is only a fallback for an old daemon that
  // returns no scenarios at all.
  const legacy = LEGACY[key];
  const kind: GenerateKind | null = isGenerateKind(stage?.produces[0]) ? stage.produces[0] : (legacy?.kind ?? null);
  const title = stage?.label ?? legacy?.title ?? key;
  const hint = stage?.hint ?? legacy?.hint ?? '';
  const promptHint = stage?.promptHint ?? '';
  const placeholder = legacy?.placeholder ?? '用一句话说清这一步要做到什么';

  const mine = useMemo(
    () => (kind === null ? [] : artifacts.filter((artifact) => artifact.kind === kind)),
    [artifacts, kind],
  );

  // A different stage is a different artifact kind; drop the old preview so the
  // previous stage's text cannot linger under a new heading.
  useEffect(() => {
    setSelected(null);
  }, [kind]);

  // Adopt the newest saved artifact when there is one. An empty list is *not* a
  // reason to clear the preview: right after a generation the list may still be the
  // pre-generation snapshot, and clearing here would throw away the fresh result.
  useEffect(() => {
    const first = mine[0];
    if (first === undefined) return;
    if (selected?.artifact.id === first.id) return;
    let cancelled = false;
    void api
      .getArtifact(first.id)
      .then((detail) => {
        if (!cancelled) setSelected({ artifact: detail.artifact, content: detail.content });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [mine, selected?.artifact.id]);

  const run = async (): Promise<void> => {
    if (context.trim() === '' || kind === null) return;
    setBusy(true);
    setError(null);
    try {
      const urls = sources
        .split(/\s+/)
        .map((url) => url.trim())
        .filter((url) => url !== '');
      const result = await api.generate(id, kind, context.trim(), urls.length === 0 ? undefined : urls);
      const detail = await api.getArtifact(result.artifact.id);
      setSelected({ artifact: detail.artifact, content: detail.content });
      // Refresh in the background: a failed refresh must not replace the fresh
      // result with an error banner.
      void load();
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const open = async (artifact: Artifact): Promise<void> => {
    try {
      const detail = await api.getArtifact(artifact.id);
      setSelected({ artifact: detail.artifact, content: detail.content });
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    }
  };

  const blocks = useMemo(() => {
    if (selected === null) return [];
    return selected.content
      .split(/^## /m)
      .filter((block) => block.trim() !== '')
      .map((block) => {
        const [heading, ...rest] = block.split('\n');
        return { heading: heading?.replace(/^\d+\.\s*/, '') ?? '', body: rest.join('\n').trim() };
      });
  }, [selected]);

  if (loaded && stage === undefined && legacy === undefined) {
    return (
      <AppShell title={<b>{project?.title ?? id.slice(0, 8)}</b>}>
        <EmptyState
          title="这个阶段不存在"
          hint={`当前场景包没有声明 "${key}"。可能是项目换了场景，或链接来自旧版本。`}
        />
        <button className="btn" onClick={() => navigate(`/p/${id}`)}>
          返回工作台
        </button>
      </AppShell>
    );
  }

  if (loaded && kind === null) {
    return (
      <AppShell title={<b>{project?.title ?? id.slice(0, 8)}</b>}>
        <EmptyState
          title={`${title}没有可生成的产物`}
          hint={hint === '' ? '这一步由卡片或人工完成。' : hint}
        />
        <button className="btn" onClick={() => navigate(`/p/${id}`)}>
          返回工作台
        </button>
      </AppShell>
    );
  }

  return (
    <AppShell
      title={
        <>
          <span>{title}</span>
          <span className="sep">›</span>
          <b>{project?.title ?? id.slice(0, 8)}</b>
        </>
      }
    >
      <div className="page-head">
        <div>
          <h1 className="page-title">{title}</h1>
          <div className="page-sub">
            {project === null ? '加载中…' : `${mine.length} 个版本`}
            <span className="hint"> · {hint === '' ? '按场景包声明的阶段生成' : hint}</span>
          </div>
        </div>
      </div>

      {error !== null && <div className="panel error-panel">{error}</div>}

      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">让 Agent 生成</span>
          <span className="hint">自动携带上游产物，结果按 schema 校验后才落盘</span>
        </div>
        <textarea
          className="input textarea"
          rows={2}
          placeholder={placeholder}
          value={context}
          onChange={(event) => setContext(event.target.value)}
        />
        {promptHint !== '' && <p className="hint">{promptHint}</p>}
        {kind === 'research-notes' && (
          <label className="stack">
            参考链接（每行一个，最多 5 个）
            <textarea
              className="input textarea"
              rows={2}
              aria-label="参考链接"
              placeholder="https://example.com/article"
              value={sources}
              onChange={(event) => setSources(event.target.value)}
            />
            <span className="hint">
              填了链接就会真抓取原文，产出的每条事实都会标出是否能在原文中找到；留空则只靠模型知识，风险自负。
            </span>
          </label>
        )}
        <div className="row">
          <button className="btn primary" disabled={busy || context.trim() === ''} onClick={() => void run()}>
            {busy ? '生成中…' : '开始生成'}
          </button>
          {busy && <span className="hint">模型输出需要几十秒，失败会保留上一版</span>}
        </div>
      </div>

      <div className="stage-layout">
        <section className="panel stage-content">
          <div className="panel-head">
            <span className="panel-title">{selected === null ? '最新结果' : selected.artifact.path}</span>
            {selected !== null && (
              <span className="hint">
                {ARTIFACT_LABELS[selected.artifact.kind] ?? selected.artifact.kind} ·{' '}
                {relativeTime(selected.artifact.createdAt)}
              </span>
            )}
          </div>
          {selected === null ? (
            <EmptyState
              title={`还没有生成过${title}`}
              hint={`在上面写一句方向（${placeholder}），点「开始生成」。上游产物会自动带上。`}
              action={
                <button
                  className="btn primary"
                  disabled={busy || context.trim() === ''}
                  onClick={() => void run()}
                >
                  用当前方向生成
                </button>
              }
            />
          ) : kind === 'topic-card' ? (
            <div className="topic-cards">
              {blocks.map((block) => (
                <article key={block.heading} className="topic-card">
                  <h3>{block.heading}</h3>
                  <Markdown content={block.body} />
                </article>
              ))}
            </div>
          ) : (
            <Markdown content={selected.content} />
          )}
        </section>

        <aside className="panel stage-side">
          <div className="panel-head">
            <span className="panel-title">历史版本</span>
          </div>
          {mine.length === 0 ? (
            <p className="hint">暂无版本。</p>
          ) : (
            <ol className="version-list">
              {mine.map((artifact) => (
                <li key={artifact.id}>
                  <button className="link-btn" onClick={() => void open(artifact)}>
                    {artifact.path.split('/').pop()}
                  </button>
                  <span className="hint">{new Date(artifact.createdAt).toLocaleTimeString('zh-CN')}</span>
                </li>
              ))}
            </ol>
          )}
        </aside>
      </div>
    </AppShell>
  );
}

export function TopicPage(): React.ReactElement {
  return <StagePage stageKey="topic" />;
}

export function ResearchPage(): React.ReactElement {
  return <StagePage stageKey="research" />;
}

export function ShotListPage(): React.ReactElement {
  return <StagePage stageKey="shotlist" />;
}

export function PackagePage(): React.ReactElement {
  return <StagePage stageKey="package" />;
}

/** Any pack-declared generate stage that has no dedicated URL. */
export function GenericStagePage(): React.ReactElement {
  return <StagePage />;
}
