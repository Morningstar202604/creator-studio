#!/usr/bin/env node
/**
 * Fails when the version declared in one place disagrees with another.
 *
 * A release where `package.json` says 0.17.0 and the desktop bundle says 0.16.0
 * produces an installer whose updater metadata is wrong — a silent, expensive
 * mistake. This check is cheap, so it runs as part of `pnpm verify` rather than
 * living in a release checklist a human has to remember.
 *
 * Usage: node scripts/verify-versions.mjs
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function readJson(relative) {
  return JSON.parse(readFileSync(join(root, relative), 'utf8'));
}

function readText(relative) {
  return readFileSync(join(root, relative), 'utf8');
}

/** Pulls `version = "x.y.z"` out of a Cargo manifest's [package] section. */
function cargoVersion(text) {
  const match = text.match(/^\s*version\s*=\s*"([^"]+)"/m);
  return match === null ? null : match[1];
}

/** Newest changelog heading, e.g. "## [0.17.0] - 2026-11-02". */
function changelogVersion(text) {
  const match = text.match(/^## \[(\d+\.\d+\.\d+)\]/m);
  return match === null ? null : match[1];
}

const rootPkg = readJson('package.json');
const expected = rootPkg.version;

const checks = [
  ['package.json', expected],
  ['apps/desktop/package.json', readJson('apps/desktop/package.json').version],
  ['apps/daemon/package.json', readJson('apps/daemon/package.json').version],
  ['apps/cli/package.json', readJson('apps/cli/package.json').version],
  ['apps/cloud/package.json', readJson('apps/cloud/package.json').version],
  ['apps/desktop/src-tauri/tauri.conf.json', readJson('apps/desktop/src-tauri/tauri.conf.json').version],
  ['apps/desktop/src-tauri/Cargo.toml', cargoVersion(readText('apps/desktop/src-tauri/Cargo.toml'))],
  ['CHANGELOG.md (newest entry)', changelogVersion(readText('CHANGELOG.md'))],
];

let failed = false;
for (const [file, actual] of checks) {
  const ok = actual === expected;
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${file.padEnd(42)} ${actual ?? '<not found>'} (expected ${expected})`);
}

if (failed) {
  console.error('\nVersion mismatch. Bump every file in the list above before tagging.');
  process.exit(1);
}

console.log(`\nAll version declarations agree on ${expected}.`);
