import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Core, ElementDefinition } from 'cytoscape';
import { ApiError, api, type EntityCard, type Project, type ProjectGraph } from '../api';
import { AppShell, EmptyState, PageHead } from '../components/AppShell';
import { relativeTime } from '../lib/format';
import { useCanvasTheme } from '../lib/canvasTheme';

/**
 * Card relation view.
 *
 * The first attempt used ECharts' force graph because ECharts was already a
 * dependency. Looking at the screenshot showed it was not good enough for this job:
 * edge labels rendered as `undefined`, there was no legend, the force layout
 * overlapped node labels, and there was no selection or detail panel. Replaced with
 * Cytoscape, which is purpose-built for network graphs and ships real layout,
 * selection and per-element styling.
 */
const TYPE_PALETTE = ['#2e6f6a', '#8a5e12', '#35567d', '#b83a2e', '#2f6b43', '#7c6f9c'];

export function GraphPage(): React.ReactElement {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const container = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [graph, setGraph] = useState<ProjectGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<EntityCard | null>(null);
  const [selectedLinks, setSelectedLinks] = useState<
    Array<{ label: string; direction: 'out' | 'in'; title: string }>
  >([]);
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [showIsolated, setShowIsolated] = useState(false);
  const theme = useCanvasTheme();

  const load = useCallback(async () => {
    try {
      const [projectResult, graphResult] = await Promise.all([api.getProject(id), api.projectGraph(id)]);
      setProject(projectResult.project);
      setGraph(graphResult);
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const typeMeta = useMemo(() => {
    const map = new Map<string, { label: string; icon: string; color: string }>();
    (graph?.entityTypes ?? []).forEach((type, index) => {
      map.set(type.key, {
        label: type.label,
        icon: type.icon,
        color: TYPE_PALETTE[index % TYPE_PALETTE.length] as string,
      });
    });
    return map;
  }, [graph]);

  const visible = useMemo(() => {
    if (graph === null) return { nodes: [], edges: [] };
    const needle = query.trim().toLowerCase();
    const nodes = graph.nodes.filter((node) => {
      if (hiddenTypes.has(node.type)) return false;
      if (needle === '') return true;
      return `${node.title} ${Object.values(node.fields).join(' ')} ${node.tags.join(' ')}`.toLowerCase().includes(needle);
    });
    const ids = new Set(nodes.map((node) => node.id));
    return { nodes, edges: graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)) };
  }, [graph, hiddenTypes, query]);

  // Isolated cards are laid out around the connected core by cose, which pushes the
  // whole graph into a tall block. Counting them is useful; drawing them is not, so
  // they are hidden unless the user asks for them.
  const isolatedCount = useMemo(() => {
    if (graph === null) return 0;
    const connected = new Set<string>();
    for (const edge of graph.edges) {
      connected.add(edge.from);
      connected.add(edge.to);
    }
    return visible.nodes.filter((node) => !connected.has(node.id)).length;
  }, [graph, visible]);

  const drawn = useMemo(() => {
    if (showIsolated) return visible;
    const connected = new Set<string>();
    for (const edge of visible.edges) {
      connected.add(edge.from);
      connected.add(edge.to);
    }
    const linked = visible.nodes.filter((node) => connected.has(node.id));
    // If the filters leave nothing connected, hiding isolated cards would render an
    // empty canvas with a non-zero count above it. Show them instead — the count in
    // the subtitle already explains what they are.
    return linked.length === 0 ? visible : { nodes: linked, edges: visible.edges };
  }, [visible, showIsolated]);

  const orphanCount = useMemo(() => {
    if (graph === null) return 0;
    const connected = new Set<string>();
    for (const edge of graph.edges) {
      connected.add(edge.from);
      connected.add(edge.to);
    }
    return graph.nodes.filter((node) => !connected.has(node.id)).length;
  }, [graph]);

  useEffect(() => {
    if (container.current === null || graph === null) return undefined;
    let disposed = false;

    void import('cytoscape').then(({ default: cytoscape }) => {
      if (disposed || container.current === null) return;
      cyRef.current?.destroy();

      const elements: ElementDefinition[] = [
        ...drawn.nodes.map((node) => ({
          group: 'nodes' as const,
          data: {
            id: node.id,
            label: node.title,
            color: typeMeta.get(node.type)?.color ?? '#8c8880',
          },
        })),
        ...drawn.edges.map((edge) => ({
          group: 'edges' as const,
          data: { id: edge.id, source: edge.from, target: edge.to, label: edge.label },
        })),
      ];

      const cy = cytoscape({
        container: container.current,
        elements,
        style: [
          {
            selector: 'node',
            style: {
              'background-color': 'data(color)',
              label: 'data(label)',
              color: theme.fg,
              'font-size': 11,
              'font-family': 'inherit',
              'font-weight': 500,
              'text-valign': 'bottom',
              'text-margin-y': 5,
              'text-wrap': 'wrap',
              'text-max-width': '88px',
              'text-background-color': theme.surface,
              'text-background-opacity': 0.9,
              'text-background-padding': '1px',
              width: 18,
              height: 18,
              'border-width': 2,
              'border-color': theme.surface,
              'overlay-opacity': 0,
            },
          },
          {
            selector: 'node:selected',
            style: { 'border-width': 4, 'border-color': theme.fg, width: 34, height: 34 },
          },
          { selector: 'node.hovered', style: { 'border-width': 3, 'border-color': theme.accent } },
          { selector: 'node.dimmed', style: { opacity: 0.16 } },
          {
            selector: 'edge',
            style: {
              width: 1.4,
              'line-color': theme.borderStrong,
              'target-arrow-color': theme.borderStrong,
              'target-arrow-shape': 'triangle',
              'arrow-scale': 0.8,
              'curve-style': 'unbundled-bezier',
              'control-point-distances': [22],
              'control-point-weights': [0.5],
              label: '',
              'font-size': 9,
              color: theme.muted,
              'text-background-color': theme.surface,
              'text-background-opacity': 0.95,
              'text-background-padding': '2px',
              'text-rotation': 'none',
              'overlay-opacity': 0,
            },
          },
          {
            selector: 'edge.highlighted',
            style: {
              width: 2.4,
              'line-color': theme.accent,
              'target-arrow-color': theme.accent,
              color: theme.accent,
              label: 'data(label)',
              'z-index': 20,
            },
          },
          { selector: 'edge.dimmed', style: { opacity: 0.1 } },
        ],
        layout: {
          name: 'cose',
          animate: false,
          padding: 36,
          // The real fix for label collisions: make the layout treat each node as its
          // rendered box (dot + wrapped label), not just the 18px circle.
          nodeDimensionsIncludeLabels: true,
          nodeOverlap: 40,
          nodeRepulsion: () => 42000,
          idealEdgeLength: () => 165,
          gravity: 25,
          componentSpacing: 90,
          randomize: true,
          fit: true,
        },
        wheelSensitivity: 0.2,
        minZoom: 0.25,
        maxZoom: 2.5,
        // Faint halo so a node is easy to hit even when the dot is small.
        pixelRatio: 'auto',
      });

      // Expose screen positions for automation and for the hover affordance; without
      // this a canvas graph is untestable and hard to click precisely.
      const publishPositions = (): void => {
        const box = container.current?.getBoundingClientRect();
        if (box === undefined) return;
        const payload = cy.nodes().map((node) => {
          const position = node.renderedPosition();
          return { id: node.id(), x: Math.round(box.left + position.x), y: Math.round(box.top + position.y) };
        });
        (container.current as HTMLElement & { __nodePositions?: unknown }).__nodePositions = payload;
      };
      publishPositions();
      cy.on('layoutstop', publishPositions);
      cy.on('zoom pan resize', publishPositions);

      cy.on('tap', 'node', (event) => {
        const node = graph.nodes.find((candidate) => candidate.id === event.target.id());
        if (node === undefined) return;
        setSelected(node);
        void api
          .cardLinks(id, node.id)
          .then((result) =>
            setSelectedLinks(
              result.card.links.map((link) => ({
                label: link.relation.label,
                direction: link.direction,
                title: link.card.title,
              })),
            ),
          )
          .catch(() => setSelectedLinks([]));
        cy.elements().addClass('dimmed');
        event.target.removeClass('dimmed');
        event.target.connectedEdges().removeClass('dimmed').addClass('highlighted');
        event.target.connectedEdges().connectedNodes().removeClass('dimmed');
      });

      cy.on('tap', (event) => {
        if (event.target !== cy) return;
        setSelected(null);
        setSelectedLinks([]);
        cy.elements().removeClass('dimmed highlighted');
      });

      // Hover shows the pointer is on a node before the click; without it a small
      // dot gives no feedback and users click the label instead of the dot.
      cy.on('mouseover', 'node', (event) => {
        event.target.addClass('hovered');
        container.current?.style.setProperty('cursor', 'pointer');
      });
      cy.on('mouseout', 'node', (event) => {
        event.target.removeClass('hovered');
        container.current?.style.removeProperty('cursor');
      });

      // Size the canvas to the graph instead of always reserving 620px: a small
      // graph used to leave two thirds of the panel empty, and a large one was
      // squeezed by fit(). Height follows the layout, width stays responsive.
      const fitToContent = (): void => {
        if (container.current === null) return;
        // Headless builds (jsdom) do not implement collection.boundingBox; fall back
        // to the plain fit so the page still renders in tests.
        const collection = cy.elements() as unknown as {
          boundingBox?: (options: { includeLabels: boolean; includeOverlays: boolean }) => {
            w?: number;
            h?: number;
          };
        };
        if (typeof collection.boundingBox !== 'function') {
          cy.fit(undefined, 36);
          return;
        }
        const box = collection.boundingBox({ includeLabels: true, includeOverlays: false });
        const available = container.current.parentElement?.clientWidth ?? container.current.clientWidth;
        const neededHeight = Math.ceil((box.h ?? 0) + 96);
        const height = Math.min(620, Math.max(360, neededHeight));
        container.current.style.height = `${height}px`;
        cy.resize();
        // Zoom to fit horizontally only: the vertical extent is already handled by the
        // canvas height, so a wide graph would otherwise be shrunk to a thumbnail.
        const scale = Math.min(1, (available - 48) / Math.max(1, box.w ?? 1));
        cy.zoom(scale);
        cy.center();
      };
      fitToContent();
      cy.on('layoutstop', fitToContent);
      // jsdom has no ResizeObserver; guard rather than assume a browser.
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
  }, [drawn, visible, graph, id, typeMeta, theme]);

  useEffect(
    () => () => {
      cyRef.current?.destroy();
      cyRef.current = null;
    },
    [],
  );

  const zoomBy = (factor: number): void => {
    const cy = cyRef.current;
    if (cy === null) return;
    cy.zoom({ level: Math.min(2.5, Math.max(0.25, cy.zoom() * factor)), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  };

  const fitGraph = (): void => {
    const cy = cyRef.current;
    if (cy === null || container.current === null) return;
    const collection = cy.elements() as unknown as {
      boundingBox?: (options: { includeLabels: boolean; includeOverlays: boolean }) => { w?: number };
    };
    if (typeof collection.boundingBox !== 'function') {
      cy.fit(undefined, 36);
      return;
    }
    const box = collection.boundingBox({ includeLabels: true, includeOverlays: false });
    cy.zoom(Math.min(1, (container.current.clientWidth - 48) / Math.max(1, box.w ?? 1)));
    cy.center();
  };

  if (graph !== null && graph.nodes.length === 0) {
    return (
      <AppShell title={<b>{project?.title ?? id.slice(0, 8)}</b>}>
        <EmptyState title="还没有卡片" hint="先在角色卡或章节卡里建几张卡，关系图会在这里出现。" />
      </AppShell>
    );
  }

  return (
    <AppShell
      title={
        <>
          <span>关系图</span>
          <span className="sep">›</span>
          <b>{project?.title ?? id.slice(0, 8)}</b>
        </>
      }
    >
      <PageHead
        title="关系图"
        subtitle={
          graph === null
            ? '加载中…'
            : `${drawn.nodes.length} 张卡 · ${drawn.edges.length} 条关系${isolatedCount > 0 ? ` · ${isolatedCount} 张孤立卡${showIsolated ? '' : '（已隐藏）'}` : ''}`
        }
      >
        <button className="btn" onClick={() => void load()}>
          刷新
        </button>
      </PageHead>

      {error !== null && <div className="panel error-panel">{error}</div>}

      <div className="toolbar">
        <div className="segmented" role="group" aria-label="卡片类型筛选">
          {(graph?.entityTypes ?? []).map((type) => (
            <button
              key={type.key}
              aria-pressed={!hiddenTypes.has(type.key)}
              onClick={() => {
                const next = new Set(hiddenTypes);
                if (next.has(type.key)) next.delete(type.key);
                else next.add(type.key);
                setHiddenTypes(next);
              }}
            >
              {type.icon} {type.label}
            </button>
          ))}
        </div>
        {isolatedCount > 0 && (
          <button className="btn sm" aria-pressed={showIsolated} onClick={() => setShowIsolated((value) => !value)}>
            {showIsolated ? '隐藏孤立卡' : `显示孤立卡（${isolatedCount}）`}
          </button>
        )}
        <div className="spacer" />
        <input
          className="input search"
          placeholder="搜索卡片：名字、标签、字段"
          aria-label="搜索卡片"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <div className="graph-layout">
        <div className="graph-canvas-wrap">
          <div className="graph-viewport">
            <div ref={container} className="graph-canvas" style={{ height: 560 }} role="img" aria-label="卡片关系图" />
            <div className="graph-controls" role="group" aria-label="缩放">
              <button type="button" className="graph-ctl" aria-label="放大" onClick={() => zoomBy(1.25)}>
                +
              </button>
              <button type="button" className="graph-ctl" aria-label="缩小" onClick={() => zoomBy(0.8)}>
                −
              </button>
              <button type="button" className="graph-ctl" aria-label="适应窗口" onClick={() => fitGraph()}>
                ⤢
              </button>
            </div>
          </div>
          <div className="graph-legend">
            {(graph?.entityTypes ?? []).map((type) => (
              <span key={type.key} className="legend-item">
                <i style={{ background: typeMeta.get(type.key)?.color ?? '#8c8880' }} aria-hidden="true" />
                {type.label}
              </span>
            ))}
            <span className="hint">滚轮缩放 · 拖拽平移 · 点击节点看详情</span>
          </div>
        </div>

        <aside className="panel graph-side">
          {selected === null ? (
            <>
              <div className="panel-head">
                <span className="panel-title">怎么看这张图</span>
              </div>
              <ul className="graph-help">
                <li>圆点是卡片，箭头是关系，方向就是「谁指向谁」。</li>
                <li>颜色区分卡片类型，对应上方图例。</li>
                <li>点一个节点，其余淡出，只留它的直接关系。</li>
                <li>{orphanCount > 0 ? `有 ${orphanCount} 张卡还没连任何关系。` : '当前没有孤立卡片。'}</li>
              </ul>
              {(graph?.relationTypes ?? []).length > 0 && (
                <>
                  <div className="rail-title">关系类型</div>
                  <ul className="graph-help">
                    {graph?.relationTypes.map((relation) => (
                      <li key={relation.key}>
                        <span className="mono">{relation.label}</span>
                        <span className="hint"> ↔ {relation.inverse}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          ) : (
            <>
              <div className="panel-head">
                <span className="panel-title">{selected.title}</span>
                <span className="spacer" />
                <button className="btn sm ghost" onClick={() => setSelected(null)}>
                  收起
                </button>
              </div>
              <dl className="entity-fields">
                {(() => {
                  const type = graph?.entityTypes.find((candidate) => candidate.key === selected.type);
                  return Object.entries(selected.fields)
                    .filter(([, value]) => value !== '')
                    .slice(0, 6)
                    .map(([key, value]) => (
                      <div key={key}>
                        <dt>{type?.fields.find((field) => field.key === key)?.label ?? key}</dt>
                        <dd>{value}</dd>
                      </div>
                    ));
                })()}
              </dl>
              {selected.body !== '' && <p className="entity-body">{selected.body}</p>}
              <div className="rail-title">关系（{selectedLinks.length}）</div>
              {selectedLinks.length === 0 ? (
                <p className="hint">这张卡还没有关联。</p>
              ) : (
                <ul className="entity-links">
                  {selectedLinks.map((link, index) => (
                    <li key={`${link.title}-${index}`}>
                      <span className="link-label">{link.direction === 'out' ? '→' : '←'}</span>
                      <span>{link.title}</span>
                      <span className="hint">{link.label}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="hint">更新于 {relativeTime(selected.updatedAt)}</p>
              <button
                className="btn sm"
                onClick={() => {
                  const type = graph?.entityTypes.find((candidate) => candidate.key === selected.type);
                  if (type !== undefined) void navigate(`/p/${id}/cards/${type.key}`);
                }}
              >
                去卡片板
              </button>
            </>
          )}
        </aside>
      </div>
    </AppShell>
  );
}
