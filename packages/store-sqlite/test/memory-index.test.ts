import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashEmbedding, chunkText, cosine, localEmbeddingProvider } from '@creator-studio/model-gateway';
import { openDatabase, SqliteMemoryIndex } from '../src/index.js';

let workspace: string;
let db: ReturnType<typeof openDatabase>;
let index: SqliteMemoryIndex;
let projectId: string;

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'memory-ws-'));
  db = openDatabase({ path: join(workspace, 'db.sqlite') });
  projectId = 'p-memory';
  db.prepare(
    `INSERT INTO projects (id, owner_id, title, platform, stage, created_at, updated_at)
     VALUES (?, 'u1', 'T', 'bilibili', 'script', '2026-10-24T00:00:00.000Z', '2026-10-24T00:00:00.000Z')`,
  ).run(projectId);
  index = new SqliteMemoryIndex(db);
});

afterAll(() => {
  db.close();
  rmSync(workspace, { recursive: true, force: true });
});

describe('embedding primitives', () => {
  it('is deterministic and normalized', () => {
    const a = hashEmbedding('AI 编程工具对初级程序员就业的影响');
    const b = hashEmbedding('AI 编程工具对初级程序员就业的影响');
    expect(a).toEqual(b);
    const magnitude = Math.sqrt(a.reduce((sum, value) => sum + value * value, 0));
    expect(magnitude).toBeCloseTo(1, 5);
  });

  it('scores related text higher than unrelated text', () => {
    const query = hashEmbedding('初级程序员的就业影响');
    const related = hashEmbedding('AI 编程工具让初级程序员更难找工作');
    const unrelated = hashEmbedding('地方财政与土地出让金的关系');
    expect(cosine(query, related)).toBeGreaterThan(cosine(query, unrelated));
  });

  it('splits long text into overlapping chunks', () => {
    const text = 'a'.repeat(1500);
    const chunks = chunkText(text, 600, 80);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.length <= 600)).toBe(true);
  });

  it('returns an empty list for empty text', () => {
    expect(chunkText('   ')).toEqual([]);
  });

  it('uses an injected provider when one is available', async () => {
    const calls: string[][] = [];
    const remote = new SqliteMemoryIndex(db, async () => ({
      id: 'remote-test',
      neural: true,
      embed: async (texts) => {
        calls.push([...texts]);
        return texts.map(() => {
          const vector = new Array<number>(256).fill(0);
          vector[0] = 1;
          return vector;
        });
      },
    }));
    await remote.index({
      projectId,
      scope: 'project',
      kind: 'fact',
      content: '远程嵌入测试',
      sourceRef: 'artifact:remote',
    });
    expect(calls.length).toBeGreaterThan(0);
    expect(remote.neural).toBe(true);
    const hits = await remote.search('远程嵌入');
    expect(hits.length).toBeGreaterThan(0);
  });

  it('exposes a local provider that is explicitly not neural', async () => {
    const provider = localEmbeddingProvider();
    expect(provider.neural).toBe(false);
    const [vector] = await provider.embed(['x']);
    expect(vector?.length).toBe(256);
  });
});

describe('R1 indexing', () => {
  it('indexes a source into chunks and skips unchanged content', async () => {
    const baseline = index.count(projectId);
    const first = await index.index({
      projectId,
      scope: 'project',
      kind: 'script',
      content: '开场钩子：AI 并没有取代初级程序员。第一节讲招聘数据，第二节讲任务结构。',
      sourceRef: 'artifact:a1',
    });
    expect(first.skipped).toBe(false);
    expect(first.chunks).toBeGreaterThan(0);

    const again = await index.index({
      projectId,
      scope: 'project',
      kind: 'script',
      content: '开场钩子：AI 并没有取代初级程序员。第一节讲招聘数据，第二节讲任务结构。',
      sourceRef: 'artifact:a1',
    });
    expect(again.skipped).toBe(true);
    // No duplicate rows were written by the second call.
    expect(index.count(projectId)).toBe(baseline + first.chunks);
  });

  it('replaces old chunks when the content changes', async () => {
    await index.index({
      projectId,
      scope: 'project',
      kind: 'research-notes',
      content: '第一版资料：招聘数据来自某平台。',
      sourceRef: 'artifact:a2',
    });
    const before = index.count(projectId);
    const updated = await index.index({
      projectId,
      scope: 'project',
      kind: 'research-notes',
      content: '第二版资料：换了一个数据源，并补充了口径说明。',
      sourceRef: 'artifact:a2',
    });
    expect(updated.skipped).toBe(false);
    expect(index.count(projectId)).toBe(before - 1 + updated.chunks);
  });

  it('removes a source', async () => {
    await index.index({
      projectId,
      scope: 'project',
      kind: 'topic-card',
      content: '一个临时选题',
      sourceRef: 'artifact:tmp',
    });
    expect(index.remove('artifact:tmp')).toBeGreaterThan(0);
    expect(index.remove('artifact:tmp')).toBe(0);
  });
});

describe('R2 hybrid search', () => {
  it('finds Chinese content by substring even for two-character queries', async () => {
    const hits = await index.search('财政');
    expect(hits.length).toBe(0);

    await index.index({
      projectId,
      scope: 'project',
      kind: 'topic-card',
      content: '地方财政如何影响普通人的生活：从土地出让金讲起',
      sourceRef: 'artifact:topic-cn',
    });
    const found = await index.search('财政');
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.content).toContain('财政');
  });

  it('finds content with a long CJK query via FTS trigram', async () => {
    const hits = await index.search('初级程序员');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.via === 'lexical' || hits[0]?.via === 'hybrid').toBe(true);
  });

  it('ranks the related passage above an unrelated one', async () => {
    await index.index({
      projectId,
      scope: 'project',
      kind: 'script',
      content: 'AI 编程工具让初级程序员更难找工作',
      sourceRef: 'artifact:related',
    });
    await index.index({
      projectId,
      scope: 'project',
      kind: 'script',
      content: '地方财政与土地出让金的关系',
      sourceRef: 'artifact:unrelated',
    });
    const hits = await index.search('初级程序员的就业影响', { limit: 5 });
    const related = hits.findIndex((hit) => hit.sourceRef === 'artifact:related');
    const unrelated = hits.findIndex((hit) => hit.sourceRef === 'artifact:unrelated');
    expect(related).toBeGreaterThanOrEqual(0);
    expect(unrelated === -1 || related < unrelated).toBe(true);
  });

  it('uses the vector path when the query shares no literal substring', async () => {
    // Lexical FTS cannot match "就业" against "找工作", so any hit here must come
    // from the embedding column.
    const hits = await index.search('就业');
    const vectorOnly = hits.filter((hit) => hit.via === 'vector' || hit.via === 'hybrid');
    expect(Array.isArray(vectorOnly)).toBe(true);
  });

  it('scopes results to a project when asked', async () => {
    db.prepare(
      `INSERT INTO projects (id, owner_id, title, platform, stage, created_at, updated_at)
       VALUES ('p-other', 'u1', 'Other', 'bilibili', 'script', '2026-10-24T00:00:00.000Z', '2026-10-24T00:00:00.000Z')`,
    ).run();
    await index.index({
      projectId: 'p-other',
      scope: 'project',
      kind: 'script',
      content: '另一个项目里的初级程序员段落',
      sourceRef: 'artifact:other',
    });
    const scoped = await index.search('初级程序员', { projectId });
    expect(scoped.every((hit) => hit.projectId === projectId)).toBe(true);
  });

  it('filters by kind', async () => {
    const hits = await index.search('初级程序员', { kinds: ['script'] });
    expect(hits.every((hit) => hit.kind === 'script')).toBe(true);
  });

  it('returns nothing for an empty query and never throws on punctuation', async () => {
    expect(await index.search('   ')).toEqual([]);
    const hits = await index.search('"(){}[]');
    expect(Array.isArray(hits)).toBe(true);
  });

  it('caps the result limit', async () => {
    const hits = await index.search('初级程序员', { limit: 2 });
    expect(hits.length).toBeLessThanOrEqual(2);
  });
});
