import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, SqliteProjectStore, SqliteStyleStore } from '../src/index.js';

let workspace: string;

function setup(): { db: ReturnType<typeof openDatabase>; store: SqliteStyleStore } {
  workspace = mkdtempSync(join(tmpdir(), 'style-ws-'));
  const db = openDatabase({ path: join(workspace, 'db.sqlite') });
  return { db, store: new SqliteStyleStore(db, 'local-user', () => new Date('2026-10-26T00:00:00.000Z')) };
}

describe('R1 style profiles persist per user', () => {
  it('creates, lists and updates a profile', () => {
    const { db, store } = setup();
    const created = store.save({
      name: '理性分析',
      tone: '冷静、先给结论再给证据',
      audience: 'B 站科技区 1-30 万粉观众',
      bannedWords: ['赋能', '闭环'],
      notes: '少用感叹号',
    });
    expect(created.id).not.toBe('');
    expect(created.bannedWords).toEqual(['赋能', '闭环']);

    const listed = store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.name).toBe('理性分析');

    const updated = store.save({ id: created.id, name: '理性分析 2', bannedWords: ['抓手'] });
    expect(updated.id).toBe(created.id);
    expect(updated.name).toBe('理性分析 2');
    expect(updated.bannedWords).toEqual(['抓手']);
    expect(store.list()).toHaveLength(1);
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it('rejects an empty name and caps banned words', () => {
    const { db, store } = setup();
    expect(() => store.save({ name: '  ' })).toThrow();
    const many = Array.from({ length: 60 }, (_, index) => `词${index}`);
    const saved = store.save({ name: '多词', bannedWords: many });
    expect(saved.bannedWords).toHaveLength(40);
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it('keeps profiles isolated by user id', () => {
    const { db } = setup();
    const mine = new SqliteStyleStore(db, 'local-user');
    const other = new SqliteStyleStore(db, 'someone-else');
    mine.save({ name: '我的风格' });
    expect(other.list()).toHaveLength(0);
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  });
});

describe('R2 deleting a profile detaches it from projects', () => {
  it('clears projects.style_profile_id before deleting the row', () => {
    const { db, store } = setup();
    const projects = new SqliteProjectStore(db);
    const profile = store.save({ name: '待删风格' });
    const project = projects.create({
      id: 'p1',
      ownerId: 'local-user',
      title: '一期视频',
      platform: 'bilibili',
      workspacePath: null,
    });
    projects.update(project.id, { styleProfileId: profile.id });
    expect(projects.get(project.id)?.styleProfileId).toBe(profile.id);

    expect(store.delete(profile.id)).toBe(true);
    expect(store.get(profile.id)).toBeNull();
    expect(projects.get(project.id)?.styleProfileId).toBeNull();
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it('returns false for an unknown profile', () => {
    const { db, store } = setup();
    expect(store.delete('missing')).toBe(false);
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  });
});
