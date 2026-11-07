import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { useNavigate } from 'react-router-dom';
import { useDaemon } from '../app/DaemonProvider';
import { ApiError, api, apiExtra, type Platform, type Project, type ScenarioPack } from '../api';
import { AppShell, EmptyState, PageHead } from '../components/AppShell';
import { PLATFORM_LABELS, relativeTime } from '../lib/format';

const PLATFORMS: Array<{ value: Platform; label: string }> = [
  { value: 'bilibili', label: 'B 站' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'xiaohongshu', label: '小红书' },
  { value: 'generic', label: '通用' },
];

export function ProjectsPage(): React.ReactElement {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [platform, setPlatform] = useState<Platform>('bilibili');
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'board' | 'list'>('board');
  const [stageFilter, setStageFilter] = useState<string>('all');
  const [showDeleted, setShowDeleted] = useState(false);
  const [deleted, setDeleted] = useState<Project[]>([]);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [scenarios, setScenarios] = useState<ScenarioPack[]>([]);
  const [scenarioId, setScenarioId] = useState('video');
  const navigate = useNavigate();
  const { connection } = useDaemon();
  const requestSeq = useRef(0);
  const needsReload = useRef(false);

  const load = useCallback(async () => {
    // A recovery reload can overlap the in-flight first request. Only the newest
    // result may write state, otherwise a late rejection restores an error that
    // the successful retry already cleared.
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const result = await api.listProjects();
      if (seq !== requestSeq.current) return;
      setProjects(result.projects);
      setError(null);
    } catch (cause) {
      if (seq !== requestSeq.current) return;
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The packaged app starts the daemon as a child process, so the first paint can
  // beat its listen(): the landing page's first request fails with "Failed to
  // fetch". DaemonProvider keeps polling and reaches `online` shortly after, but
  // a page that loaded only once would show that stale red banner forever. Reload
  // on that recovery — and only then, so a healthy start makes one request.
  useEffect(() => {
    if (connection === 'offline') {
      needsReload.current = true;
      return;
    }
    if (connection === 'online' && needsReload.current) {
      needsReload.current = false;
      void load();
    }
  }, [connection, load]);

  // Scenario packs drive the create form and the per-card stage labels.
  useEffect(() => {
    void api
      .scenarios()
      .then((result) => {
        setScenarios(result.scenarios);
        const preferred = result.scenarios.find((pack) => pack.id === result.defaultId) ?? result.scenarios[0];
        if (preferred !== undefined) {
          setScenarioId(preferred.id);
          setPlatform(preferred.defaultPlatform);
        }
      })
      .catch(() => setScenarios([]));
  }, []);

  // Deleted projects are only fetched when the user asks: the default list must
  // stay clean, and a failed fetch must not block the page.
  const loadDeleted = useCallback(async () => {
    try {
      const result = await api.listProjects({ includeDeleted: true });
      setDeleted(result.projects.filter((project) => project.deletedAt !== null));
    } catch {
      setDeleted([]);
    }
  }, []);

  const toggleDeleted = (): void => {
    const next = !showDeleted;
    setShowDeleted(next);
    if (next) void loadDeleted();
  };

  const restore = async (project: Project): Promise<void> => {
    setRestoring(project.id);
    try {
      await apiExtra.restoreProject(project.id);
      await loadDeleted();
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRestoring(null);
    }
  };

  const create = async (): Promise<void> => {
    if (title.trim() === '') return;
    setCreating(true);
    try {
      const created = await api.createProject(title.trim(), platform, scenarioId);
      setTitle('');
      await load();
      navigate(`/p/${created.project.id}`);
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  };

  // Filter chips cover every stage of every scenario in use plus the stages the
  // projects actually sit on, so the bar is never a single lonely chip.
  const stageOptions = useMemo(() => {
    const seen = new Map<string, string>();
    const packIds = new Set(projects.map((project) => project.scenarioId));
    for (const pack of scenarios) {
      if (!packIds.has(pack.id)) continue;
      for (const stage of pack.stages) {
        if (!seen.has(stage.key)) seen.set(stage.key, stage.label);
      }
    }
    for (const project of projects) {
      if (project.stage === '') continue;
      if (seen.has(project.stage)) continue;
      const pack = scenarios.find((candidate) => candidate.id === project.scenarioId);
      const stage = pack?.stages.find((candidate) => candidate.key === project.stage);
      seen.set(project.stage, stage?.label ?? project.stage);
    }
    return [...seen.entries()].map(([key, label]) => ({ key, label }));
  }, [projects, scenarios]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return projects.filter((project) => {
      if (stageFilter !== 'all' && project.stage !== stageFilter) return false;
      if (needle === '') return true;
      return `${project.title} ${project.description} ${(project.tags ?? []).join(' ')}`.toLowerCase().includes(needle);
    });
  }, [projects, query, stageFilter]);

  return (
    <AppShell title={<b>项目</b>}>
      <PageHead
        title="项目"
        subtitle={loading ? '加载中…' : `${projects.length} 个进行中 · 每个项目是一条完整的制作流水线`}
      >
        <div className="create-row">
          <select
            className="input select"
            value={scenarioId}
            onChange={(event) => {
              const next = event.target.value;
              setScenarioId(next);
              const pack = scenarios.find((candidate) => candidate.id === next);
              if (pack !== undefined) setPlatform(pack.defaultPlatform);
            }}
            aria-label="场景"
          >
            {scenarios.map((pack) => (
              <option key={pack.id} value={pack.id}>
                {pack.icon} {pack.name}
              </option>
            ))}
          </select>
          <select
            className="input select"
            value={platform}
            onChange={(event) => setPlatform(event.target.value as Platform)}
            aria-label="平台"
          >
            {PLATFORMS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
          <input
            className="input"
            placeholder="新项目标题"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void create();
            }}
          />
          <button className="btn primary" disabled={creating || title.trim() === ''} onClick={() => void create()}>
            {creating ? '创建中…' : '新建项目'}
          </button>
        </div>
      </PageHead>

      {error !== null && <div className="panel error-panel">{error}</div>}

      <div className="toolbar">
        <div className="segmented chip-scroll" role="group" aria-label="阶段筛选">
          <button aria-pressed={stageFilter === 'all'} onClick={() => setStageFilter('all')}>
            全部
          </button>
          {stageOptions.map((stage) => (
            <button key={stage.key} aria-pressed={stageFilter === stage.key} onClick={() => setStageFilter(stage.key)}>
              {stage.label}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <input
          className="input search"
          placeholder="搜索标题、简介、标签"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="搜索项目"
        />
        <button className="btn sm" aria-pressed={showDeleted} onClick={toggleDeleted}>
          {showDeleted ? '隐藏已删除' : '已删除'}
        </button>
        <div className="segmented" role="group" aria-label="视图">
          <button aria-pressed={view === 'board'} onClick={() => setView('board')}>
            卡片
          </button>
          <button aria-pressed={view === 'list'} onClick={() => setView('list')}>
            列表
          </button>
        </div>
      </div>

      {loading && visible.length === 0 ? (
        // First paint before the daemon answers: three breathing placeholders so
        // the landing page never flashes an empty state that isn't real.
        <div className="project-grid" aria-hidden="true">
          {[0, 1, 2].map((index) => (
            <div key={index} className="project-card skeleton" />
          ))}
        </div>
      ) : visible.length === 0 && !loading ? (
        <EmptyState
          title={projects.length === 0 ? '还没有项目' : '没有匹配的项目'}
          hint={
            projects.length === 0
              ? '输入标题新建一个，从选题开始走完整条流水线。所有素材留在本机。'
              : '换个关键词或清空筛选试试。'
          }
          action={
            <button
              className="btn"
              onClick={() => {
                setQuery('');
                setStageFilter('all');
              }}
            >
              清空筛选
            </button>
          }
        />
      ) : view === 'board' ? (
        <div className="project-grid">
          {visible.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              pack={scenarios.find((candidate) => candidate.id === project.scenarioId)}
              onOpen={() => navigate(`/p/${project.id}`)}
            />
          ))}
        </div>
      ) : (
        <div className="ledger">
          <div className="ledger-head">
            <span>项目</span>
            <span>阶段</span>
            <span>更新</span>
          </div>
          {visible.map((project) => {
            const pack = scenarios.find((candidate) => candidate.id === project.scenarioId);
            const stages = pack?.stages ?? [];
            const currentIndex = stages.findIndex((stage) => stage.key === project.stage);
            return (
              <button key={project.id} className="ledger-row" onClick={() => navigate(`/p/${project.id}`)}>
                <span className="proj-title">{project.title}</span>
                <span className="stages" aria-label={`阶段 ${project.stage}`}>
                  {stages.map((stage, index) => (
                    <i key={stage.key} className={index < currentIndex ? 'done' : index === currentIndex ? 'now' : ''} />
                  ))}
                </span>
                <span className="hint">{relativeTime(project.updatedAt)}</span>
              </button>
            );
          })}
        </div>
      )}

      {showDeleted && (
        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">已删除项目</span>
            <span className="hint">软删除，可恢复；文件与产物都还在本机</span>
          </div>
          {deleted.length === 0 ? (
            <p className="hint">没有已删除的项目。</p>
          ) : (
            <ul className="file-list">
              {deleted.map((project) => (
                <li key={project.id}>
                  <span className="mono">{project.title}</span>
                  <span className="hint">{relativeTime(project.deletedAt)}</span>
                  <span className="spacer" />
                  <button
                    className="btn sm"
                    disabled={restoring === project.id}
                    onClick={() => void restore(project)}
                  >
                    {restoring === project.id ? '恢复中…' : '恢复'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </AppShell>
  );
}

function ProjectCard({
  project,
  pack,
  onOpen,
}: {
  project: Project;
  pack: ScenarioPack | undefined;
  onOpen: () => void;
}): React.ReactElement {
  const stages = pack?.stages ?? [];
  const current = Math.max(0, stages.findIndex((stage) => stage.key === project.stage));
  const progress = stages.length <= 1 ? 0 : Math.max(0, Math.round((current / (stages.length - 1)) * 100));
  return (
    <article
      className="project-card"
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="project-card-top">
        <span className="platform-tag">{PLATFORM_LABELS[project.platform] ?? project.platform}</span>
        <span className="hint">{relativeTime(project.updatedAt)}</span>
      </div>
      <h3 className="project-card-title">{project.title}</h3>
      <p className="project-card-desc">
        {project.description !== ''
          ? project.description
          : pack === undefined
            ? '还没有简介'
            : `${pack.name} · ${stages[current]?.hint ?? ''}`}
      </p>
      {(project.tags ?? []).length > 0 && (
        <div className="tag-row">
          {(project.tags ?? []).slice(0, 4).map((tag) => (
            <span key={tag} className="tag">
              {tag}
            </span>
          ))}
        </div>
      )}
      <div className="project-progress" aria-label={`进度 ${progress}%`}>
        <span style={{ width: `${progress}%` }} />
      </div>
      <div className="project-card-foot">
        <span className="badge">
          {pack === undefined ? project.stage : `${pack.icon} ${stages[current]?.label ?? project.stage}`}
        </span>
        <span className="hint">
          阶段 {current + 1}/{Math.max(1, stages.length)}
        </span>
        <span className="spacer" />
        <span className="card-cta">继续 →</span>
      </div>
    </article>
  );
}
