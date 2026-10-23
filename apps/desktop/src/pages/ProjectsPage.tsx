import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api, type Platform, type Project } from '../api';
import { AppShell } from '../components/AppShell';

const STAGE_LABELS: Array<{ key: Project['stage']; label: string }> = [
  { key: 'topic', label: '选题' },
  { key: 'research', label: '资料' },
  { key: 'script', label: '脚本' },
  { key: 'shotlist', label: '分镜' },
  { key: 'package', label: '包装' },
  { key: 'published', label: '发布' },
  { key: 'review', label: '复盘' },
];

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

  return (
    <AppShell title={<b>项目</b>}>
      <div className="page-head">
        <div>
          <h1 className="page-title">项目</h1>
          <div className="page-sub">{loading ? '加载中…' : `${projects.length} 个进行中`}</div>
        </div>
        <div className="spacer" />
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
      </div>

      {error !== null && <div className="panel error-panel">{error}</div>}

      {projects.length === 0 && !loading ? (
        <div className="empty">还没有项目。上面输入标题，从选题开始。</div>
      ) : (
        <div className="ledger">
          <div className="ledger-head">
            <span>项目</span>
            <span>阶段</span>
            <span>更新</span>
          </div>
          {projects.map((project) => {
            const currentIndex = STAGE_LABELS.findIndex((stage) => stage.key === project.stage);
            return (
              <button key={project.id} className="ledger-row" onClick={() => navigate(`/p/${project.id}`)}>
                <span className="proj-title">{project.title}</span>
                <span className="stages" aria-label={`阶段 ${project.stage}`}>
                  {STAGE_LABELS.map((stage, index) => (
                    <i
                      key={stage.key}
                      className={index < currentIndex ? 'done' : index === currentIndex ? 'now' : ''}
                    />
                  ))}
                </span>
                <span className="hint">{new Date(project.updatedAt).toLocaleString('zh-CN')}</span>
              </button>
            );
          })}
        </div>
      )}
    </AppShell>
  );
}
