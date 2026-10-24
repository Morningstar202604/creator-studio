#!/usr/bin/env node
/**
 * End-to-end smoke against a running daemon. Creates a throwaway project, runs the
 * full generation pipeline (needs a configured model), exports the pack and checks
 * the zip. Exits non-zero on the first failed stage.
 *
 *   node apps/daemon/dist/main.js --port 7878 &
 *   node scripts/smoke-e2e.mjs --base http://127.0.0.1:7878
 */
import { inflateRawSync } from 'node:zlib';

const args = process.argv.slice(2);
const baseIndex = args.indexOf('--base');
const base = baseIndex === -1 ? 'http://127.0.0.1:7878' : args[baseIndex + 1];
const context = 'AI 编程工具对初级程序员就业的影响';

async function api(path, init) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  const body = text === '' ? null : JSON.parse(text);
  return { status: response.status, body };
}

function readZip(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const size = buffer.readUInt32LE(offset + 18);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLen).toString('utf8');
    const start = offset + 30 + nameLen + extraLen;
    const data = buffer.subarray(start, start + size);
    entries.push({ name, content: method === 0 ? data.toString('utf8') : inflateRawSync(data).toString('utf8') });
    offset = start + size;
  }
  return entries;
}

const health = await api('/health');
if (health.status !== 200) {
  console.error(`FAIL health: ${health.status}`);
  process.exit(1);
}
console.log(`daemon ${health.body.apiVersion} · ${health.body.workspaceRoot}`);

const created = await api('/v1/projects', {
  method: 'POST',
  body: JSON.stringify({ title: `冒烟 ${new Date().toISOString()}`, platform: 'bilibili' }),
});
if (created.status !== 201) {
  console.error(`FAIL create project: ${created.status} ${JSON.stringify(created.body)}`);
  process.exit(1);
}
const projectId = created.body.project.id;
console.log(`project ${projectId}`);

for (const kind of ['topic-card', 'research-notes', 'script', 'shot-list', 'publish-pack']) {
  const started = Date.now();
  const result = await api(`/v1/projects/${projectId}/generate`, {
    method: 'POST',
    body: JSON.stringify({ kind, context }),
  });
  if (result.status !== 201) {
    console.error(`FAIL ${kind}: ${result.status} ${JSON.stringify(result.body)}`);
    process.exit(1);
  }
  console.log(`ok ${kind} ${Date.now() - started}ms → ${result.body.artifact.path}`);
}

const checklist = await api(`/v1/projects/${projectId}/checklist`);
if (checklist.body.ready !== true) {
  console.error(`FAIL checklist: ${JSON.stringify(checklist.body.missing)}`);
  process.exit(1);
}
console.log('checklist READY');

const published = await api(`/v1/projects/${projectId}/publish`, { method: 'POST' });
if (published.status !== 201) {
  console.error(`FAIL publish: ${published.status} ${JSON.stringify(published.body)}`);
  process.exit(1);
}
const { readFileSync } = await import('node:fs');
const entries = readZip(readFileSync(published.body.absolutePath));
const names = entries.map((entry) => entry.name);
if (!names.includes('manifest.json') || !names.includes('README.md')) {
  console.error(`FAIL manifest/readme missing: ${names.join(', ')}`);
  process.exit(1);
}
const manifest = JSON.parse(entries.find((entry) => entry.name === 'manifest.json').content);
console.log(`publish ok: ${published.body.bytes} bytes, ${entries.length} files, manifest ${manifest.files.length} hashes`);
console.log('PASS');
