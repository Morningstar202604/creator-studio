import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, '..', 'packages', 'store-sqlite', 'src', 'migrations');
const to = join(here, '..', 'packages', 'store-sqlite', 'dist', 'migrations');

if (!existsSync(from)) {
  console.error(`missing migrations dir: ${from}`);
  process.exit(1);
}
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
console.log(`copied migrations -> ${to}`);
