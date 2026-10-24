import { useCallback, useEffect, useMemo, useState } from 'react';
import type React from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api, type Platform, type Project } from '../api';
import { AppShell, EmptyState, PageHead } from '../components/AppShell';
import { PLATFORM_LABELS, STAGES, relativeTime, stageIndex } from '../lib/format';

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
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.listProjects();
      setProjects(result.projects);
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (): Promise<void> => {
    if (title.trim() === '') return;
    setCreating(true);
    try {
      const created = await api.createProject(title.trim(), platform);
      setTitle('');
      await load();
      navigate(`/p/${created.project.id}`);
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  };

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
        <div className="segmented" role="group" aria-label="阶段筛选">
          <button aria-pressed={stageFilter === 'all'} onClick={() => setStageFilter('all')}>
            全部
          </button>
          {STAGES.slice(0, 6).map((stage) => (
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
        <div className="segmented" role="group" aria-label="视图">
          <button aria-pressed={view === 'board'} onClick={() => setView('board')}>
            卡片
          </button>
          <button aria-pressed={view === 'list'} onClick={() => setView('list')}>
            列表
          </button>
        </div>
      </div>

      {visible.length === 0 && !loading ? (
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
            <ProjectCard key={project.id} project={project} onOpen={() => navigate(`/p/${project.id}`)} />
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
            const currentIndex = stageIndex(project.stage);
            return (
              <button key={project.id} className="ledger-row" onClick={() => navigate(`/p/${project.id}`)}>
                <span className="proj-title">{project.title}</span>
                <span className="stages" aria-label={`阶段 ${project.stage}`}>
                  {STAGES.map((stage, index) => (
                    <i key={stage.key} className={index < currentIndex ? 'done' : index === currentIndex ? 'now' : ''} />
                  ))}
                </span>
                <span className="hint">{relativeTime(project.updatedAt)}</span>
              </button>
            );
          })}
        </div>
      )}
    </AppShell>
  );
}

function ProjectCard({ project, onOpen }: { project: Project; onOpen: () => void }): React.ReactElement {
  const current = stageIndex(project.stage);
  const progress = Math.max(0, Math.round((current / (STAGES.length - 1)) * 100));
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
      <p className="project-card-desc">{project.description === '' ? '还没有简介' : project.description}</p>
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
        <span className="badge">{STAGES[current]?.label ?? project.stage}</span>
        <span className="hint">{progress}% 完成</span>
        <span className="spacer" />
        <span className="card-cta">继续 →</span>
      </div>
    </article>
  );
}
