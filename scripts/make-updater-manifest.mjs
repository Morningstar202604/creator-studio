#!/usr/bin/env node
/**
 * Writes the Tauri updater manifest for a release.
 *
 * The updater reads one JSON document: version, notes, publication time and, per
 * platform, a URL plus the signature produced when the bundle was built. Tauri
 * does not generate this file for a GitHub release unless its own action does it,
 * and this project publishes by hand to five hosts — so it is generated here and
 * committed to the repo, which turns it into a stable URL the app can poll.
 *
 * Why the manifest lives in the repo rather than on a release asset: GitCode's
 * `releases/latest/download/<name>` returns an HTML page for a missing asset,
 * which is indistinguishable from "no update" only if the client parses it as
 * JSON first — it does not, it fails. A file on `main` is served as text/plain by
 * both Gitee and GitCode raw endpoints and always exists.
 *
 * Usage: node scripts/make-updater-manifest.mjs [--version x.y.z]
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const args = process.argv.slice(2);
const versionArg = args.indexOf('--version');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = versionArg === -1 ? pkg.version : args[versionArg + 1];

const SIG = join(root, 'apps/desktop/src-tauri/target/release/bundle/nsis');
const exe = join(SIG, `CreatorStudio_${version}_x64-setup.exe`);
const sig = `${exe}.sig`;

for (const [label, path] of [['installer', exe], ['signature', sig]]) {
  if (!existsSync(path)) {
    console.error(`missing ${label}: ${path}`);
    console.error('build it first: pnpm tauri build --bundles nsis (with TAURI_SIGNING_PRIVATE_KEY)');
    process.exit(1);
  }
}

const signature = readFileSync(sig, 'utf8').trim();
if (!signature.startsWith('dW50cnVzdGVkIGNvbW1lbnQ6')) {
  console.error('signature does not look like a minisign bundle; refusing to publish a manifest the app cannot verify');
  process.exit(1);
}

// The URL must be reachable without a browser session. Gitee serves release
// assets at a stable path and answers with the bytes, which GitCode's release
// pages do not for binaries.
const base = 'https://gitee.com/badhope/creator-studio/releases/download';
const url = `${base}/v${version}/CreatorStudio_${version}_x64-setup.exe`;

const notes = (() => {
    // The repo stores the changelog with CRLF on Windows; the updater renders this
    // text verbatim, so normalise it or every note shows stray carriage returns.
    const changelog = readFileSync(join(root, 'CHANGELOG.en.md'), 'utf8').replace(/\r\n/g, '\n');
  const start = changelog.indexOf(`## [${version}]`);
  if (start === -1) return `Creator Studio ${version}`;
  const next = changelog.indexOf('\n## [', start + 3);
  return changelog.slice(start, next === -1 ? undefined : next).trim();
})();

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': { signature, url },
  },
};

const out = join(root, 'latest.json');
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);

const sha = createHash('sha256').update(readFileSync(exe)).digest('hex');
console.log(`wrote latest.json · ${version}`);
console.log(`  url:  ${url}`);
console.log(`  size: ${statSync(exe).size} bytes · sha256 ${sha.slice(0, 16)}…`);
console.log('  note: commit this file; the updater polls it from raw.githubusercontent / gitee raw');
