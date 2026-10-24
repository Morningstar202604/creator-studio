#!/usr/bin/env node
/**
 * Installs the daemon's production dependencies next to the bundled daemon so the
 * installed app can start it without a repo checkout. Run after `tauri build`.
 */
import { execFileSync } from 'node:child_process';
import { platform } from 'node:process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Tauri rewrites `..` segments in resource globs to `_up_`, which breaks path
// resolution at runtime. Stage the runtime INSIDE src-tauri so the glob is plain.
const out = join(root, 'apps', 'desktop', 'src-tauri', 'daemon-runtime');

const dist = join(root, 'apps', 'daemon', 'dist');
if (!existsSync(dist)) {
  console.error('daemon dist missing; run pnpm -r build first');
  process.exit(1);
}
mkdirSync(out, { recursive: true });

cpSync(dist, join(out, 'dist'), { recursive: true });

const pkg = JSON.parse(readFileSync(join(root, 'apps', 'daemon', 'package.json'), 'utf8'));
// Workspace deps are bundled into dist by tsc; only external packages are needed.
const deps = pkg.dependencies ?? {};
// The copied workspace packages have their own third-party deps; declare them here
// because npm only installs what the runtime package.json lists.
const TRANSITIVE = { zod: '3.25.76', 'better-sqlite3': '13.0.3', '@fastify/static': '10.1.7' };
const external = {
  ...Object.fromEntries(Object.entries(deps).filter(([name]) => !name.startsWith('@creator-studio/'))),
  ...TRANSITIVE,
};
writeFileSync(
  join(out, 'package.json'),
  JSON.stringify({ name: 'creator-studio-daemon', version: pkg.version, type: 'module', dependencies: external }, null, 2),
);

console.log(`installing ${Object.keys(external).length} runtime deps into ${out}`);
// npm is a .cmd shim on Windows and cannot be spawned without a shell.
const npm = platform === 'win32' ? 'npm.cmd' : 'npm';
execFileSync(npm, ['install', '--omit=dev', '--no-audit', '--no-fund'], {
  cwd: out,
  stdio: 'inherit',
  shell: platform === 'win32',
});
// The daemon imports workspace packages by name; those must be resolvable from the
// installed runtime, so copy each package's dist into a scoped node_modules tree.
const packages = ['protocol', 'model-gateway', 'tools', 'agent-core', 'store-sqlite'];
const scope = join(out, 'node_modules', '@creator-studio');
for (const name of packages) {
  const from = join(root, 'packages', name, 'dist');
  if (!existsSync(from)) {
    console.error(`missing dist for @creator-studio/${name}; run pnpm -r build`);
    process.exit(1);
  }
  const to = join(scope, name);
  mkdirSync(to, { recursive: true });
  cpSync(from, join(to, 'dist'), { recursive: true });
  writeFileSync(
    join(to, 'package.json'),
    JSON.stringify(
      {
        name: `@creator-studio/${name}`,
        version: '0.1.0',
        type: 'module',
        main: './dist/index.js',
        exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
      },
      null,
      2,
    ),
  );
}

// Re-add the workspace packages that npm may have pruned, and declare them so a
// future `npm install` keeps them.
const pkgAfter = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'));
pkgAfter.dependencies = {
  ...pkgAfter.dependencies,
  ...Object.fromEntries(packages.map((name) => [`@creator-studio/${name}`, 'file:./node_modules/@creator-studio/' + name])),
};
writeFileSync(join(out, 'package.json'), JSON.stringify(pkgAfter, null, 2));

console.log('done');
