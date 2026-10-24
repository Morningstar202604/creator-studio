import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { ProjectMetricsSchema, type ProjectMetrics, type ProjectMetricsInput } from '@creator-studio/protocol';

type MetricsRow = {
  id: string;
  project_id: string;
  recorded_at: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  retention_percent: number;
  revenue_cny: number;
  note: string;
};

export type MetricsSummary = {
  projectId: string;
  samples: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
};

function toMetrics(row: MetricsRow): ProjectMetrics {
  return ProjectMetricsSchema.parse({
    id: row.id,
    projectId: row.project_id,
    recordedAt: row.recorded_at,
    views: row.views,
    likes: row.likes,
    comments: row.comments,
    shares: row.shares,
    retentionPercent: row.retention_percent,
    revenueCny: row.revenue_cny,
    note: row.note,
  });
}

export class SqliteMetricsStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(projectId: string, input: ProjectMetricsInput): ProjectMetrics {
    const metrics: ProjectMetrics = ProjectMetricsSchema.parse({
      id: randomUUID(),
      projectId,
      recordedAt: this.now().toISOString(),
      views: input.views,
      likes: input.likes,
      comments: input.comments,
      shares: input.shares ?? 0,
      retentionPercent: input.retentionPercent ?? 0,
      revenueCny: input.revenueCny ?? 0,
      note: input.note ?? '',
    });
    this.db
      .prepare(
        `INSERT INTO project_metrics (id, project_id, recorded_at, views, likes, comments, shares,
           retention_percent, revenue_cny, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        metrics.id,
        metrics.projectId,
        metrics.recordedAt,
        metrics.views,
        metrics.likes,
        metrics.comments,
        metrics.shares,
        metrics.retentionPercent,
        metrics.revenueCny,
        metrics.note,
      );
    return metrics;
  }

  list(projectId: string, limit = 60): ProjectMetrics[] {
    const rows = this.db
      .prepare('SELECT * FROM project_metrics WHERE project_id = ? ORDER BY recorded_at DESC LIMIT ?')
      .all(projectId, limit) as MetricsRow[];
    return rows.map(toMetrics);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM project_metrics WHERE id = ?').run(id).changes > 0;
  }

  /** Aggregates across all projects; used by the library/review dashboards. */
  summary(): MetricsSummary[] {
    return this.db
      .prepare(
        `SELECT project_id AS projectId, COUNT(*) AS samples,
                COALESCE(SUM(views),0) AS views, COALESCE(SUM(likes),0) AS likes,
                COALESCE(SUM(comments),0) AS comments, COALESCE(SUM(shares),0) AS shares
         FROM project_metrics GROUP BY project_id ORDER BY views DESC`,
      )
      .all() as MetricsSummary[];
  }
}
