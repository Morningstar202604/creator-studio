import { z } from 'zod';

/**
 * A scenario pack describes what a project *is*: its stages, the cards it keeps
 * and which content artifacts it produces. The video pipeline ships as one pack
 * rather than being wired into the schema, so a novel, a podcast or a course can
 * reuse the same engine without touching it.
 */

/** Stage keys stay URL-safe because the workspace route is `/:projectId/:stage`. */
const StageKey = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9-]*$/, 'stage keys are lowercase letters, digits and dashes');

const PackId = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-z][a-z0-9-]*$/, 'pack ids are lowercase letters, digits and dashes');

export const FieldTypeSchema = z.enum(['text', 'longtext', 'number', 'select', 'tags', 'date', 'url']);
export type FieldType = z.infer<typeof FieldTypeSchema>;

export const EntityFieldSchema = z.object({
  key: z.string().min(1).max(32).regex(/^[a-z][a-z0-9_]*$/, 'field keys are snake_case'),
  label: z.string().min(1).max(40),
  type: FieldTypeSchema,
  required: z.boolean().default(false),
  /** Only meaningful for `select`. */
  options: z.array(z.string().min(1).max(40)).max(30).default([]),
  placeholder: z.string().max(120).default(''),
  /** Renders full width in the card editor. */
  wide: z.boolean().default(false),
});
export type EntityField = z.infer<typeof EntityFieldSchema>;

export const EntityTypeSchema = z.object({
  key: z.string().min(1).max(32).regex(/^[a-z][a-z0-9-]*$/, 'entity keys are kebab-case'),
  label: z.string().min(1).max(30),
  /** Optional plural; empty means "same as label", which the UI falls back to. */
  labelPlural: z.string().max(30).default(''),
  /** Shown in the empty state so the user knows what this card is for. */
  hint: z.string().max(200).default(''),
  icon: z.string().max(4).default(''),
  /** Field painted as the card title; must exist in `fields`. */
  titleField: z.string().min(1).max(32),
  fields: z.array(EntityFieldSchema).min(1).max(20),
  /** Rendered as a compact chip row under the title in list view. */
  summaryFields: z.array(z.string().min(1).max(32)).max(4).default([]),
});
export type EntityType = z.infer<typeof EntityTypeSchema>;

/**
 * The engine's view vocabulary. This list is the contract: a pack may only name a
 * view that appears here, so importing a pack never requires running code this
 * build does not already have. Adding a scenario means composing these views.
 */
export const STAGE_VIEWS = ['generate', 'entities', 'publish', 'review', 'board', 'document'] as const;
export const StageViewSchema = z.enum(STAGE_VIEWS);
export type StageView = z.infer<typeof StageViewSchema>;

/** Bumped when a pack shape change would break older readers. */
export const PACK_FORMAT_VERSION = 2;
/** Highest pack format this build can read. */
export const MAX_SUPPORTED_PACK_FORMAT = 2;

/** A declared link type; `inverse` is the label shown on the other end. */
export const RelationTypeSchema = z.object({
  key: z.string().min(1).max(32).regex(/^[a-z][a-z0-9-]*$/, 'relation keys are kebab-case'),
  label: z.string().min(1).max(20),
  inverse: z.string().min(1).max(20),
  /** Restrict which entity types may use it; empty means any. */
  fromTypes: z.array(z.string().min(1).max(32)).max(12).default([]),
  toTypes: z.array(z.string().min(1).max(32)).max(12).default([]),
});
export type RelationType = z.infer<typeof RelationTypeSchema>;

/** Board grouping: which select field supplies the columns. */
export const BoardConfigSchema = z.object({
  /** Field key on the stage's entity type; must be a select field. */
  groupBy: z.string().min(1).max(32),
  /** Optional explicit column order; unknown values are appended. */
  order: z.array(z.string().min(1).max(40)).max(30).default([]),
});
export type BoardConfig = z.infer<typeof BoardConfigSchema>;

/**
 * Writing surface: which card field holds the prose. Declared per stage so the
 * same `document` view serves a novel chapter, a lesson handout or a screenplay
 * scene without the engine knowing what any of them mean.
 */
export const DocumentConfigSchema = z.object({
  /** Field key holding the long-form text; absent means the card `body`. */
  bodyField: z.string().min(1).max(32).optional(),
  /** Field key used as the heading; absent means the card title. */
  titleField: z.string().min(1).max(32).optional(),
  /** Field key ordering the manuscript; absent means the card `order` column. */
  orderField: z.string().min(1).max(32).optional(),
  /** Word file name stem; absent means the pack id. */
  fileStem: z.string().min(1).max(40).regex(/^[a-z0-9][a-z0-9-]*$/, 'file stems are lowercase').optional(),
});
export type DocumentConfig = z.infer<typeof DocumentConfigSchema>;

export const ScenarioStageSchema = z.object({
  key: StageKey,
  label: z.string().min(1).max(20),
  /** Absent means `generate`, so packs written before views existed still work. */
  view: StageViewSchema.optional(),
  /** Required when view is `entities`, `board` or `document`: which entity type to show. */
  entityType: z.string().min(1).max(32).optional(),
  /** Required when view is `board`: which select field becomes the columns. */
  board: BoardConfigSchema.optional(),
  /** Required when view is `document`: where the prose lives and how it is ordered. */
  document: DocumentConfigSchema.optional(),
  /** One line shown under the page title. */
  hint: z.string().max(160).default(''),
  /** Artifact kinds this stage produces; may be empty for stages like "修订". */
  produces: z
    .array(
      z.enum([
        'topic-card',
        'research-notes',
        'script',
        'shot-list',
        'subtitle',
        'publish-pack',
        'review-report',
        'outline',
        'chapter',
        'other',
      ]),
    )
    .max(4)
    .default([]),
  /** Free-form guidance injected into the generation prompt for this stage. */
  promptHint: z.string().max(600).default(''),
  /** Required stages gate the publish checklist. */
  required: z.boolean().default(false),
});
export type ScenarioStage = z.infer<typeof ScenarioStageSchema>;

export const ScenarioPackSchema = z
  .object({
    id: PackId,
    name: z.string().min(1).max(40),
    /** One-sentence description shown in the project-create picker. */
    description: z.string().max(160).default(''),
    icon: z.string().max(4).default(''),
    /** Which built-in pack this one derives from; null for the shipped four. */
    builtin: z.boolean().default(false),
    /** Pack shape version; older packs are read as version 1. */
    formatVersion: z.number().int().min(1).max(MAX_SUPPORTED_PACK_FORMAT).default(PACK_FORMAT_VERSION),
    /**
     * Views this pack uses. Declared explicitly so an importer can reject a pack
     * that needs a view the running build does not have, without guessing from
     * stage contents.
     */
    requiresViews: z.array(StageViewSchema).max(STAGE_VIEWS.length).default([]),
    /** Id of a pack whose stages and entity types are inherited before this one. */
    inherits: z.string().min(1).max(48).optional(),
    /** Declared link types; empty keeps the free-text behaviour of v0.8. */
    relationTypes: z.array(RelationTypeSchema).max(20).default([]),
    /**
     * Two stages minimum for a standalone pack; a pack that inherits only needs to
     * add what it changes, since the parent supplies the rest.
     */
    stages: z.array(ScenarioStageSchema).min(1).max(12),
    entityTypes: z.array(EntityTypeSchema).max(12).default([]),
    /** Default platform for new projects of this scenario. */
    defaultPlatform: z.enum(['bilibili', 'youtube', 'xiaohongshu', 'generic']).default('generic'),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .superRefine((pack, ctx) => {
    const stageKeys = new Set<string>();
    for (const stage of pack.stages) {
      if (stageKeys.has(stage.key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate stage key ${stage.key}`, path: ['stages'] });
      }
      stageKeys.add(stage.key);
    }
    // A standalone pack needs a real pipeline; an inheriting pack only ships deltas.
    if (pack.inherits === undefined && pack.stages.length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a standalone pack needs at least 2 stages (or declare inherits)',
        path: ['stages'],
      });
    }
    // Without a required stage the publish checklist would be vacuously green.
    // An inheriting pack may inherit its required stages from the parent.
    if (pack.inherits === undefined && !pack.stages.some((stage) => stage.required)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'at least one stage must be required', path: ['stages'] });
    }
    const entityKeys = new Set<string>();
    for (const entity of pack.entityTypes) {
      if (entityKeys.has(entity.key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate entity key ${entity.key}`, path: ['entityTypes'] });
      }
      entityKeys.add(entity.key);
      const fieldKeys = new Set(entity.fields.map((field) => field.key));
      if (!fieldKeys.has(entity.titleField)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `titleField ${entity.titleField} is not one of the fields`,
          path: ['entityTypes'],
        });
      }
      for (const summary of entity.summaryFields) {
        if (!fieldKeys.has(summary)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `summaryField ${summary} is not one of the fields`,
            path: ['entityTypes'],
          });
        }
      }
      for (const field of entity.fields) {
        if (field.type === 'select' && field.options.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `select field ${field.key} needs options`,
            path: ['entityTypes'],
          });
        }
      }
    }
    // A writing stage names a card type and optionally points at the fields that
    // hold prose, heading and order. A typo there would silently render an empty
    // editor, so the pack is rejected instead.
    for (const stage of pack.stages) {
      const writesProse = stageView(stage) === 'document' || stage.document !== undefined;
      if (!writesProse) continue;
      const entity = pack.entityTypes.find((candidate) => candidate.key === stage.entityType);
      if (entity === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `writing stage ${stage.key} needs an entityType declared in this pack`,
          path: ['stages'],
        });
        continue;
      }
      const fieldKeys = new Set(entity.fields.map((field) => field.key));
      for (const key of [stage.document?.bodyField, stage.document?.titleField, stage.document?.orderField]) {
        if (key !== undefined && !fieldKeys.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `document field ${key} is not on entity type ${entity.key}`,
            path: ['stages'],
          });
        }
      }
    }
    // A board groups by one select field; pointing it at a missing field or at a
    // free-text field would produce a single "未分组" column with no explanation.
    for (const stage of pack.stages) {
      if (stage.board === undefined) continue;
      const entity =
        stage.entityType === undefined
          ? undefined
          : pack.entityTypes.find((candidate) => candidate.key === stage.entityType);
      if (entity === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `board stage ${stage.key} needs an entityType declared in this pack`,
          path: ['stages'],
        });
        continue;
      }
      const groupField = entity.fields.find((field) => field.key === stage.board?.groupBy);
      if (groupField === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `board groupBy ${stage.board.groupBy} is not on entity type ${entity.key}`,
          path: ['stages'],
        });
      } else if (groupField.type !== 'select') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `board groupBy ${stage.board.groupBy} must be a select field`,
          path: ['stages'],
        });
      }
    }
  });
export type ScenarioPack = z.infer<typeof ScenarioPackSchema>;
/** Authoring shape: defaults are optional here and filled by parse(). */
export type ScenarioPackInput = z.input<typeof ScenarioPackSchema>;
export type ScenarioStageInput = z.input<typeof ScenarioStageSchema>;
export type EntityTypeInput = z.input<typeof EntityTypeSchema>;
export type RelationTypeInput = z.input<typeof RelationTypeSchema>;

/** Views a stage actually needs, including the implicit default. */
export function packViews(pack: ScenarioPack): StageView[] {
  const used = new Set<StageView>(pack.requiresViews);
  for (const stage of pack.stages) used.add(stageView(stage));
  return [...used];
}

export type PackCapabilityReport = {
  ok: boolean;
  /** Views the pack asks for that this build does not implement. */
  missingViews: StageView[];
  /** Declared capabilities that are not part of this build. */
  missingCapabilities: string[];
};

/**
 * Negotiation between a pack and the running engine. A pack can only use what the
 * engine already ships; there is no code loading, so an unknown view is a hard
 * rejection rather than something to be resolved at runtime.
 */
export function negotiatePack(pack: ScenarioPack, supported: readonly StageView[]): PackCapabilityReport {
  const supportedSet = new Set<string>(supported);
  const missingViews = packViews(pack).filter((view) => !supportedSet.has(view));
  const missingCapabilities = pack.requiresViews.filter((view) => !supportedSet.has(view));
  return {
    ok: missingViews.length === 0,
    missingViews: [...new Set(missingViews)],
    missingCapabilities: [...new Set(missingCapabilities)],
  };
}

export const MAX_INHERIT_DEPTH = 4;

export type InheritResult = { ok: true; pack: ScenarioPack } | { ok: false; message: string };

/**
 * Resolves `inherits` by prepending the parent's stages and entity types. Depth-first
 * with a visited set so a pack cannot inherit from itself, directly or transitively.
 */
export function resolveInheritance(
  pack: ScenarioPack,
  lookup: (id: string) => ScenarioPack | undefined,
  depth = 0,
  visited: ReadonlySet<string> = new Set<string>(),
): InheritResult {
  if (pack.inherits === undefined) return { ok: true, pack };
  if (depth >= MAX_INHERIT_DEPTH) return { ok: false, message: `inheritance deeper than ${MAX_INHERIT_DEPTH}` };
  if (visited.has(pack.id)) return { ok: false, message: `inheritance cycle at ${pack.id}` };
  const parent = lookup(pack.inherits);
  if (parent === undefined) return { ok: false, message: `unknown parent pack ${pack.inherits}` };

  const nextVisited = new Set(visited);
  nextVisited.add(pack.id);
  const resolvedParent = resolveInheritance(parent, lookup, depth + 1, nextVisited);
  if (!resolvedParent.ok) return resolvedParent;

  const stageKeys = new Set(pack.stages.map((stage) => stage.key));
  const entityKeys = new Set(pack.entityTypes.map((entity) => entity.key));
  return {
    ok: true,
    pack: {
      ...pack,
      stages: [...resolvedParent.pack.stages.filter((stage) => !stageKeys.has(stage.key)), ...pack.stages],
      entityTypes: [
        ...resolvedParent.pack.entityTypes.filter((entity) => !entityKeys.has(entity.key)),
        ...pack.entityTypes,
      ],
      relationTypes: [
        ...resolvedParent.pack.relationTypes.filter(
          (relation) => !pack.relationTypes.some((own) => own.key === relation.key),
        ),
        ...pack.relationTypes,
      ],
    },
  };
}

/** Resolved view for a stage; the single place the default lives. */
export function stageView(stage: ScenarioStage): StageView {
  return stage.view ?? 'generate';
}

/** Whole-card payload cap; keeps a runaway paste from bloating the database. */
export const ENTITY_VALUE_LIMIT = 2_000;
export const ENTITY_PAYLOAD_LIMIT = 8_000;

export const EntityCardInputSchema = z.object({
  type: z.string().min(1).max(32),
  title: z.string().min(1).max(120),
  fields: z.record(z.string(), z.string().max(ENTITY_VALUE_LIMIT)),
  /** Free-form Markdown body for long material (backstory, chapter text). */
  body: z.string().max(20_000).default(''),
  tags: z.array(z.string().min(1).max(20)).max(12).default([]),
});
export type EntityCardInput = z.infer<typeof EntityCardInputSchema>;

export const EntityCardSchema = EntityCardInputSchema.extend({
  id: z.string().min(1),
  projectId: z.string().min(1),
  /** Position within its column/board; lower comes first. */
  order: z.number().int().nonnegative(),
  /**
   * Row version, bumped on every write. A client echoes the revision it read and
   * the daemon refuses the write when the row has moved on, which is what stops
   * two editors from silently overwriting each other.
   */
  revision: z.number().int().positive().default(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type EntityCard = z.infer<typeof EntityCardSchema>;

/**
 * One stored past state of a card. `revision` is the version this snapshot
 * represents, so "restore to revision 7" is unambiguous.
 */
export const EntityRevisionSchema = z.object({
  id: z.string().min(1),
  entityId: z.string().min(1),
  projectId: z.string().min(1),
  revision: z.number().int().positive(),
  title: z.string(),
  fields: z.record(z.string(), z.string()),
  body: z.string(),
  tags: z.array(z.string()),
  reason: z.enum(['save', 'restore', 'conflict']),
  createdAt: z.string(),
});
export type EntityRevision = z.infer<typeof EntityRevisionSchema>;

/**
 * Body of a conditional card update. `expectedRevision` is mandatory when the
 * caller wants conflict detection; omitting it keeps the old unconditional
 * behaviour for internal callers such as drag-and-drop reordering.
 */
export const EntityCardPatchSchema = EntityCardInputSchema.partial().extend({
  order: z.number().int().nonnegative().optional(),
  expectedRevision: z.number().int().positive().optional(),
  /** Set when the client already resolved a conflict by merging; recorded in history. */
  reason: z.enum(['save', 'restore', 'conflict']).optional(),
});
export type EntityCardPatch = z.infer<typeof EntityCardPatchSchema>;

/** A directed link between two cards in the same project. */
export const EntityRelationSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  fromCardId: z.string().min(1),
  toCardId: z.string().min(1),
  /** Declared relation type key, when the pack declares relation types. */
  relationType: z.string().max(32).nullable().default(null),
  /** Human label in the direction this row was read (forward or inverse). */
  label: z.string().max(40).default(''),
  createdAt: z.string(),
});
export type EntityRelation = z.infer<typeof EntityRelationSchema>;

export const RelationInputSchema = z.object({
  toCardId: z.string().min(1),
  /** Declared type key; omit to keep the v0.8 free-text behaviour. */
  relationType: z.string().trim().max(32).optional(),
  label: z.string().trim().max(40).default(''),
});
export type RelationInput = z.infer<typeof RelationInputSchema>;

/** A card plus everything it points at and everything pointing at it. */
export type EntityCardWithLinks = EntityCard & {
  links: Array<{ relation: EntityRelation; card: EntityCard; direction: 'out' | 'in' }>;
};

export function entityPayloadSize(card: EntityCardInput): number {
  const payload = JSON.stringify(card.fields);
  return payload.length + card.body.length + JSON.stringify(card.tags).length;
}

/** Validates a card against the scenario's entity type and reports the first problem. */
export function validateCardAgainstType(
  input: EntityCardInput,
  entityType: EntityType | undefined,
): { ok: true } | { ok: false; message: string } {
  if (entityType === undefined) return { ok: false, message: `unknown entity type ${input.type}` };
  if (entityPayloadSize(input) > ENTITY_PAYLOAD_LIMIT) {
    return { ok: false, message: `card payload exceeds ${ENTITY_PAYLOAD_LIMIT} characters` };
  }
  const known = new Set(entityType.fields.map((field) => field.key));
  for (const key of Object.keys(input.fields)) {
    if (!known.has(key)) return { ok: false, message: `unknown field ${key}` };
  }
  for (const field of entityType.fields) {
    if (!field.required) continue;
    const value = input.fields[field.key] ?? '';
    if (value.trim() === '') return { ok: false, message: `field ${field.label} is required` };
  }
  if (input.title.trim() === '') return { ok: false, message: 'title is required' };
  return { ok: true };
}
