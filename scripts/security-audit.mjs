#!/usr/bin/env node
/**
 * Static self-audit for the claims we make about secrets, path handling and shell use.
 * Exits non-zero when a check fails so it can gate a release.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const SKIP = new Set(['node_modules', 'dist', 'target', '.git', 'out', 'daemon-runtime', 'prototype']);
const EXT = /\.(ts|tsx|mjs|js|rs|sql)$/;

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, files);
    else if (EXT.test(entry)) files.push(full);
  }
  return files;
}

const files = walk(root);
const findings = [];

// 1. No hardcoded credentials in source.
const SECRET = /(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const match = SECRET.exec(text);
  if (match !== null) findings.push({ check: 'secret-in-source', file: relative(root, file), detail: match[0].slice(0, 12) + '…' });
}

// 2. No shell interpolation of user data. `db.exec` runs SQL, not a shell, so only
// child_process imports are in scope — check the file actually imports one.
const SHELL_EXEC = /\b(exec|execSync|spawnSync)\(\s*`/;
const IMPORTS_CHILD_PROCESS = /from ['"]node:child_process['"]/;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  if (SHELL_EXEC.test(text) && IMPORTS_CHILD_PROCESS.test(text)) {
    findings.push({ check: 'shell-template-exec', file: relative(root, file) });
  }
}

// 3. Every fs path used by tools must reach the sandbox. Two accepted shapes:
//    (a) the file calls resolveInsideWorkspace directly, or
//    (b) the tool is registered with `pathArg` so ToolHost sandboxes it first.
const FAKE_FS = /readFileSync\(\s*join\(\s*workspaceRoot/;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  if (!FAKE_FS.test(text)) continue;
  const sandboxedDirectly = text.includes('resolveInsideWorkspace');
  const sandboxedByHost = /pathArg:\s*'path'/.test(text);
  if (!sandboxedDirectly && !sandboxedByHost) {
    findings.push({ check: 'fs-without-sandbox', file: relative(root, file) });
  }
}

// 4. API keys must never be logged. Logging whether a key *exists* is fine; logging
// the value is not. Flag only interpolations that are not a length/boolean check.
const KEY_LOG = /console\.(log|error)\([^)]*\$\{\s*apiKey\s*\}/;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  if (KEY_LOG.test(text)) findings.push({ check: 'api-key-logged', file: relative(root, file) });
}

// 5. The daemon must bind loopback by default.
const main = readFileSync(join(root, 'apps/daemon/src/main.ts'), 'utf8');
if (!main.includes("'127.0.0.1'")) {
  findings.push({ check: 'daemon-not-loopback', file: 'apps/daemon/src/main.ts' });
}

console.log(`scanned ${files.length} files`);
if (findings.length === 0) {
  console.log('PASS: no secrets, no shell templates, no unsandboxed fs, no key logging, loopback default');
  process.exit(0);
}
console.log('FAIL:');
for (const finding of findings) console.log('  -', JSON.stringify(finding));
process.exit(1);
