import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Database } from 'better-sqlite3';
import {
  ArtifactSchema,
  type Artifact,
  type ArtifactKind,
  type ArtifactStore,
  type ArtifactWithContent,
  type SaveArtifactInput,
} from '@creator-studio/protocol';
// Reuse the audited path sandbox instead of duplicating security-critical logic.
import { resolveInsideWorkspace } from '@creator-studio/tools';

type ArtifactRow = {
  id: string;
  project_id: string;
  run_id: string | null;
  kind: string;
  path: string;
  sha256: string;
  mime: string;
  size: number;
  visibility: string;
  created_at: string;
};

export class ArtifactCorruptError extends Error {
  readonly code = 'ARTIFACT_CORRUPT';
}

function toArtifact(row: ArtifactRow): Artifact {
  return ArtifactSchema.parse({
    id: row.id,
    projectId: row.project_id,
    runId: row.run_id,
    kind: row.kind,
    path: row.path,
    sha256: row.sha256,
    mime: row.mime,
    size: row.size,
    visibility: row.visibility,
    createdAt: row.created_at,
  });
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export class SqliteArtifactStore implements ArtifactStore {
  constructor(
    private readonly db: Database,
    private readonly workspaceRoot: string,
  ) {}

  /**
   * Artifact paths are project-relative (`script/script.v1.md`); on disk every
   * project gets its own subtree so two projects cannot overwrite each other.
   */
  private projectRoot(projectId: string): string {
    return `${this.workspaceRoot}/projects/${projectId}`;
  }

  save(input: SaveArtifactInput): Artifact {
    // The sandbox resolves realpath, so the project root must exist before the
    // path check runs (a fresh project has no directory yet).
    mkdirSync(this.projectRoot(input.projectId), { recursive: true });
    const absolute = resolveInsideWorkspace(input.path, { workspaceRoot: this.projectRoot(input.projectId) });
    const hash = sha256(input.content);
    const artifact: Artifact = {
      id: input.id,
      projectId: input.projectId,
      runId: input.runId,
      kind: input.kind,
      path: input.path,
      sha256: hash,
      mime: input.mime,
      size: Buffer.byteLength(input.content, 'utf8'),
      visibility: 'local',
      createdAt: new Date().toISOString(),
    };
    const parsed = ArtifactSchema.parse(artifact);

    mkdirSync(dirname(absolute), { recursive: true });
    const existed = existsSync(absolute);
    writeFileSync(absolute, input.content, 'utf8');

    try {
      this.db
        .prepare(
          `INSERT INTO artifacts (id, project_id, run_id, kind, path, sha256, mime, size, visibility, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.id,
          parsed.projectId,
          parsed.runId,
          parsed.kind,
          parsed.path,
          parsed.sha256,
          parsed.mime,
          parsed.size,
          parsed.visibility,
          parsed.createdAt,
        );
    } catch (error) {
      // Metadata write failed: do not leave an orphan file behind.
      if (!existed) rmSync(absolute, { force: true });
      throw error;
    }

    return parsed;
  }

  read(artifactId: string): ArtifactWithContent | null {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(artifactId) as ArtifactRow | undefined;
    if (row === undefined) return null;
    const artifact = toArtifact(row);
    const absolute = join(this.workspaceRoot, 'projects', artifact.projectId, artifact.path);
    if (!existsSync(absolute)) throw new ArtifactCorruptError(`missing file for ${artifact.id}`);
    const content = readFileSync(absolute, 'utf8');
    if (sha256(content) !== artifact.sha256) {
      throw new ArtifactCorruptError(`sha256 mismatch for ${artifact.id}`);
    }
    return { artifact, content };
  }

  list(projectId: string): Artifact[] {
    const rows = this.db
      .prepare('SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at DESC')
      .all(projectId) as ArtifactRow[];
    return rows.map(toArtifact);
  }

  latest(projectId: string, kind: ArtifactKind): ArtifactWithContent | null {
    const row = this.db
      .prepare('SELECT * FROM artifacts WHERE project_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1')
      .get(projectId, kind) as ArtifactRow | undefined;
    if (row === undefined) return null;
    return this.read(row.id);
  }

  nextVersion(projectId: string, kind: ArtifactKind, baseName: string): number {
    const rows = this.db
      // Paths look like `script/script.v3.md`, so the base name may be preceded by
      // a directory segment. Match on the suffix rather than the whole path.
      .prepare('SELECT path FROM artifacts WHERE project_id = ? AND kind = ? AND path LIKE ?')
      .all(projectId, kind, `%${baseName}.v%`) as Array<{ path: string }>;
    let max = 0;
    const suffix = /\.v(\d+)\.md$/;
    for (const row of rows) {
      const fileName = row.path.split('/').pop() ?? '';
      if (!fileName.startsWith(`${baseName}.v`)) continue;
      const match = suffix.exec(fileName);
      if (match === null) continue;
      const version = Number.parseInt(match[1] as string, 10);
      if (version > max) max = version;
    }
    return max + 1;
  }
}
