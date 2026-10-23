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
  now?: string;
};

function toProject(row: ProjectRow): Project {
  return ProjectSchema.parse({
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    platform: row.platform,
    stage: row.stage,
    workspacePath: row.workspace_path,
    styleProfileId: row.style_profile_id,
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
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    const parsed = ProjectSchema.parse(project);
    this.db
      .prepare(
        `INSERT INTO projects (id, owner_id, title, platform, stage, workspace_path,
           style_profile_id, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.id,
        parsed.ownerId,
        parsed.title,
        parsed.platform,
        parsed.stage,
        parsed.workspacePath,
        parsed.styleProfileId,
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
}
