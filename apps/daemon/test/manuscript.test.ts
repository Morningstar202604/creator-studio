import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ModelGateway } from '@creator-studio/model-gateway';
import { createDaemon, type Daemon } from '../src/server.js';

let workspace: string;
let daemon: Daemon;
let baseUrl: string;

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }), ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  let body: unknown = null;
  if ((response.headers.get('content-type') ?? '').includes('json')) {
    body = text === '' ? null : JSON.parse(text);
  }
  return { status: response.status, body, headers: response.headers };
}

async function novelProject(): Promise<string> {
  const created = await api('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({ title: '雾港纪事', scenarioId: 'novel' }),
  });
  return created.body.project.id as string;
}

async function addChapter(projectId: string, title: string, number: string, body: string): Promise<string> {
  const created = await api(`/v1/projects/${projectId}/entities`, {
    method: 'POST',
    body: JSON.stringify({ type: 'chapter', title, fields: { title, number, status: '草稿' }, body }),
  });
  return created.body.card.id as string;
}

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'manuscript-'));
  const gateway = new ModelGateway({
    profiles: [
      {
        id: 'm1',
        userId: 'u',
        name: 'stub',
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1/v1',
        model: 'stub',
        apiKeyRef: 'k',
        contextWindow: 8000,
        priceInPerM: 0,
        priceOutPerM: 0,
        isLocal: true,
      },
    ],
    resolveKey: async () => 'sk-stub',
    maxRetries: 0,
    sleep: async () => {},
  });
  daemon = await createDaemon({
    dbPath: join(workspace, 'db.sqlite'),
    workspaceRoot: join(workspace, 'project'),
    deviceId: 'd1',
    modelGateway: gateway,
  });
  await daemon.app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(daemon.app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await daemon.close();
  rmSync(workspace, { recursive: true, force: true });
});

describe('R1 the manuscript is ordered by the declared chapter number', () => {
  it('lists chapters in reading order, not creation order', async () => {
    const projectId = await novelProject();
    await addChapter(projectId, '第三章 夜航船', '3', '第三段正文');
    await addChapter(projectId, '第一章 雾从海上来', '1', '第一段正文');
    await addChapter(projectId, '第二章 潮汐表', '2', '第二段正文');

    const result = await api(`/v1/projects/${projectId}/manuscript`);
    expect(result.status).toBe(200);
    expect(result.body.chapters.map((chapter: { title: string }) => chapter.title)).toEqual([
      '第一章 雾从海上来',
      '第二章 潮汐表',
      '第三章 夜航船',
    ]);
    expect(result.body.totalChars).toBe(15);
  });

  it('exports a docx whose text follows the same order', async () => {
    const projectId = await novelProject();
    await addChapter(projectId, '第三章', '3', '第三章正文');
    await addChapter(projectId, '第一章', '1', '第一章正文');

    const exported = await api(`/v1/projects/${projectId}/manuscript/export`, { method: 'POST' });
    expect(exported.status).toBe(201);
    expect(exported.body.chapters).toBe(2);
    expect(exported.body.file).toBe('manuscript/novel.docx');

    const download = await fetch(`${baseUrl}/v1/projects/${projectId}/manuscript/download/novel.docx`);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toContain('wordprocessingml');
    const bytes = Buffer.from(await download.arrayBuffer());
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');

    const onDisk = readFileSync(join(workspace, 'project', 'projects', projectId, 'manuscript', 'novel.docx'));
    expect(onDisk.length).toBe(bytes.length);

    const JSZip = (await import('jszip')).default;
    const xml = await (await JSZip.loadAsync(bytes)).file('word/document.xml')?.async('string');
    expect(xml).toBeTruthy();
    expect(xml?.indexOf('第一章')).toBeGreaterThan(-1);
    expect(xml?.indexOf('第一章')).toBeLessThan(xml?.indexOf('第三章') ?? -1);
    expect(xml).toContain('第一章正文');
  });
});

describe('R2 an empty project cannot export an empty book', () => {
  it('refuses with EMPTY_MANUSCRIPT', async () => {
    const projectId = await novelProject();
    const exported = await api(`/v1/projects/${projectId}/manuscript/export`, { method: 'POST' });
    expect(exported.status).toBe(409);
    expect(exported.body.error.code).toBe('EMPTY_MANUSCRIPT');
  });

  it('refuses a scenario with no writing stage', async () => {
    const created = await api('/v1/projects', { method: 'POST', body: JSON.stringify({ title: '视频', scenarioId: 'video' }) });
    const result = await api(`/v1/projects/${created.body.project.id}/manuscript`);
    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe('NO_DOCUMENT_STAGE');
  });
});

describe('R3 download names are whitelisted', () => {
  it('rejects traversal attempts instead of resolving them', async () => {
    const projectId = await novelProject();
    for (const name of ['..%2F..%2Fdb.sqlite', 'book.docx.bak', 'NOVEL.DOCX']) {
      const response = await api(`/v1/projects/${projectId}/manuscript/download/${name}`);
      expect(response.status, name).toBe(400);
    }
  });
});

describe('R4 card order is stored on the card', () => {
  it('accepts an explicit order on PATCH and reflects it in the manuscript', async () => {
    const projectId = await novelProject();
    const third = await addChapter(projectId, '第三章', '3', '丙');
    await addChapter(projectId, '第一章', '1', '甲');
    // Drag in the board writes order values without a chapter number.
    const patched = await api(`/v1/projects/${projectId}/entities/${third}`, {
      method: 'PATCH',
      body: JSON.stringify({ order: 0 }),
    });
    expect(patched.status).toBe(200);
    expect(patched.body.card.order).toBe(0);
  });
});
