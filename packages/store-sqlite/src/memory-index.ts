import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { chunkText, cosine, hashEmbedding, normalize, type EmbeddingProvider } from '@creator-studio/model-gateway';

export type MemoryKind =
  | 'topic-card'
  | 'research-notes'
  | 'script'
  | 'shot-list'
  | 'publish-pack'
  | 'review-report'
  | 'fact'
  | 'decision'
  | 'preference'
  | 'style';

export type MemoryIndexInput = {
  projectId: string;
  scope: 'user' | 'project';
  kind: MemoryKind;
  content: string;
  sourceRef: string;
  /** Text the chunk came from, used to skip re-embedding unchanged artifacts. */
  sourceHash?: string;
};

export type MemoryHit = {
  id: string;
  projectId: string | null;
  scope: 'user' | 'project';
  kind: MemoryKind;
  content: string;
  sourceRef: string;
  chunkIndex: number;
  score: number;
  /** 'vector' | 'lexical' | 'hybrid' — which path produced the ranking. */
  via: 'vector' | 'lexical' | 'hybrid';
};

type ChunkRow = {
  id: string;
  project_id: string | null;
  scope: string;
  kind: string;
  content: string;
  source_ref: string;
  source_hash: string;
  chunk_index: number;
  model: string;
  dim: number;
  embedding: string;
};

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Local retrieval index over project artifacts and user memories.
 *
 * Two signals are combined: FTS5 trigram (exact substring, works well for Chinese
 * names and numbers) and vector cosine (paraphrase tolerance). Vectors come from
 * the configured provider when it supports `/embeddings`, otherwise from the
 * deterministic local hash embedder — so search always works offline and never
 * silently degrades to "no results".
 */
export class SqliteMemoryIndex {
  private readonly fallback: EmbeddingProvider;
  private cached: EmbeddingProvider | null = null;
  private readonly dim: number;

  constructor(
    private readonly db: Database,
    private readonly resolveProvider?: () => Promise<EmbeddingProvider> | EmbeddingProvider,
  ) {
    this.fallback = { id: 'hash-ngram', neural: false, embed: async (texts) => texts.map((text) => hashEmbedding(text)) };
    this.dim = 256;
  }

  /**
   * Resolves the active embedder once and keeps it for this process. When the user
   * adds an embedding-capable model later, a new process picks it up; existing rows
   * stay queryable through FTS and are re-vectorised on the next content change.
   */
  private async provider(): Promise<EmbeddingProvider> {
    if (this.cached !== null) return this.cached;
    if (this.resolveProvider === undefined) return this.fallback;
    try {
      this.cached = await this.resolveProvider();
    } catch {
      this.cached = this.fallback;
    }
    return this.cached;
  }

  get embedderId(): string {
    return this.cached?.id ?? 'auto';
  }

  get neural(): boolean {
    return this.cached?.neural ?? false;
  }

  /** Re-indexes one source; unchanged content (same hash) is skipped. */
  async index(input: MemoryIndexInput): Promise<{ chunks: number; skipped: boolean }> {
    const hash = input.sourceHash ?? sha256(input.content);
    const provider = await this.provider();
    const existing = this.db
      .prepare('SELECT COUNT(*) AS count, MIN(source_hash) AS hash, MAX(model) AS model FROM memory_chunks WHERE source_ref = ?')
      .get(input.sourceRef) as { count: number; hash: string | null; model: string | null };
    // Skip only when both the content and the embedding model are unchanged;
    // otherwise the row would keep vectors that no query can match.
    if (existing.count > 0 && existing.hash === hash && existing.model === provider.id) {
      return { chunks: existing.count, skipped: true };
    }

    this.db.prepare('DELETE FROM memory_chunks WHERE source_ref = ?').run(input.sourceRef);
    const chunks = chunkText(input.content);
    if (chunks.length === 0) return { chunks: 0, skipped: false };

    const vectors = await this.embed(chunks, provider);
    const insert = this.db.prepare(
      `INSERT INTO memory_chunks (id, project_id, scope, kind, content, source_ref, source_hash,
         chunk_index, model, dim, embedding, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = new Date().toISOString();
    const run = this.db.transaction(() => {
      chunks.forEach((chunk, index) => {
        insert.run(
          `${input.sourceRef}#${index}`,
          input.projectId,
          input.scope,
          input.kind,
          chunk,
          input.sourceRef,
          hash,
          index,
          provider.id,
          this.dim,
          JSON.stringify(vectors[index] ?? []),
          now,
        );
      });
    });
    run();
    return { chunks: chunks.length, skipped: false };
  }

  remove(sourceRef: string): number {
    return this.db.prepare('DELETE FROM memory_chunks WHERE source_ref = ?').run(sourceRef).changes;
  }

  count(projectId?: string): number {
    const row = (
      projectId === undefined
        ? this.db.prepare('SELECT COUNT(*) AS c FROM memory_chunks').get()
        : this.db.prepare('SELECT COUNT(*) AS c FROM memory_chunks WHERE project_id = ?').get(projectId)
    ) as { c: number };
    return row.c;
  }

  /**
   * Cosine floor for vector-only matches. Hash embeddings give small positive
   * similarity to unrelated Chinese text (shared characters), so without a floor
   * the vector path would inject noise into every result set.
   */
  static readonly MIN_VECTOR_SCORE = 0.15;

  /** Hybrid search: lexical FTS top-N + vector top-N, fused by reciprocal rank. */
  async search(query: string, options: { projectId?: string; limit?: number; kinds?: MemoryKind[] } = {}): Promise<MemoryHit[]> {
    const trimmed = query.trim();
    if (trimmed === '') return [];
    const limit = Math.min(options.limit ?? 6, 20);
    const pool = Math.max(limit * 4, 20);

    const lexical = this.lexicalSearch(trimmed, options.projectId, pool, options.kinds);
    const vector = await this.vectorSearch(trimmed, options.projectId, pool, options.kinds);

    const fused = new Map<string, { row: ChunkRow; score: number; via: MemoryHit['via'] }>();
    const add = (rows: ChunkRow[], scores: number[], via: 'vector' | 'lexical'): void => {
      rows.forEach((row, index) => {
        const rank = index + 1;
        const contribution = 1 / (60 + rank);
        const existing = fused.get(row.id);
        if (existing === undefined) {
          fused.set(row.id, { row, score: contribution, via });
        } else {
          existing.score += contribution;
          existing.via = 'hybrid';
        }
      });
      void scores;
    };

    add(lexical.rows, lexical.scores, 'lexical');
    add(vector.rows, vector.scores, 'vector');

    return [...fused.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => ({
        id: entry.row.id,
        projectId: entry.row.project_id,
        scope: entry.row.scope as 'user' | 'project',
        kind: entry.row.kind as MemoryKind,
        content: entry.row.content,
        sourceRef: entry.row.source_ref,
        chunkIndex: entry.row.chunk_index,
        score: Number(entry.score.toFixed(6)),
        via: entry.via,
      }));
  }

  private lexicalSearch(
    query: string,
    projectId: string | undefined,
    limit: number,
    kinds: MemoryKind[] | undefined,
  ): { rows: ChunkRow[]; scores: number[] } {
    // The trigram tokenizer cannot match queries shorter than 3 characters, so a
    // two-character Chinese term ("财政") falls back to a LIKE scan. The table is
    // small (local, per user), which keeps this cheap.
    if (query.length < 3) {
      let likeSql = 'SELECT * FROM memory_chunks WHERE content LIKE ?';
      const likeParams: unknown[] = [`%${query}%`];
      if (projectId !== undefined) {
        likeSql += ' AND project_id = ?';
        likeParams.push(projectId);
      }
      if (kinds !== undefined && kinds.length > 0) {
        likeSql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
        likeParams.push(...kinds);
      }
      likeSql += ' LIMIT ?';
      likeParams.push(limit);
      const likeRows = this.db.prepare(likeSql).all(...likeParams) as ChunkRow[];
      return { rows: likeRows, scores: likeRows.map((_, index) => 1 / (index + 1)) };
    }

    // FTS5 treats quotes and operators specially; escape double quotes and wrap.
    const escaped = query.replace(/"/g, '""');
    let sql = `SELECT c.* FROM memory_chunks_fts f
               JOIN memory_chunks c ON c.rowid = f.rowid
               WHERE memory_chunks_fts MATCH ?`;
    const params: unknown[] = [`"${escaped}"`];
    if (projectId !== undefined) {
      sql += ' AND c.project_id = ?';
      params.push(projectId);
    }
    if (kinds !== undefined && kinds.length > 0) {
      sql += ` AND c.kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }
    sql += ' ORDER BY rank LIMIT ?';
    params.push(limit);

    try {
      const rows = this.db.prepare(sql).all(...params) as ChunkRow[];
      return { rows, scores: rows.map((_, index) => 1 / (index + 1)) };
    } catch {
      // A malformed MATCH expression must not break the whole search.
      return { rows: [], scores: [] };
    }
  }

  private async vectorSearch(
    query: string,
    projectId: string | undefined,
    limit: number,
    kinds: MemoryKind[] | undefined,
  ): Promise<{ rows: ChunkRow[]; scores: number[] }> {
    // Only compare vectors produced by the same provider; the vector spaces differ.
    const provider = await this.provider();
    let sql = 'SELECT * FROM memory_chunks WHERE model = ?';
    const params: unknown[] = [provider.id];
    if (projectId !== undefined) {
      sql += ' AND project_id = ?';
      params.push(projectId);
    }
    if (kinds !== undefined && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }
    const rows = this.db.prepare(sql).all(...params) as ChunkRow[];
    if (rows.length === 0) return { rows: [], scores: [] };

    const [queryVector] = await this.embed([query], provider);
    if (queryVector === undefined) return { rows: [], scores: [] };

    const scored = rows
      .map((row) => {
        let vector: number[] = [];
        try {
          vector = JSON.parse(row.embedding) as number[];
        } catch {
          vector = [];
        }
        return { row, score: cosine(queryVector, vector) };
      })
      .filter((entry) => entry.score >= SqliteMemoryIndex.MIN_VECTOR_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return { rows: scored.map((entry) => entry.row), scores: scored.map((entry) => entry.score) };
  }

  private async embed(texts: string[], provider?: EmbeddingProvider): Promise<number[][]> {
    const active = provider ?? (await this.provider());
    const vectors = await active.embed(texts);
    return vectors.map((vector) => (vector.length === this.dim ? vector : normalize(vector)));
  }
}
