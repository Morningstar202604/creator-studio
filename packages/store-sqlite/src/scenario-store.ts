import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import {
  BUILTIN_PACKS,
  EntityCardSchema,
  EntityRelationSchema,
  PACK_FORMAT_VERSION,
  negotiatePack,
  resolveInheritance,
  ScenarioPackSchema,
  STAGE_VIEWS,
  type EntityCard,
  type EntityCardInput,
  type EntityCardWithLinks,
  type EntityRelation,
  type ScenarioPack,
} from '@creator-studio/protocol';

type PackRow = {
  id: string;
  name: string;
  description: string;
  icon: string;
  builtin: number;
  payload: string;
  created_at: string;
  updated_at: string;
};

type EntityRow = {
  id: string;
  project_id: string;
  type: string;
  title: string;
  fields: string;
  body: string;
  tags: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toPack(row: PackRow): ScenarioPack {
  const payload = parseJson<Record<string, unknown>>(row.payload, {});
  return ScenarioPackSchema.parse({
    ...payload,
    id: row.id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    builtin: row.builtin === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/**
 * `entity_relations` and `entities` share column names (`id`, `project_id`,
 * `created_at`), so every join selects explicit aliases. Guessing which `id`
 * SQLite exposes is how this kind of code silently returns the wrong row.
 */
type RelationJoinRow = {
  relation_id: string;
  relation_type: string | null;
  relation_project_id: string;
  from_card_id: string;
  to_card_id: string;
  label: string;
  relation_created_at: string;
  card_id: string;
  card_project_id: string;
  card_type: string;
  card_title: string;
  card_fields: string;
  card_body: string;
  card_tags: string;
  card_sort_order: number;
  card_created_at: string;
  card_updated_at: string;
};

const RELATION_SELECT = `SELECT
  r.id AS relation_id, r.project_id AS relation_project_id, r.from_card_id AS from_card_id,
  r.to_card_id AS to_card_id, r.label AS label, r.relation_type AS relation_type,
  r.created_at AS relation_created_at,
  e.id AS card_id, e.project_id AS card_project_id, e.type AS card_type, e.title AS card_title,
  e.fields AS card_fields, e.body AS card_body, e.tags AS card_tags,
  e.sort_order AS card_sort_order, e.created_at AS card_created_at, e.updated_at AS card_updated_at`;

function toRelation(row: RelationJoinRow): EntityRelation {
  return EntityRelationSchema.parse({
    id: row.relation_id,
    projectId: row.relation_project_id,
    fromCardId: row.from_card_id,
    toCardId: row.to_card_id,
    relationType: row.relation_type ?? null,
    label: row.label,
    createdAt: row.relation_created_at,
  });
}

function toJoinedCard(row: RelationJoinRow): EntityCard {
  return EntityCardSchema.parse({
    id: row.card_id,
    projectId: row.card_project_id,
    type: row.card_type,
    title: row.card_title,
    fields: parseJson<Record<string, string>>(row.card_fields, {}),
    body: row.card_body,
    tags: parseJson<string[]>(row.card_tags, []),
    order: row.card_sort_order,
    createdAt: row.card_created_at,
    updatedAt: row.card_updated_at,
  });
}

function toCard(row: EntityRow): EntityCard {
  return EntityCardSchema.parse({
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    title: row.title,
    fields: parseJson<Record<string, string>>(row.fields, {}),
    body: row.body,
    tags: parseJson<string[]>(row.tags, []),
    order: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export class SqliteScenarioStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Seeds the four built-in packs on first boot. A built-in row is refreshed from
   * code on every start (so shipping a fixed typo reaches existing installs), while
   * user-authored packs are never touched.
   */
  seedBuiltins(): void {
    const timestamp = this.now().toISOString();
    const upsert = this.db.prepare(
      `INSERT INTO scenario_packs (id, name, description, icon, builtin, payload, created_at, updated_at)
       VALUES (@id, @name, @description, @icon, 1, @payload, @created_at, @updated_at)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, description = excluded.description, icon = excluded.icon,
         builtin = 1, payload = excluded.payload, updated_at = excluded.updated_at
       WHERE scenario_packs.builtin = 1`,
    );
    const run = this.db.transaction(() => {
      for (const pack of BUILTIN_PACKS) {
        upsert.run({
          id: pack.id,
          name: pack.name,
          description: pack.description,
          icon: pack.icon,
          payload: JSON.stringify(pack),
          created_at: timestamp,
          updated_at: timestamp,
        });
      }
    });
    run();
  }

  list(): ScenarioPack[] {
    const rows = this.db.prepare('SELECT * FROM scenario_packs ORDER BY builtin DESC, name ASC').all() as PackRow[];
    return rows.map(toPack);
  }

  get(id: string): ScenarioPack | null {
    const row = this.db.prepare('SELECT * FROM scenario_packs WHERE id = ?').get(id) as PackRow | undefined;
    if (row === undefined) return null;
    // Inheritance is resolved on read so a parent fix reaches every child without
    // rewriting child rows.
    const resolved = resolveInheritance(toPack(row), (parentId) => {
      const parentRow = this.db.prepare('SELECT * FROM scenario_packs WHERE id = ?').get(parentId) as
        | PackRow
        | undefined;
      return parentRow === undefined ? undefined : toPack(parentRow);
    });
    return resolved.ok ? resolved.pack : toPack(row);
  }

  /** Raw row without inheritance expansion; used for export of exactly what is stored. */
  getStored(id: string): ScenarioPack | null {
    const row = this.db.prepare('SELECT * FROM scenario_packs WHERE id = ?').get(id) as PackRow | undefined;
    return row === undefined ? null : toPack(row);
  }

  /**
   * Creates or replaces a user pack. Rejects a pack that needs a view this build
   * does not implement, and refuses a broken inheritance chain — both before any
   * row is written, so a bad import leaves the database untouched.
   */
  save(input: ScenarioPack): ScenarioPack {
    const parsed = ScenarioPackSchema.parse({
      ...input,
      formatVersion: input.formatVersion ?? PACK_FORMAT_VERSION,
      generatedAt: undefined,
    });
    if (parsed.builtin) throw new Error('BUILTIN_READONLY');

    const negotiation = negotiatePack(parsed, STAGE_VIEWS);
    if (!negotiation.ok) {
      throw new Error(`UNSUPPORTED_VIEW: ${negotiation.missingViews.join(', ')}`);
    }
    if (parsed.inherits !== undefined) {
      const resolved = resolveInheritance(parsed, (id) => this.get(id) ?? undefined);
      if (!resolved.ok) throw new Error(`BAD_INHERITANCE: ${resolved.message}`);
    }
    const existing = this.db.prepare('SELECT builtin FROM scenario_packs WHERE id = ?').get(parsed.id) as
      | { builtin: number }
      | undefined;
    if (existing !== undefined && existing.builtin === 1) throw new Error('BUILTIN_READONLY');
    const timestamp = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO scenario_packs (id, name, description, icon, builtin, payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, description = excluded.description, icon = excluded.icon,
           payload = excluded.payload, updated_at = excluded.updated_at`,
      )
      .run(parsed.id, parsed.name, parsed.description, parsed.icon, JSON.stringify(parsed), timestamp, timestamp);
    return this.get(parsed.id) as ScenarioPack;
  }

  /** Built-in packs are protected; user packs disappear with their cards. */
  delete(id: string): 'deleted' | 'not-found' | 'builtin' {
    const row = this.db.prepare('SELECT builtin FROM scenario_packs WHERE id = ?').get(id) as
      | { builtin: number }
      | undefined;
    if (row === undefined) return 'not-found';
    if (row.builtin === 1) return 'builtin';
    this.db.prepare('DELETE FROM scenario_packs WHERE id = ?').run(id);
    return 'deleted';
  }

  listCards(projectId: string, type?: string): EntityCard[] {
    const rows =
      type === undefined
        ? (this.db
            .prepare('SELECT * FROM entities WHERE project_id = ? ORDER BY type ASC, sort_order ASC, created_at ASC')
            .all(projectId) as EntityRow[])
        : (this.db
            .prepare(
              'SELECT * FROM entities WHERE project_id = ? AND type = ? ORDER BY sort_order ASC, created_at ASC',
            )
            .all(projectId, type) as EntityRow[]);
    return rows.map(toCard);
  }

  getCard(projectId: string, cardId: string): EntityCard | null {
    const row = this.db.prepare('SELECT * FROM entities WHERE id = ? AND project_id = ?').get(cardId, projectId) as
      | EntityRow
      | undefined;
    return row === undefined ? null : toCard(row);
  }

  createCard(projectId: string, input: EntityCardInput): EntityCard {
    const timestamp = this.now().toISOString();
    const nextOrder = (
      this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS max FROM entities WHERE project_id = ? AND type = ?').get(
        projectId,
        input.type,
      ) as { max: number }
    ).max;
    const card: EntityCard = EntityCardSchema.parse({
      ...input,
      id: randomUUID(),
      projectId,
      order: nextOrder + 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.db
      .prepare(
        `INSERT INTO entities (id, project_id, type, title, fields, body, tags, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        card.id,
        card.projectId,
        card.type,
        card.title,
        JSON.stringify(card.fields),
        card.body,
        JSON.stringify(card.tags),
        card.order,
        card.createdAt,
        card.updatedAt,
      );
    return card;
  }

  updateCard(projectId: string, cardId: string, input: Partial<EntityCardInput> & { order?: number }): EntityCard | null {
    const current = this.getCard(projectId, cardId);
    if (current === null) return null;
    const next = EntityCardSchema.parse({
      ...current,
      ...input,
      id: current.id,
      projectId: current.projectId,
      order: input.order ?? current.order,
      createdAt: current.createdAt,
      updatedAt: this.now().toISOString(),
    });
    this.db
      .prepare(
        `UPDATE entities SET title = ?, fields = ?, body = ?, tags = ?, sort_order = ?, updated_at = ?
         WHERE id = ? AND project_id = ?`,
      )
      .run(
        next.title,
        JSON.stringify(next.fields),
        next.body,
        JSON.stringify(next.tags),
        next.order,
        next.updatedAt,
        next.id,
        projectId,
      );
    return next;
  }

  deleteCard(projectId: string, cardId: string): boolean {
    return this.db.prepare('DELETE FROM entities WHERE id = ? AND project_id = ?').run(cardId, projectId).changes > 0;
  }

  /** Links leaving `cardId`, with the target card resolved. */
  listRelations(projectId: string, cardId: string): Array<{ relation: EntityRelation; card: EntityCard; direction: 'out' }> {
    const rows = this.db
      .prepare(
        `${RELATION_SELECT}
         FROM entity_relations r JOIN entities e ON e.id = r.to_card_id
         WHERE r.project_id = ? AND r.from_card_id = ?
         ORDER BY r.created_at ASC`,
      )
      .all(projectId, cardId) as RelationJoinRow[];
    return rows.map((row) => ({ relation: toRelation(row), card: toJoinedCard(row), direction: 'out' as const }));
  }

  /** Links pointing at `cardId`, with the source card resolved. */
  listBacklinks(
    projectId: string,
    cardId: string,
  ): Array<{ relation: EntityRelation; card: EntityCard; direction: 'in' }> {
    const rows = this.db
      .prepare(
        `${RELATION_SELECT}
         FROM entity_relations r JOIN entities e ON e.id = r.from_card_id
         WHERE r.project_id = ? AND r.to_card_id = ?
         ORDER BY r.created_at ASC`,
      )
      .all(projectId, cardId) as RelationJoinRow[];
    // A backlink is read in the opposite direction, so the pack's inverse label is
    // what the reader should see (角色 出现在 章节 -> 章节 出场于 角色).
    const project = this.db.prepare('SELECT scenario_id FROM projects WHERE id = ?').get(projectId) as
      | { scenario_id: string | null }
      | undefined;
    const pack = project === undefined ? null : this.get(project.scenario_id ?? 'video');
    return rows.map((row) => {
      const relation = toRelation(row);
      const declared =
        relation.relationType === null
          ? undefined
          : pack?.relationTypes.find((candidate) => candidate.key === relation.relationType);
      return {
        relation:
          declared === undefined || declared.inverse === relation.label
            ? relation
            : EntityRelationSchema.parse({ ...relation, label: declared.inverse }),
        card: toJoinedCard(row),
        direction: 'in' as const,
      };
    });
  }

  /**
   * Creates a directed link. Both endpoints must belong to the same project and
   * differ from each other; anything else is rejected rather than silently stored,
   * because a dangling edge would make every later read lie.
   */
  linkCards(
    projectId: string,
    fromCardId: string,
    toCardId: string,
    label: string,
    relationTypeKey?: string,
  ): EntityRelation {
    if (fromCardId === toCardId) throw new Error('SELF_LINK');
    const from = this.getCard(projectId, fromCardId);
    const to = this.getCard(projectId, toCardId);
    if (from === null || to === null) throw new Error('CARD_NOT_FOUND');

    // When the pack declares relation types, a link must name one of them and the
    // endpoints must be allowed by that type. Packs without declarations keep the
    // v0.8 free-text behaviour.
    let resolvedLabel = label;
    if (relationTypeKey !== undefined) {
      const project = this.db.prepare('SELECT scenario_id FROM projects WHERE id = ?').get(projectId) as
        | { scenario_id: string | null }
        | undefined;
      const pack = project === undefined ? null : this.get(project.scenario_id ?? 'video');
      const declared = pack?.relationTypes.find((candidate) => candidate.key === relationTypeKey);
      if (declared === undefined) throw new Error('UNKNOWN_RELATION_TYPE');
      if (declared.fromTypes.length > 0 && !declared.fromTypes.includes(from.type)) {
        throw new Error('RELATION_TYPE_MISMATCH');
      }
      if (declared.toTypes.length > 0 && !declared.toTypes.includes(to.type)) {
        throw new Error('RELATION_TYPE_MISMATCH');
      }
      // Store the forward label so a row is self-describing; the inverse is applied
      // when the relation is read from the other side.
      if (resolvedLabel === '') resolvedLabel = declared.label;
    }
    const relation: EntityRelation = EntityRelationSchema.parse({
      id: randomUUID(),
      projectId,
      fromCardId,
      toCardId,
      relationType: relationTypeKey ?? null,
      label: resolvedLabel,
      createdAt: this.now().toISOString(),
    });
    this.db
      .prepare(
        `INSERT INTO entity_relations (id, project_id, from_card_id, to_card_id, label, relation_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (from_card_id, to_card_id, label) DO NOTHING`,
      )
      .run(
        relation.id,
        projectId,
        fromCardId,
        toCardId,
        resolvedLabel,
        relationTypeKey ?? null,
        relation.createdAt,
      );
    return relation;
  }

  unlinkCards(projectId: string, relationId: string): boolean {
    return (
      this.db.prepare('DELETE FROM entity_relations WHERE id = ? AND project_id = ?').run(relationId, projectId)
        .changes > 0
    );
  }

  /** Card plus its out-links and backlinks; used by the detail drawer. */
  cardWithLinks(projectId: string, cardId: string): EntityCardWithLinks | null {
    const card = this.getCard(projectId, cardId);
    if (card === null) return null;
    return {
      ...card,
      links: [...this.listRelations(projectId, cardId), ...this.listBacklinks(projectId, cardId)],
    };
  }

  /** Flat relation list for the whole project; used by the health analysis. */
  listRelationsForProject(
    projectId: string,
  ): Array<{ id: string; from: string; to: string; label: string; relationType: string | null }> {
    const rows = this.db
      .prepare(
        'SELECT id, from_card_id, to_card_id, label, relation_type FROM entity_relations WHERE project_id = ? ORDER BY created_at ASC',
      )
      .all(projectId) as Array<{
      id: string;
      from_card_id: string;
      to_card_id: string;
      label: string;
      relation_type: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      from: row.from_card_id,
      to: row.to_card_id,
      label: row.label,
      relationType: row.relation_type,
    }));
  }

  /**
   * Whole-project graph: every card as a node, every relation as an edge. Used by the
   * relation view; deliberately one flat query per side rather than per-card lookups.
   */
  projectGraph(projectId: string): {
    nodes: EntityCard[];
    edges: Array<{ id: string; from: string; to: string; label: string; relationType: string | null }>;
  } {
    const nodes = this.listCards(projectId);
    const rows = this.db
      .prepare(
        'SELECT id, from_card_id, to_card_id, label, relation_type FROM entity_relations WHERE project_id = ? ORDER BY created_at ASC',
      )
      .all(projectId) as Array<{
      id: string;
      from_card_id: string;
      to_card_id: string;
      label: string;
      relation_type: string | null;
    }>;
    return {
      nodes,
      edges: rows.map((row) => ({
        id: row.id,
        from: row.from_card_id,
        to: row.to_card_id,
        label: row.label,
        relationType: row.relation_type,
      })),
    };
  }

  countCards(projectId: string): Record<string, number> {
    const rows = this.db
      .prepare('SELECT type, COUNT(*) AS count FROM entities WHERE project_id = ? GROUP BY type')
      .all(projectId) as Array<{ type: string; count: number }>;
    const out: Record<string, number> = {};
    for (const row of rows) out[row.type] = row.count;
    return out;
  }
}
