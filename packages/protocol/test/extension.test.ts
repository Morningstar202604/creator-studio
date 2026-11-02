import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PACKS,
  COPYWRITING_PACK,
  MAX_INHERIT_DEPTH,
  NOVEL_PACK,
  PACK_FORMAT_VERSION,
  SHORTS_PACK,
  STAGE_VIEWS,
  ScenarioPackSchema,
  negotiatePack,
  packViews,
  resolveInheritance,
  type ScenarioPack,
} from '../src/index.js';

const parsedBuiltins: ScenarioPack[] = BUILTIN_PACKS.map((pack) => ScenarioPackSchema.parse(pack));
const byId = (id: string): ScenarioPack | undefined => parsedBuiltins.find((pack) => pack.id === id);

describe('R1 packs negotiate the engine views they need', () => {
  it('every built-in pack only uses views this build ships', () => {
    for (const pack of parsedBuiltins) {
      const report = negotiatePack(pack, STAGE_VIEWS);
      expect(report.ok, pack.id).toBe(true);
      expect(report.missingViews, pack.id).toEqual([]);
    }
  });

  it('rejects an unknown view at the schema boundary', () => {
    // First line of defence: a pack cannot even be parsed with a view the engine has
    // never heard of, so an import can never smuggle in a demand for new code.
    expect(() =>
      ScenarioPackSchema.parse({
        id: 'future',
        name: '未来场景',
        stages: [
          { key: 'a', label: 'A', view: 'generate', required: true },
          { key: 'b', label: 'B', view: 'timeline' },
        ],
      }),
    ).toThrow();
  });

  it('reports a view gap when an older engine meets a newer pack', () => {
    // A pack that is valid for a future engine (board view) but loaded by one that
    // only knows generate/entities: negotiation names the missing view instead of
    // silently rendering nothing.
    const boardPack = ScenarioPackSchema.parse({
      id: 'needs-board',
      name: '需要看板',
      stages: [
        { key: 'a', label: 'A', view: 'generate', required: true },
        { key: 'b', label: 'B', view: 'board', entityType: 'thing' },
      ],
      entityTypes: [
        {
          key: 'thing',
          label: '东西',
          titleField: 'name',
          fields: [{ key: 'name', label: '名称', type: 'text', required: true }],
        },
      ],
    });
    const report = negotiatePack(boardPack, ['generate', 'entities']);
    expect(report.ok).toBe(false);
    expect(report.missingViews).toEqual(['board']);
    // And it passes against the real engine.
    expect(negotiatePack(boardPack, STAGE_VIEWS).ok).toBe(true);
  });

  it('collects the implicit generate default too', () => {
    const pack = ScenarioPackSchema.parse({
      id: 'implicit',
      name: '隐式',
      stages: [
        { key: 'a', label: 'A', required: true },
        { key: 'b', label: 'B', view: 'publish' },
      ],
    });
    expect(packViews(pack).sort()).toEqual(['generate', 'publish']);
  });

  it('declares a pack format version and records the current one', () => {
    expect(parsedBuiltins.every((pack) => pack.formatVersion === PACK_FORMAT_VERSION)).toBe(true);
    expect(PACK_FORMAT_VERSION).toBeGreaterThanOrEqual(2);
  });
});

describe('R2 inheritance merges a parent pack', () => {
  it('prepends inherited stages and entity types', () => {
    const child = ScenarioPackSchema.parse({
      id: 'novel-romance',
      name: '言情长篇',
      inherits: 'novel',
      stages: [{ key: 'relationship', label: '感情线', view: 'generate', required: false }],
    });
    const resolved = resolveInheritance(child, byId);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.pack.stages.map((stage) => stage.key)).toEqual([
      'premise',
      'world',
      'outline',
      'chapter',
      'revision',
      'published',
      'relationship',
    ]);
    expect(resolved.pack.entityTypes.map((entity) => entity.key)).toEqual([
      'character',
      'chapter',
      'location',
      'foreshadow',
    ]);
  });

  it('lets the child override a stage with the same key', () => {
    const child = ScenarioPackSchema.parse({
      id: 'novel-tight',
      name: '紧凑版',
      inherits: 'novel',
      stages: [{ key: 'chapter', label: '正文', view: 'entities', entityType: 'chapter', required: true }],
    });
    const resolved = resolveInheritance(child, byId);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const chapter = resolved.pack.stages.filter((stage) => stage.key === 'chapter');
    expect(chapter).toHaveLength(1);
    expect(chapter[0]?.label).toBe('正文');
  });

  it('rejects a missing parent', () => {
    const child = ScenarioPackSchema.parse({
      id: 'orphan',
      name: '孤儿',
      inherits: 'does-not-exist',
      stages: [{ key: 'a', label: 'A', required: true }],
    });
    const resolved = resolveInheritance(child, byId);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.message).toContain('unknown parent');
  });

  it('rejects a two-node cycle', () => {
    const a = ScenarioPackSchema.parse({
      id: 'a-pack',
      name: 'A',
      inherits: 'b-pack',
      stages: [{ key: 'a', label: 'A', required: true }],
    });
    const b = ScenarioPackSchema.parse({
      id: 'b-pack',
      name: 'B',
      inherits: 'a-pack',
      stages: [{ key: 'b', label: 'B', required: true }],
    });
    const lookup = (id: string): ScenarioPack | undefined => (id === 'a-pack' ? a : id === 'b-pack' ? b : undefined);
    const resolved = resolveInheritance(a, lookup);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.message).toMatch(/cycle/);
  });

  it('stops at the depth limit', () => {
    const chain: ScenarioPack[] = [];
    for (let index = 0; index < MAX_INHERIT_DEPTH + 2; index += 1) {
      chain.push(
        ScenarioPackSchema.parse({
          id: `p${index}`,
          name: `P${index}`,
          ...(index === 0 ? {} : { inherits: `p${index - 1}` }),
          stages: [
            { key: `s${index}`, label: `S${index}`, required: true },
            { key: `s${index}-b`, label: `S${index}B`, view: 'publish' },
          ],
        }),
      );
    }
    const top = chain[chain.length - 1] as ScenarioPack;
    const resolved = resolveInheritance(top, (id) => chain.find((pack) => pack.id === id));
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.message).toContain('deeper than');
  });
});

describe('R3 packs declare relation types with an inverse label', () => {
  it('the novel pack declares typed links with inverses', () => {
    const novel = byId('novel');
    expect(novel?.relationTypes.map((relation) => relation.key)).toEqual([
      'appears-in',
      'plants',
      'pays-off',
      'located-in',
    ]);
    const appearsIn = novel?.relationTypes.find((relation) => relation.key === 'appears-in');
    expect(appearsIn?.label).toBe('出现在');
    expect(appearsIn?.inverse).toBe('出场于');
    expect(appearsIn?.fromTypes).toEqual(['character']);
    expect(appearsIn?.toTypes).toEqual(['chapter']);
  });

  it('packs without declared relations keep the free-text behaviour', () => {
    const copy = byId('copywriting');
    expect(copy?.relationTypes).toEqual([]);
  });
});

describe('R4 board stages declare a grouping field', () => {
  it('the novel chapter stage groups by the chapter status field', () => {
    const novel = byId('novel');
    const chapterStage = novel?.stages.find((stage) => stage.key === 'chapter');
    expect(chapterStage?.view).toBe('document');
    expect(chapterStage?.document?.orderField).toBe('number');
    expect(chapterStage?.entityType).toBe('chapter');
    expect(chapterStage?.board?.groupBy).toBe('status');
    expect(chapterStage?.board?.order).toEqual(['待写', '草稿', '修订中', '定稿']);
  });

  it('rejects a board stage whose entity type does not exist', () => {
    // v0.13 moved this from "the UI copes" to a pack error: an empty board with no
    // explanation is worse than refusing the pack, and the message names the cause.
    const parsed = ScenarioPackSchema.safeParse({
      id: 'bad-board',
      name: '坏看板',
      stages: [
        { key: 'a', label: 'A', view: 'board', entityType: 'missing', board: { groupBy: 'status' }, required: true },
        { key: 'b', label: 'B', view: 'publish' },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a board that groups by a field that is not a select', () => {
    const parsed = ScenarioPackSchema.safeParse({
      id: 'bad-group',
      name: '坏分组',
      stages: [
        { key: 'a', label: 'A', view: 'board', entityType: 'thing', board: { groupBy: 'name' }, required: true },
        { key: 'b', label: 'B', view: 'publish' },
      ],
      entityTypes: [
        {
          key: 'thing',
          label: '东西',
          titleField: 'name',
          fields: [{ key: 'name', label: '名称', type: 'text', required: true }],
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('R5 the two new packs are data-only additions', () => {
  it('ships six built-in packs covering video, novel, podcast, course, copy and shorts', () => {
    expect(parsedBuiltins.map((pack) => pack.id)).toEqual([
      'video',
      'novel',
      'podcast',
      'course',
      'copywriting',
      'shorts',
    ]);
  });

  it('copywriting uses only existing views and declares its own cards', () => {
    const copy = byId('copywriting');
    expect(negotiatePack(copy as ScenarioPack, STAGE_VIEWS).ok).toBe(true);
    expect(copy?.entityTypes.map((entity) => entity.key)).toEqual(['asset', 'persona']);
    expect(copy?.defaultPlatform).toBe('xiaohongshu');
  });

  it('shorts declares a shot board and a subtitle stage', () => {
    const shorts = byId('shorts');
    expect(shorts?.entityTypes.map((entity) => entity.key)).toEqual(['shot']);
    expect(shorts?.stages.some((stage) => stage.produces.includes('subtitle'))).toBe(true);
  });

  it('keeps the raw input shape valid so a user can copy a built-in as a template', () => {
    for (const input of [COPYWRITING_PACK, SHORTS_PACK, NOVEL_PACK]) {
      expect(() => ScenarioPackSchema.parse({ ...input, id: `${input.id}-copy`, builtin: false })).not.toThrow();
    }
  });
});

describe('R6 writing stages declare where the prose lives', () => {
  it('rejects a writing stage whose prose field is not on the card type', () => {
    const parsed = ScenarioPackSchema.safeParse({
      id: 'bad-doc',
      name: '坏写作',
      stages: [
        { key: 'a', label: 'A', view: 'generate', required: true },
        { key: 'write', label: '写', view: 'document', entityType: 'chapter', document: { bodyField: 'nope' } },
      ],
      entityTypes: [
        {
          key: 'chapter',
          label: '章节',
          titleField: 'title',
          fields: [{ key: 'title', label: '标题', type: 'text', required: true }],
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a writing stage that points at no card type', () => {
    const parsed = ScenarioPackSchema.safeParse({
      id: 'no-entity',
      name: '没有卡片',
      stages: [
        { key: 'a', label: 'A', view: 'generate', required: true },
        { key: 'write', label: '写', view: 'document' },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a writing stage that keeps prose in the card body', () => {
    const parsed = ScenarioPackSchema.parse({
      id: 'screenplay',
      name: '剧本',
      stages: [
        { key: 'logline', label: '一句话', view: 'generate', required: true },
        { key: 'scene', label: '场次', view: 'document', entityType: 'scene', document: { orderField: 'index' } },
      ],
      entityTypes: [
        {
          key: 'scene',
          label: '场次',
          titleField: 'slug',
          fields: [
            { key: 'slug', label: '场次号', type: 'text', required: true },
            { key: 'index', label: '顺序', type: 'number' },
          ],
        },
      ],
    });
    expect(negotiatePack(parsed, STAGE_VIEWS).ok).toBe(true);
    expect(parsed.stages[1]?.document?.orderField).toBe('index');
  });
});
