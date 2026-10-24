import type { Database } from 'better-sqlite3';
import { ProjectSchema, type Project, type Platform, type ProjectStage } from '@creator-studio/protocol';

type ProjectRow = {
  id: string;
  owner_id: string;
  title: string;
  platform: string;
  stage: string;
  workspace_path: string | null;
  style_profile_id: string | null;
  description: string | null;
  tags: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type CreateProjectInput = {
  id: string;
  ownerId: string;
  title: string;
  platform: Platform;
  workspacePath: string | null;
  description?: string;
  tags?: string[];
  now?: string;
};

export type UpdateProjectInput = {
  title?: string;
  platform?: Platform;
  description?: string;
  tags?: string[];
};

function toProject(row: ProjectRow): Project {
  let tags: string[] = [];
  if (row.tags !== null) {
    try {
      const parsed = JSON.parse(row.tags) as unknown;
      if (Array.isArray(parsed)) tags = parsed.filter((tag): tag is string => typeof tag === 'string');
    } catch {
      tags = [];
    }
  }
  return ProjectSchema.parse({
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    platform: row.platform,
    stage: row.stage,
    workspacePath: row.workspace_path,
    styleProfileId: row.style_profile_id,
    description: row.description ?? '',
    tags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  });
}

export class SqliteProjectStore {
  constructor(private readonly db: Database) {}

  create(input: CreateProjectInput): Project {
    const now = input.now ?? new Date().toISOString();
    const project: Project = {
      id: input.id,
      ownerId: input.ownerId,
      title: input.title,
      platform: input.platform,
      stage: 'topic',
      workspacePath: input.workspacePath,
      styleProfileId: null,
      description: input.description ?? '',
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    const parsed = ProjectSchema.parse(project);
    this.db
      .prepare(
        `INSERT INTO projects (id, owner_id, title, platform, stage, workspace_path,
           style_profile_id, description, tags, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.id,
        parsed.ownerId,
        parsed.title,
        parsed.platform,
        parsed.stage,
        parsed.workspacePath,
        parsed.styleProfileId,
        parsed.description,
        JSON.stringify(parsed.tags),
        parsed.createdAt,
        parsed.updatedAt,
        parsed.deletedAt,
      );
    return parsed;
  }

  get(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL').get(id) as
      | ProjectRow
      | undefined;
    return row === undefined ? null : toProject(row);
  }

  list(): Project[] {
    const rows = this.db
      .prepare('SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY updated_at DESC')
      .all() as ProjectRow[];
    return rows.map(toProject);
  }

  advanceStage(id: string, stage: ProjectStage): void {
    this.db
      .prepare('UPDATE projects SET stage = ?, updated_at = ? WHERE id = ?')
      .run(stage, new Date().toISOString(), id);
  }

  /** Moves the stage forward only; generating an old artifact must not rewind. */
  advanceStageIfBehind(id: string, stage: ProjectStage): void {
    const project = this.get(id);
    if (project === null) return;
    const order: ProjectStage[] = ['topic', 'research', 'script', 'shotlist', 'package', 'published', 'review'];
    if (order.indexOf(stage) > order.indexOf(project.stage)) this.advanceStage(id, stage);
  }

  update(id: string, patch: UpdateProjectInput): Project | null {
    const current = this.get(id);
    if (current === null) return null;

    const next: Project = ProjectSchema.parse({
      ...current,
      title: patch.title ?? current.title,
      platform: patch.platform ?? current.platform,
      description: patch.description ?? current.description,
      tags: patch.tags ?? current.tags,
      updatedAt: new Date().toISOString(),
    });

    this.db
      .prepare(
        `UPDATE projects SET title = ?, platform = ?, description = ?, tags = ?, updated_at = ?
         WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(next.title, next.platform, next.description, JSON.stringify(next.tags), next.updatedAt, id);
    return next;
  }

  /** Soft delete: the row and its artifacts stay on disk for recovery. */
  softDelete(id: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare('UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(now, now, id);
    return result.changes > 0;
  }

  restore(id: string): boolean {
    const result = this.db
      .prepare('UPDATE projects SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL')
      .run(new Date().toISOString(), id);
    return result.changes > 0;
  }

  counts(): { total: number; active: number; deleted: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END), 0) AS active
         FROM projects`,
      )
      .get() as { total: number; active: number };
    return { total: row.total, active: row.active, deleted: row.total - row.active };
  }
}
