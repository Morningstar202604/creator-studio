import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PACKS,
  EntityCardInputSchema,
  ScenarioPackSchema,
  entityPayloadSize,
  stageView,
  validateCardAgainstType,
  NOVEL_PACK,
  VIDEO_PACK,
  COURSE_PACK,
  PODCAST_PACK,
} from '../src/index.js';

describe('R1 built-in packs are valid and scenario-shaped', () => {
  it('every built-in pack passes the schema', () => {
    for (const pack of BUILTIN_PACKS) {
      expect(() => ScenarioPackSchema.parse(pack), pack.id).not.toThrow();
    }
  });

  it('the video pack keeps the exact legacy stage keys', () => {
    expect(VIDEO_PACK.stages.map((stage) => stage.key)).toEqual([
      'topic',
      'research',
      'script',
      'shotlist',
      'package',
      'published',
      'review',
    ]);
  });

  it('the novel pack has no video stage and does have card types', () => {
    const keys = NOVEL_PACK.stages.map((stage) => stage.key);
    expect(keys).not.toContain('shotlist');
    expect(keys).not.toContain('script');
    expect(keys).toEqual(['premise', 'world', 'outline', 'chapter', 'revision', 'published']);
    expect(NOVEL_PACK.entityTypes.map((type) => type.key)).toEqual(['character', 'chapter', 'location', 'foreshadow']);
  });

  it('ships several distinct packs so the engine is not video-shaped', () => {
    expect(BUILTIN_PACKS.map((pack) => pack.id)).toEqual([
      'video',
      'novel',
      'podcast',
      'course',
      'copywriting',
      'shorts',
    ]);
    expect(PODCAST_PACK.entityTypes.map((type) => type.key)).toEqual(['guest', 'question']);
    expect(COURSE_PACK.entityTypes.map((type) => type.key)).toEqual(['lesson', 'exercise']);
  });

  it('resolves views with generate as the default', () => {
    expect(stageView({ key: 'x', label: 'X', hint: '', produces: [], promptHint: '', required: true })).toBe('generate');
    const chapter = NOVEL_PACK.stages.find((stage) => stage.key === 'chapter');
    // v0.12 made chapters a writing surface; the board config rides along so the
    // same cards can still be viewed as a status board.
    expect(chapter === undefined ? null : stageView(chapter)).toBe('document');
  });
});

describe('R2 pack validation rejects shapes that would break the UI', () => {
  const base = {
    id: 'custom',
    name: '自定义',
    description: '',
    icon: '🧪',
    builtin: false,
    defaultPlatform: 'generic' as const,
    entityTypes: [],
  };

  it('rejects a pack with fewer than two stages', () => {
    const parsed = ScenarioPackSchema.safeParse({
      ...base,
      stages: [{ key: 'only', label: '唯一', produces: [], promptHint: '', required: true }],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a pack where nothing is required', () => {
    const parsed = ScenarioPackSchema.safeParse({
      ...base,
      stages: [
        { key: 'a', label: 'A', produces: [], promptHint: '', required: false },
        { key: 'b', label: 'B', produces: [], promptHint: '', required: false },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects duplicate stage keys', () => {
    const parsed = ScenarioPackSchema.safeParse({
      ...base,
      stages: [
        { key: 'same', label: 'A', produces: [], promptHint: '', required: true },
        { key: 'same', label: 'B', produces: [], promptHint: '', required: false },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a titleField that is not declared', () => {
    const parsed = ScenarioPackSchema.safeParse({
      ...base,
      stages: [
        { key: 'a', label: 'A', produces: [], promptHint: '', required: true },
        { key: 'b', label: 'B', produces: [], promptHint: '', required: false },
      ],
      entityTypes: [
        {
          key: 'thing',
          label: '东西',
          titleField: 'missing',
          fields: [{ key: 'name', label: '名称', type: 'text', required: true, options: [], placeholder: '', wide: false }],
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a select field without options', () => {
    const parsed = ScenarioPackSchema.safeParse({
      ...base,
      stages: [
        { key: 'a', label: 'A', produces: [], promptHint: '', required: true },
        { key: 'b', label: 'B', produces: [], promptHint: '', required: false },
      ],
      entityTypes: [
        {
          key: 'thing',
          label: '东西',
          titleField: 'name',
          fields: [{ key: 'name', label: '名称', type: 'select', required: true, options: [], placeholder: '', wide: false }],
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('R3 card validation against a scenario type', () => {
  const character = NOVEL_PACK.entityTypes.find((type) => type.key === 'character');

  it('accepts a well-formed character card', () => {
    const card = EntityCardInputSchema.parse({
      type: 'character',
      title: '林砚',
      fields: { name: '林砚', role: '主角', goal: '查清父亲失踪' },
      tags: [],
    });
    expect(validateCardAgainstType(card, character)).toEqual({ ok: true });
  });

  it('rejects a missing required field', () => {
    const card = EntityCardInputSchema.parse({
      type: 'character',
      title: '林砚',
      fields: { name: '林砚', role: '主角' },
    });
    const result = validateCardAgainstType(card, character);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('想要什么');
  });

  it('rejects an unknown field key', () => {
    const card = EntityCardInputSchema.parse({
      type: 'character',
      title: '林砚',
      fields: { name: '林砚', role: '主角', goal: 'x', spaceship: 'y' },
    });
    const result = validateCardAgainstType(card, character);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('unknown field');
  });

  it('rejects an unknown entity type', () => {
    const card = EntityCardInputSchema.parse({ type: 'spaceship', title: 'X', fields: {} });
    const result = validateCardAgainstType(card, undefined);
    expect(result.ok).toBe(false);
  });

  it('caps a runaway payload', () => {
    const card = EntityCardInputSchema.parse({
      type: 'character',
      title: '林砚',
      fields: { name: '林砚', role: '主角', goal: 'x'.repeat(1_900), fear: 'y'.repeat(1_900), secret: 'z'.repeat(1_900) },
      body: 'b'.repeat(5_000),
    });
    expect(entityPayloadSize(card)).toBeGreaterThan(8_000);
    const result = validateCardAgainstType(card, character);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('payload');
  });
});
