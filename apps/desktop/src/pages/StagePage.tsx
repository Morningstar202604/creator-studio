import { useCallback, useEffect, useState } from 'react';
import type React from 'react';
import { useParams } from 'react-router-dom';
import { ApiError, api, type Artifact, type Project } from '../api';
import { AppShell } from '../components/AppShell';

type StageConfig = {
  kind: 'topic-card' | 'research-notes' | 'publish-pack';
  title: string;
  placeholder: string;
  hint: string;
  folder: string;
};

const STAGE: Record<'topic' | 'research' | 'package', StageConfig> = {
  topic: {
    kind: 'topic-card',
    title: '选题',
    placeholder: '例如：AI 对初级程序员的影响',
    hint: '生成 3 个选题卡，按需求 / 竞争 / 差异 / 可讲性评分',
    folder: 'topic/',
  },
  research: {
    kind: 'research-notes',
    title: '资料',
    placeholder: '例如：2026 年 AI 编程工具对校招的影响',
    hint: '生成可核查的事实要点与资料缺口',
    folder: 'research/',
  },
  package: {
    kind: 'publish-pack',
    title: '包装',
    placeholder: '例如：一期 15 分钟讲 AI 与初级岗位的视频',
    hint: '生成标题候选、简介、标签、章节与封面文案',
    folder: 'publish/',
  },
};

export function StagePage({ stage }: { stage: 'topic' | 'research' | 'package' }): React.ReactElement {
  const { id = '' } = useParams<{ id: string }>();
  const config = STAGE[stage];
  const [project, setProject] = useState<Project | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [context, setContext] = useState('');
  const [selected, setSelected] = useState<{ artifact: Artifact; content: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [projectResult, artifactResult] = await Promise.all([
        api.getProject(id),
        api.listArtifacts(id),
      ]);
      setProject(projectResult.project);
      const mine = artifactResult.artifacts.filter((artifact) => artifact.kind === config.kind);
      setArtifacts(mine);
      if (mine.length > 0 && mine[0] !== undefined) {
        const detail = await api.getArtifact(mine[0].id);
        setSelected({ artifact: detail.artifact, content: detail.content });
      }
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    }
  }, [id, config.kind]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (): Promise<void> => {
    if (context.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.generate(id, config.kind, context.trim());
      const detail = await api.getArtifact(result.artifact.id);
      setSelected({ artifact: detail.artifact, content: detail.content });
      await load();
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

  return (
    <AppShell
      title={
        <>
          <span>{config.title}</span>
          <span className="sep">›</span>
          <b>{project?.title ?? id.slice(0, 8)}</b>
        </>
      }
    >
      <div className="page-head">
        <div>
          <h1 className="page-title">{config.title}</h1>
          <div className="page-sub">
            {project === null ? '加载中…' : `${artifacts.length} 个版本`}
            <span className="hint"> · {config.hint}</span>
          </div>
        </div>
      </div>

      {error !== null && <div className="panel error-panel">{error}</div>}

      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">让 Agent 生成</span>
        </div>
        <textarea
          className="input textarea"
          rows={2}
          placeholder={config.placeholder}
          value={context}
          onChange={(event) => setContext(event.target.value)}
        />
        <div className="row">
          <button className="btn primary" disabled={busy || context.trim() === ''} onClick={() => void run()}>
            {busy ? '生成中…' : '开始生成'}
          </button>
          {busy && <span className="hint">模型输出需要几十秒，结果会先校验结构再落盘</span>}
        </div>
      </div>

      <div className="stage-layout">
        <section className="panel stage-content">
          <div className="panel-head">
            <span className="panel-title">{selected === null ? '最新结果' : selected.artifact.path}</span>
          </div>
          {selected === null ? (
            <p className="hint">还没有生成过。上面输入方向后点「开始生成」。</p>
          ) : (
            <pre className="output">{selected.content}</pre>
          )}
        </section>

        <aside className="panel stage-side">
          <div className="panel-head">
            <span className="panel-title">历史版本</span>
          </div>
          {artifacts.length === 0 ? (
            <p className="hint">暂无版本。</p>
          ) : (
            <ol className="version-list">
              {artifacts.map((artifact) => (
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
  return <StagePage stage="topic" />;
}

export function ResearchPage(): React.ReactElement {
  return <StagePage stage="research" />;
}

export function PackagePage(): React.ReactElement {
  return <StagePage stage="package" />;
}
