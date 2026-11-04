import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const files = readdirSync(join(root, 'apps/daemon/test'))
  .filter((f) => f.endsWith('.ts'))
  .map((f) => readFileSync(join(root, 'apps/daemon/test', f), 'utf8'));

const observed = new Set();
for (const text of files) {
  for (const m of text.matchAll(/['"`](\/v1\/[^'"`$?$]*)/g)) {
    observed.add(m[1]);
  }
  for (const m of text.matchAll(/['"`](\/health|\/\.well-known\/[^'"`]*)/g)) {
    observed.add(m[1]);
  }
}

const server = readFileSync(join(root, 'apps/daemon/src/server.ts'), 'utf8');
const routes = [...server.matchAll(/app\.(get|post|put|patch|delete)\('([^']+)'/g)].map((m) => m[2]);

function norm(p) {
  return p.replace(/:[A-Za-z]+/g, ':x');
}
const obsNorm = new Set([...observed].map(norm));
const missing = routes.filter((r) => !obsNorm.has(norm(r)));
console.log('routes declared:', routes.length, 'distinct normalized observed:', obsNorm.size);
console.log('\nRoutes with no matching literal path in daemon tests:');
for (const r of missing) console.log('  ' + r);
