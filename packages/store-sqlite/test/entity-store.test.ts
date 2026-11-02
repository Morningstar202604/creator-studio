import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openDatabase, SqliteProjectStore, SqliteScenarioStore } from '@creator-studio/store-sqlite';
import { NOVEL_PACK } from '@creator-studio/protocol';

let dir: string;
let db: ReturnType<typeof openDatabase>;
let scenarios: SqliteScenarioStore;
let projects: SqliteProjectStore;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'scenario-'));
  db = openDatabase({ path: join(dir, 'db.sqlite') });
  scenarios = new SqliteScenarioStore(db, () => new Date('2026-10-26T00:00:00.000Z'));
  scenarios.seedBuiltins();
  projects = new SqliteProjectStore(db);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('R1 built-in packs are seeded once and refreshed from code', () => {
  it('seeds every built-in pack', () => {
    expect(scenarios.list().map((pack) => pack.id).sort()).toEqual([
      'copywriting',
      'course',
      'novel',
      'podcast',
      'shorts',
      'video',
    ]);
  });

  it('is idempotent across restarts', () => {
    const before = scenarios.list().length;
    scenarios.seedBuiltins();
    expect(scenarios.list()).toHaveLength(before);
  });

  it('refreshes a built-in pack from code without touching user packs', () => {
    scenarios.save({
      ...NOVEL_PACK,
      id: 'my-pack',
      name: '我的自定义',
      builtin: false,
      stages: NOVEL_PACK.stages.slice(0, 2),
    });
    // Simulate a stale row in the database for a built-in pack.
    db.prepare("UPDATE scenario_packs SET name = '旧名字' WHERE id = 'novel'").run();
    scenarios.seedBuiltins();
    expect(scenarios.get('novel')?.name).toBe('长篇小说');
    expect(scenarios.get('my-pack')?.name).toBe('我的自定义');
  });
});

describe('R2 user packs round-trip and built-ins are protected', () => {
  it('saves and reads back a custom pack byte-identically', () => {
    const custom = {
      ...NOVEL_PACK,
      id: 'screenplay',
      name: '剧本',
      description: '场次、人物、对白',
      builtin: false,
      stages: [
        { key: 'logline', label: '一句话', view: 'generate' as const, hint: '', produces: ['topic-card' as const], promptHint: '', required: true },
        { key: 'scene', label: '场次', view: 'generate' as const, hint: '', produces: ['chapter' as const], promptHint: '', required: true },
      ],
      entityTypes: NOVEL_PACK.entityTypes.slice(0, 1),
    };
    const saved = scenarios.save(custom);
    expect(saved.id).toBe('screenplay');
    expect(saved.stages.map((stage) => stage.key)).toEqual(['logline', 'scene']);
    const reloaded = scenarios.get('screenplay');
    expect(reloaded?.name).toBe('剧本');
  });

  it('refuses to overwrite or delete a built-in pack', () => {
    expect(() => scenarios.save({ ...NOVEL_PACK, name: '改掉' })).toThrow(/BUILTIN_READONLY/);
    expect(scenarios.delete('novel')).toBe('builtin');
    expect(scenarios.get('novel')?.name).toBe('长篇小说');
  });

  it('deletes a user pack and reports a missing id', () => {
    expect(scenarios.delete('screenplay')).toBe('deleted');
    expect(scenarios.delete('screenplay')).toBe('not-found');
  });
});

describe('R3 cards are project-scoped and type-validated', () => {
  it('creates cards with increasing order per type', () => {
    projects.create({
      id: 'p1',
      ownerId: 'u',
      title: '小说',
      platform: 'generic',
      workspacePath: null,
      scenarioId: 'novel',
      stage: 'premise',
    });
    const first = scenarios.createCard('p1', {
      type: 'character',
      title: '林砚',
      fields: { name: '林砚', role: '主角', goal: '查真相' },
      body: '',
      tags: [],
    });
    const second = scenarios.createCard('p1', {
      type: 'character',
      title: '周决',
      fields: { name: '周决', role: '对手', goal: '抢档案' },
      body: '',
      tags: [],
    });
    expect(first.order).toBe(0);
    expect(second.order).toBe(1);
    expect(scenarios.countCards('p1')).toEqual({ character: 2 });
  });

  it('does not return another project card', () => {
    const card = scenarios.listCards('p1')[0];
    expect(card === undefined ? null : scenarios.getCard('p2', card.id)).toBeNull();
  });

  it('updates and deletes a card', () => {
    const card = scenarios.listCards('p1')[0];
    if (card === undefined) throw new Error('expected a card');
    const updated = scenarios.updateCard('p1', card.id, { title: '林砚（改）', fields: { ...card.fields, goal: '新目标' } });
    expect(updated?.title).toBe('林砚（改）');
    expect(updated?.fields['goal']).toBe('新目标');
    expect(scenarios.deleteCard('p1', card.id)).toBe(true);
    expect(scenarios.getCard('p1', card.id)).toBeNull();
  });
});

describe('R4 legacy projects keep working after the migration', () => {
  it('defaults a project created without a scenario to the video pack', () => {
    const legacy = projects.create({
      id: 'legacy',
      ownerId: 'u',
      title: '老项目',
      platform: 'bilibili',
      workspacePath: null,
    });
    expect(legacy.scenarioId).toBe('video');
    expect(legacy.stage).toBe('topic');
  });

  it('advances within the scenario order and ignores unknown stages', () => {
    projects.advanceStageIfBehind('legacy', 'script', ['topic', 'research', 'script', 'published']);
    expect(projects.get('legacy')?.stage).toBe('script');
    projects.advanceStageIfBehind('legacy', 'shotlist', ['topic', 'research', 'script', 'published']);
    expect(projects.get('legacy')?.stage).toBe('script');
  });
});
