import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';

const root = process.cwd();
const pkgs = [
  'apps/cli',
  'apps/cloud',
  'apps/daemon',
  'apps/desktop',
  'packages/agent-core',
  'packages/model-gateway',
  'packages/protocol',
  'packages/store-sqlite',
  'packages/tools',
];

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (['node_modules', 'dist', 'test', 'src-tauri'].includes(e)) continue;
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (/\.(ts|tsx)$/.test(e)) out.push(f);
  }
  return out;
}

function importsOf(file) {
  const t = readFileSync(file, 'utf8');
  const out = [];
  const re = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const s = m[1];
    if (s.startsWith('.')) out.push(resolve(dirname(file), s));
  }
  return out;
}

for (const p of pkgs) {
  const testDir = join(root, p, 'test');
  let tests = [];
  try {
    tests = walk(testDir);
  } catch {
    tests = [];
  }
  const src = walk(join(root, p, 'src'));
  const seen = new Set();
  const stack = [...tests];
  while (stack.length > 0) {
    let f = stack.pop();
    if (!/\.(ts|tsx)$/.test(f)) f = f.replace(/\.js$/, '.ts');
    if (seen.has(f) || !existsSync(f) || !statSync(f).isFile()) continue;
    seen.add(f);
    for (const i of importsOf(f)) {
      const base = i.replace(/\.js$/, '');
      for (const cand of [base + '.ts', base + '.tsx', join(base, 'index.ts')]) {
        if (!seen.has(cand)) stack.push(cand);
      }
    }
  }
  const uncovered = src.filter((f) => !seen.has(f));
  console.log('\n=== ' + p + ' (' + src.length + ' src files, ' + uncovered.length + ' unreached from tests)');
  for (const f of uncovered) console.log('  UNREACHED ' + relative(join(root, p), f).split(sep).join('/'));
}
