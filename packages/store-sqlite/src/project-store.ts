import type { Database } from 'better-sqlite3';
import { LEGACY_VIDEO_STAGES, ProjectSchema, type Project, type Platform, type ProjectStage } from '@creator-studio/protocol';

type ProjectRow = {
  id: string;
  owner_id: string;
  title: string;
  platform: string;
  stage: string;
  scenario_id: string | null;
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
  /** Scenario pack id; defaults to the video pipeline. */
  scenarioId?: string;
  /** First stage of that pack; defaults to `topic` for the video pack. */
  stage?: string;
  now?: string;
};

export type UpdateProjectInput = {
  title?: string;
  platform?: Platform;
  description?: string;
  tags?: string[];
  /** Null detaches the current style profile. */
  styleProfileId?: string | null;
  /** Switching scenario also resets the stage to that pack's first stage. */
  scenarioId?: string;
  stage?: string;
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
    scenarioId: row.scenario_id ?? 'video',
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
      stage: input.stage ?? 'topic',
      scenarioId: input.scenarioId ?? 'video',
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
        `INSERT INTO projects (id, owner_id, title, platform, stage, scenario_id, workspace_path,
           style_profile_id, description, tags, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.id,
        parsed.ownerId,
        parsed.title,
        parsed.platform,
        parsed.stage,
        parsed.scenarioId,
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

  /** Includes soft-deleted rows when `includeDeleted` is true. */
  listWithDeleted(includeDeleted: boolean): Project[] {
    if (!includeDeleted) return this.list();
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as ProjectRow[];
    return rows.map(toProject);
  }

  advanceStage(id: string, stage: ProjectStage): void {
    this.db
      .prepare('UPDATE projects SET stage = ?, updated_at = ? WHERE id = ?')
      .run(stage, new Date().toISOString(), id);
  }

  /**
   * Moves the stage forward only; generating an old artifact must not rewind.
   * The ordering is caller-supplied because stages belong to a scenario pack, not
   * to the store. Unknown keys are ignored rather than throwing, so a stale
   * automation firing an old stage cannot break the project.
   */
  advanceStageIfBehind(id: string, stage: ProjectStage, order: readonly string[] = LEGACY_VIDEO_STAGES): void {
    const project = this.get(id);
    if (project === null) return;
    const next = order.indexOf(stage);
    const current = order.indexOf(project.stage);
    if (next === -1) return;
    if (current === -1 || next > current) this.advanceStage(id, stage);
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
      styleProfileId: patch.styleProfileId === undefined ? current.styleProfileId : patch.styleProfileId,
      scenarioId: patch.scenarioId ?? current.scenarioId,
      stage: patch.stage ?? current.stage,
      updatedAt: new Date().toISOString(),
    });

    this.db
      .prepare(
        `UPDATE projects SET title = ?, platform = ?, description = ?, tags = ?, style_profile_id = ?,
           scenario_id = ?, stage = ?, updated_at = ?
         WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(
        next.title,
        next.platform,
        next.description,
        JSON.stringify(next.tags),
        next.styleProfileId,
        next.scenarioId,
        next.stage,
        next.updatedAt,
        id,
      );
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
