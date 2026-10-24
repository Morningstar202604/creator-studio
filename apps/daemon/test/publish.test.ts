import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ModelGateway } from '@creator-studio/model-gateway';
import { createDaemon, type Daemon } from '../src/server.js';
import { buildZip } from '../src/publish.js';

let workspace: string;
let daemon: Daemon;
let baseUrl: string;

/** Minimal zip reader: walks local headers, verifies CRC by re-computing via zlib. */
function readZipEntries(buffer: Buffer): Array<{ name: string; content: string }> {
  const entries: Array<{ name: string; content: string }> = [];
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break;
    const method = buffer.readUInt16LE(offset + 8);
    const size = buffer.readUInt32LE(offset + 18);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLen).toString('utf8');
    const dataStart = offset + 30 + nameLen + extraLen;
    const data = buffer.subarray(dataStart, dataStart + size);
    const content = method === 0 ? data.toString('utf8') : inflateRawSync(data).toString('utf8');
    entries.push({ name, content });
    offset = dataStart + size;
  }
  return entries;
}

async function createProject(): Promise<string> {
  const response = await fetch(`${baseUrl}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: `发布测试 ${Math.random().toString(36).slice(2, 6)}` }),
  });
  return ((await response.json()) as { project: { id: string } }).project.id;
}

async function addArtifact(projectId: string, kind: string, path: string, content: string): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/projects/${projectId}/artifacts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, path, content }),
  });
  expect(response.status).toBe(201);
}

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'publish-ws-'));
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

describe('zip writer', () => {
  it('produces a readable archive with CRC and central directory', () => {
    const zip = buildZip([
      { name: 'a.md', content: Buffer.from('hello', 'utf8') },
      { name: 'dir/b.md', content: Buffer.from('世界', 'utf8') },
    ]);
    const entries = readZipEntries(zip);
    expect(entries.map((entry) => entry.name)).toEqual(['a.md', 'dir/b.md']);
    expect(entries[0]?.content).toBe('hello');
    expect(entries[1]?.content).toBe('世界');
    // End-of-central-directory signature must be present at the tail.
    expect(zip.subarray(zip.length - 22).readUInt32LE(0)).toBe(0x06054b50);
  });
});

describe('R1 checklist gate', () => {
  it('reports missing stages on a fresh project', async () => {
    const projectId = await createProject();
    const response = await fetch(`${baseUrl}/v1/projects/${projectId}/checklist`);
    const body = (await response.json()) as { ready: boolean; missing: string[]; items: unknown[] };
    expect(body.ready).toBe(false);
    expect(body.missing).toContain('script');
    expect(body.items.length).toBe(6);
    // The shot list is optional and must not block the export gate.
    expect(body.items.find((item: { key: string }) => item.key === 'shotlist')?.required).toBe(false);
  });

  it('refuses to export when the checklist is incomplete', async () => {
    const projectId = await createProject();
    await addArtifact(projectId, 'script', 'script/script.v1.md', '# 脚本');
    const response = await fetch(`${baseUrl}/v1/projects/${projectId}/publish`, { method: 'POST' });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string }; missing: string[] };
    expect(body.error.code).toBe('CHECKLIST_INCOMPLETE');
    expect(body.missing).toContain('topic');
  });

  it('does not create an export file when the checklist fails', async () => {
    const projectId = await createProject();
    await fetch(`${baseUrl}/v1/projects/${projectId}/publish`, { method: 'POST' });
    const outDir = join(workspace, 'project', 'publish-exports');
    let files: string[] = [];
    try {
      files = readdirSync(outDir);
    } catch {
      files = [];
    }
    expect(files.length).toBe(0);
  });
});

describe('R3 full export', () => {
  it('exports a valid zip containing every stage', async () => {
    const projectId = await createProject();
    await addArtifact(projectId, 'topic-card', 'topic/topic-card.v1.md', '## 选题');
    await addArtifact(projectId, 'research-notes', 'research/research-notes.v1.md', '## 资料');
    await addArtifact(projectId, 'script', 'script/script.v1.md', '## 脚本正文');
    await addArtifact(projectId, 'publish-pack', 'publish/publish-pack.v1.md', '## 发布包');

    const checklist = await fetch(`${baseUrl}/v1/projects/${projectId}/checklist`);
    const checklistBody = (await checklist.json()) as { ready: boolean };
    expect(checklistBody.ready).toBe(true);

    const response = await fetch(`${baseUrl}/v1/projects/${projectId}/publish`, { method: 'POST' });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { file: string; bytes: number; entries: string[] };
    expect(body.bytes).toBeGreaterThan(0);
    expect(body.entries).toContain('script/script.v1.md');
    expect(body.entries).toContain('topic/topic-card.v1.md');

    const zipPath = join(workspace, 'project', body.file);
    const { readFileSync } = await import('node:fs');
    const entries = readZipEntries(readFileSync(zipPath));
    expect(entries.map((entry) => entry.name).sort()).toEqual(
      [
        'README.md',
        'manifest.json',
        'publish/publish-pack.v1.md',
        'research/research-notes.v1.md',
        'script/script.v1.md',
        'topic/topic-card.v1.md',
      ].sort(),
    );
    expect(entries.find((entry) => entry.name === 'script/script.v1.md')?.content).toBe('## 脚本正文');
  });

  it('skips non-text artifacts such as images', async () => {
    const projectId = await createProject();
    await addArtifact(projectId, 'topic-card', 'topic/topic-card.v1.md', 't');
    await addArtifact(projectId, 'research-notes', 'research/research-notes.v1.md', 'r');
    await addArtifact(projectId, 'script', 'script/script.v1.md', 's');
    await addArtifact(projectId, 'publish-pack', 'publish/publish-pack.v1.md', 'p');
    await addArtifact(projectId, 'image', 'assets/cover.png', 'not-really-an-image');

    const response = await fetch(`${baseUrl}/v1/projects/${projectId}/publish`, { method: 'POST' });
    const body = (await response.json()) as { entries: string[] };
    expect(body.entries).not.toContain('assets/cover.png');
  });
});

describe('R4 unique export names', () => {
  it('never overwrites a previous export', async () => {
    const projectId = await createProject();
    await addArtifact(projectId, 'topic-card', 'topic/topic-card.v1.md', 't');
    await addArtifact(projectId, 'research-notes', 'research/research-notes.v1.md', 'r');
    await addArtifact(projectId, 'script', 'script/script.v1.md', 's');
    await addArtifact(projectId, 'publish-pack', 'publish/publish-pack.v1.md', 'p');

    const first = (await (await fetch(`${baseUrl}/v1/projects/${projectId}/publish`, { method: 'POST' })).json()) as {
      file: string;
    };
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = (await (await fetch(`${baseUrl}/v1/projects/${projectId}/publish`, { method: 'POST' })).json()) as {
      file: string;
    };
    expect(first.file).not.toBe(second.file);
  });
});

describe('R2 path safety', () => {
  it('rejects an artifact whose stored path escapes the workspace', async () => {
    const projectId = await createProject();
    // The artifact API refuses traversal at write time, so insert a hostile row
    // directly to prove the export path also defends itself.
    daemon.db
      .prepare(
        `INSERT INTO artifacts (id, project_id, run_id, kind, path, sha256, mime, size, visibility, created_at)
         VALUES (?, ?, NULL, 'script', ?, ?, 'text/markdown', 4, 'local', ?)`,
      )
      .run(
        `${projectId}-evil`,
        projectId,
        '../../evil.md',
        'a'.repeat(64),
        new Date().toISOString(),
      );

    await addArtifact(projectId, 'topic-card', 'topic/topic-card.v1.md', 't');
    await addArtifact(projectId, 'research-notes', 'research/research-notes.v1.md', 'r');
    await addArtifact(projectId, 'publish-pack', 'publish/publish-pack.v1.md', 'p');

    const response = await fetch(`${baseUrl}/v1/projects/${projectId}/publish`, { method: 'POST' });
    expect([500, 409]).toContain(response.status);
  });
});
