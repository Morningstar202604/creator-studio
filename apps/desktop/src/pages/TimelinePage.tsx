import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { useParams } from 'react-router-dom';
import type { Core, ElementDefinition } from 'cytoscape';
import { ApiError, api, type EntityCard, type ForeshadowHealth, type Project, type ProjectGraph } from '../api';
import { AppShell, EmptyState, PageHead } from '../components/AppShell';
import { ToastStack, useToasts } from '../components/Toast';
import { useCanvasTheme } from '../lib/canvasTheme';

/**
 * Narrative timeline.
 *
 * A force layout answers "what is connected to what"; it does not answer "is my story
 * in order". This view puts chapters on one axis in reading order and draws every
 * foreshadowing thread from the chapter that plants it to the one that pays it off,
 * so an unclosed thread is a visibly long or dangling line rather than a number.
 *
 * Layout comes from cytoscape-dagre (the official dagre adapter) instead of a
 * hand-rolled positioner: layered rank assignment is exactly what dagre does, and
 * writing it by hand would be the wheel this project is trying to avoid.
 */

const TYPE_PALETTE = ['#2e6f6a', '#8a5e12', '#35567d', '#b83a2e', '#2f6b43', '#7c6f9c'];

/** Chapter ordering: explicit number field when present, array order otherwise. */
function chapterRank(card: EntityCard, index: number): number {
  const raw = card.fields['number'] ?? card.fields['order'] ?? '';
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? index : parsed;
}

export function TimelinePage(): React.ReactElement {
  const { id = '' } = useParams<{ id: string }>();
  const container = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [graph, setGraph] = useState<ProjectGraph | null>(null);
  const [health, setHealth] = useState<ForeshadowHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<EntityCard | null>(null);
  const theme = useCanvasTheme();
  const { toasts, push, dismiss } = useToasts();

  const load = useCallback(async () => {
    try {
      const [projectResult, graphResult, healthResult] = await Promise.all([
        api.getProject(id),
        api.projectGraph(id),
        api.foreshadowHealth(id),
      ]);
      setProject(projectResult.project);
      setGraph(graphResult);
      setHealth(healthResult);
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const chapters = useMemo(
    () =>
      (graph?.nodes ?? [])
        .filter((node) => node.type === 'chapter')
        .map((node, index) => ({ node, rank: chapterRank(node, index) }))
        .sort((a, b) => a.rank - b.rank),
    [graph],
  );

  const typeMeta = useMemo(() => {
    const map = new Map<string, string>();
    (graph?.entityTypes ?? []).forEach((type, index) => {
      map.set(type.key, TYPE_PALETTE[index % TYPE_PALETTE.length] as string);
    });
    return map;
  }, [graph]);

  useEffect(() => {
    if (container.current === null || graph === null || chapters.length === 0) return undefined;
    let disposed = false;

    void Promise.all([import('cytoscape'), import('cytoscape-dagre')]).then(([{ default: cytoscape }, dagre]) => {
      if (disposed || container.current === null) return;
      cyRef.current?.destroy();
      cytoscape.use(dagre.default);

      const chapterIds = new Set(chapters.map((chapter) => chapter.node.id));
      // Threads only: foreshadow cards and the chapters they touch. Characters and
      // locations would add noise to a chart whose question is "is the plot closed".
      const threads = (graph.nodes ?? []).filter((node) => node.type === 'foreshadow');
      const threadIds = new Set(threads.map((thread) => thread.id));

      const elements: ElementDefinition[] = [
        ...chapters.map(({ node, rank }) => ({
          group: 'nodes' as const,
          data: {
            id: node.id,
            label: node.title,
            rank,
            color: typeMeta.get(node.type) ?? '#8a5e12',
            kind: 'chapter',
          },
          classes: 'chapter',
        })),
        ...threads.map((node) => ({
          group: 'nodes' as const,
          data: {
            id: node.id,
            label: node.title,
            color: typeMeta.get(node.type) ?? '#b83a2e',
            kind: 'thread',
            status: node.fields['status'] ?? '',
          },
          classes: node.fields['status'] === '已回收' ? 'thread closed' : 'thread open',
        })),
        ...(graph.edges ?? [])
          .filter((edge) => threadIds.has(edge.from) && chapterIds.has(edge.to))
          .map((edge) => ({
            group: 'edges' as const,
            data: { id: edge.id, source: edge.from, target: edge.to, label: edge.label },
            classes: edge.relationType === 'pays-off' ? 'payoff' : 'plant',
          })),
        // Chapters carry no real edges between them, so dagre would treat each as its
        // own component and stack them vertically. A synthetic reading-order chain is
        // what turns the layout into the left-to-right timeline the page promises.
        ...chapters.slice(1).map((chapter, index) => ({
          group: 'edges' as const,
          data: {
            id: `seq-${index}`,
            source: chapters[index]?.node.id as string,
            target: chapter.node.id,
          },
          classes: 'sequence',
        })),
      ];

      const cy = cytoscape({
        container: container.current,
        elements,
        style: [
          {
            selector: 'node.chapter',
            style: {
              'background-color': theme.surface,
              shape: 'round-rectangle',
              width: 132,
              height: 44,
              label: 'data(label)',
              'font-size': 11,
              'font-weight': 500,
              color: theme.fg,
              'text-valign': 'center',
              'text-halign': 'center',
              'text-max-width': '116px',
              'text-wrap': 'wrap',
              'border-width': 2,
              'border-color': 'data(color)',
              'overlay-opacity': 0,
            },
          },
          {
            selector: 'node.thread',
            style: {
              'background-color': 'data(color)',
              shape: 'ellipse',
              width: 18,
              height: 18,
              label: 'data(label)',
              'font-size': 10,
              color: theme.fg,
              'text-valign': 'bottom',
              'text-margin-y': 4,
              'text-max-width': '110px',
              'text-wrap': 'ellipsis',
              'border-width': 2,
              'border-color': theme.surface,
              'overlay-opacity': 0,
            },
          },
          {
            selector: 'node.thread.open',
            style: { 'border-width': 3, 'border-color': theme.danger, 'border-style': 'dashed' },
          },
          {
            selector: 'edge.plant',
            style: {
              width: 1.2,
              'line-color': '#b9b4aa',
              'line-style': 'dashed',
              'curve-style': 'bezier',
              label: 'data(label)',
              'font-size': 9,
              color: theme.muted,
              'text-background-color': theme.surface,
              'text-background-opacity': 0.92,
              'text-background-padding': '2px',
              'text-rotation': 'none',
              'overlay-opacity': 0,
            },
          },
          {
            selector: 'edge.payoff',
            style: {
              width: 1.6,
              'line-color': '#2e6f6a',
              'target-arrow-color': '#2e6f6a',
              'target-arrow-shape': 'triangle',
              'curve-style': 'bezier',
              label: 'data(label)',
              'font-size': 9,
              color: theme.accent,
              'text-background-color': theme.surface,
              'text-background-opacity': 0.92,
              'text-background-padding': '2px',
              'text-rotation': 'none',
              'overlay-opacity': 0,
            },
          },
          {
            selector: 'edge.sequence',
            style: {
              width: 2,
              'line-color': theme.border,
              'target-arrow-shape': 'chevron',
              'target-arrow-color': theme.border,
              'arrow-scale': 0.7,
              'curve-style': 'straight',
              'overlay-opacity': 0,
            },
          },
          { selector: '.dimmed', style: { opacity: 0.15 } },
          { selector: 'node:selected', style: { 'border-width': 4, 'border-color': theme.fg } },
        ],
        // cytoscape-dagre injects its own options; the base typings only know the
        // common ones, so the object is widened deliberately.
        layout: {
          name: 'dagre',
          rankDir: 'LR',
          ranker: 'network-simplex',
          nodeSep: 34,
          rankSep: 90,
          edgeSep: 14,
          fit: true,
          padding: 36,
          animate: false,
        } as cytoscape.LayoutOptions,
        wheelSensitivity: 0.2,
        minZoom: 0.2,
        maxZoom: 2.5,
      });

      cy.on('tap', 'node', (event) => {
        const node = graph.nodes.find((candidate) => candidate.id === event.target.id());
        if (node === undefined) return;
        setSelected(node);
        cy.elements().addClass('dimmed');
        event.target.removeClass('dimmed');
        event.target.connectedEdges().removeClass('dimmed');
        event.target.connectedEdges().connectedNodes().removeClass('dimmed');
      });
      cy.on('tap', (event) => {
        if (event.target !== cy) return;
        setSelected(null);
        cy.elements().removeClass('dimmed');
      });

      // A long chapter chain cannot fit a fixed-width canvas at a readable size.
      // Instead of shrinking the whole diagram into a thumbnail, grow the canvas to
      // the layout's real width and let the wrapper scroll horizontally — the same
      // pattern every timeline UI uses. Zoom stays at 1 so text is always legible.
      const fitToReadingSize = (): void => {
        if (container.current === null) return;
        const collection = cy.elements() as unknown as {
          boundingBox?: (options: { includeLabels: boolean; includeOverlays: boolean }) => unknown;
        };
        // Headless builds (jsdom) do not implement boundingBox; leave the fixed
        // canvas size alone rather than throwing inside a layout callback.
        if (typeof collection.boundingBox !== 'function') return;
        const bounds = collection.boundingBox({ includeLabels: true, includeOverlays: false });
        const width = (bounds as unknown as { x1?: number; x2?: number; w?: number });
        const height = (bounds as unknown as { y1?: number; y2?: number; h?: number });
        const boxW = width.w ?? (width.x2 ?? 0) - (width.x1 ?? 0);
        const boxH = height.h ?? (height.y2 ?? 0) - (height.y1 ?? 0);
        const boxX1 = width.x1 ?? 0;
        const boxY1 = height.y1 ?? 0;
        const needed = Math.ceil(boxW + 80);
        const available = container.current.parentElement?.clientWidth ?? container.current.clientWidth;
        container.current.style.width = `${Math.max(available, needed)}px`;
        // Chapter labels sit under their node; without this the bottom-most
        // label was clipped by the canvas edge on a two-row timeline.
        container.current.style.paddingBottom = "18px";
        cy.resize();
        cy.zoom(1);
        // Anchor to the left edge so chapter one is the first thing on screen.
        cy.pan({
          x: 40 - boxX1,
          y: (container.current.clientHeight - boxH) / 2 - boxY1,
        });
        // Size the canvas to the diagram so the panel does not leave a large empty
        // area under a two-row timeline.
        const desiredHeight = Math.min(560, Math.max(220, Math.ceil(boxH + 96)));
        container.current.style.height = `${desiredHeight}px`;
        cy.resize();
        cy.pan({ x: 40 - boxX1, y: (desiredHeight - boxH) / 2 - boxY1 });
      };
      fitToReadingSize();
      cy.on('layoutstop', fitToReadingSize);
      const observer =
        typeof ResizeObserver === 'undefined'
          ? null
          : new ResizeObserver(() => {
              cy.resize();
            });
      if (observer !== null && container.current !== null) observer.observe(container.current);
      cy.on('destroy', () => observer?.disconnect());
      cyRef.current = cy;
    });

    return () => {
      disposed = true;
    };
  }, [graph, chapters, typeMeta, theme]);

  useEffect(
    () => () => {
      cyRef.current?.destroy();
      cyRef.current = null;
    },
    [],
  );

  if (graph !== null && chapters.length === 0) {
    return (
      <AppShell title={<b>{project?.title ?? id.slice(0, 8)}</b>}>
        <EmptyState title="还没有章节卡" hint="先建几张章节卡，时间轴会按章节顺序把它们排开。" />
      </AppShell>
    );
  }

  const openThreads = health?.items ?? [];
  const worstGap = openThreads.reduce((max, item) => Math.max(max, item.gapChapters ?? 0), 0);

  return (
    <AppShell
      title={
        <>
          <span>叙事时间轴</span>
          <span className="sep">›</span>
          <b>{project?.title ?? id.slice(0, 8)}</b>
        </>
      }
    >
      <PageHead
        title="叙事时间轴"
        subtitle={
          health === null
            ? '加载中…'
            : `${chapters.length} 章 · ${health.total} 条伏笔，${health.open} 条未回收${worstGap > 0 ? ` · 最长跨度 ${worstGap} 章` : ''}`
        }
      >
        <button className="btn" onClick={() => void load()}>
          刷新
        </button>
        <button
          className="btn"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(
                openThreads
                  .map((item) => `- ${item.title}：${item.plantedAt} 埋，${item.note}`)
                  .join('\n'),
              )
              .then(() => push('未回收伏笔清单已复制'))
              .catch(() => push('复制失败，请手动选择文本', 'error'));
          }}
        >
          复制未回收清单
        </button>
      </PageHead>

      {error !== null && <div className="panel error-panel">{error}</div>}

      <div className="timeline-layout">
        <div className="graph-canvas-wrap">
          <div className="graph-scroll">
            <div
              ref={container}
              className="graph-canvas"
              style={{ height: 560 }}
              role="img"
              aria-label="章节与伏笔时间轴"
            />
          </div>
          <div className="timeline-scrub">
            {chapters.map((chapter) => (
              <button
                key={chapter.node.id}
                className="scrub-dot"
                title={chapter.node.title}
                aria-label={`跳到 ${chapter.node.title}`}
                onClick={() => {
                  const cy = cyRef.current;
                  if (cy === null) return;
                  const target = cy.getElementById(chapter.node.id);
                  if (target.length === 0) return;
                  // The canvas is wider than its scroll wrapper, so panning alone does
                  // not move the viewport. Scroll the wrapper to the node's rendered
                  // position first, then centre it inside the visible area.
                  const scroll = container.current?.parentElement;
                  const rendered = target.renderedPosition();
                  const zoom = cy.zoom();
                  const nodeX = target.position().x * zoom;
                  if (scroll !== undefined && scroll !== null) {
                    scroll.scrollTo({
                      left: Math.max(0, nodeX - scroll.clientWidth / 2 + 60),
                      behavior: 'smooth',
                    });
                  }
                  void rendered;
                  cy.elements().removeClass('dimmed');
                  target.addClass('selected');
                  setTimeout(() => target.removeClass('selected'), 900);
                }}
              >
                {chapter.rank}
              </button>
            ))}
          </div>
          <div className="graph-legend">
            <span className="legend-item">
              <i style={{ background: theme.warn }} aria-hidden="true" /> 章节
            </span>
            <span className="legend-item">
              <i style={{ background: theme.danger, borderRadius: '50%' }} aria-hidden="true" /> 伏笔
            </span>
            <span className="hint">实线=回收 · 虚线=埋设 · 红色虚线框=未回收 · 滚轮缩放 · 拖拽平移</span>
          </div>
        </div>

        <aside className="panel timeline-side">
          <div className="panel-head">
            <span className="panel-title">{selected === null ? '待处理伏笔' : selected.title}</span>
            {selected === null && (
              <span className={`badge ${openThreads.length === 0 ? 'ok' : 'warn'}`}>{openThreads.length}</span>
            )}
          </div>
          {selected === null ? (
            openThreads.length === 0 ? (
              <p className="hint">所有伏笔都已回收。点左侧节点可以查看单条细节。</p>
            ) : (
              <ul className="thread-list">
                {openThreads.map((item) => (
                  <li key={item.cardId}>
                    <span className="thread-title">{item.title}</span>
                    <span className="hint">
                      {item.plantedAt === '' ? '未填埋设章节' : `${item.plantedAt} 埋`}
                      {item.gapChapters === null ? '' : ` · 跨度 ${item.gapChapters} 章`}
                    </span>
                    <span className={`badge ${item.gapChapters !== null && item.gapChapters > 12 ? 'danger' : 'warn'}`}>
                      {item.note}
                    </span>
                    {item.gapChapters === null ? (
                      <div className="thread-bar unknown" aria-hidden="true" />
                    ) : (
                      <div className="thread-bar" aria-hidden="true">
                        <i style={{ width: `${Math.min(100, Math.max(6, (item.gapChapters / 12) * 100))}%` }} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )
          ) : (
            <>
              <dl className="entity-fields">
                {(() => {
                  const type = graph?.entityTypes.find((candidate) => candidate.key === selected.type);
                  return Object.entries(selected.fields)
                    .filter(([, value]) => value !== '')
                    .map(([key, value]) => (
                      <div key={key}>
                        <dt>{type?.fields.find((field) => field.key === key)?.label ?? key}</dt>
                        <dd>{value}</dd>
                      </div>
                    ));
                })()}
              </dl>
              <button className="btn sm" onClick={() => setSelected(null)}>
                回到待处理清单
              </button>
            </>
          )}
        </aside>
      </div>

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </AppShell>
  );
}
