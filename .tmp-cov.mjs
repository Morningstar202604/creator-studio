import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(process.cwd(), '.tmp', 'cov-daemon');
const merged = new Map();

for (const f of readdirSync(dir)) {
  if (!f.endsWith('.json')) continue;
  const data = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  for (const script of data.result) {
    const url = script.url.replace(/\\/g, '/');
    if (!url.includes('apps/daemon/dist/')) continue;
    const file = url.slice(url.indexOf('apps/daemon/dist/'));
    if (!merged.has(file)) merged.set(file, []);
    for (const fn of script.functions) {
      for (const r of fn.ranges) merged.get(file).push({ start: r.startOffset, end: r.endOffset, count: r.count });
    }
  }
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function offsetToLine(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

for (const [file, ranges] of [...merged.entries()].sort()) {
  const text = readFileSync(join(process.cwd(), 'apps/daemon/dist', file.replace('apps/daemon/dist/', '')), 'utf8');
  const starts = lineStarts(text);
  const lineHits = new Map();
  for (const r of ranges) {
    const a = offsetToLine(starts, r.start);
    const b = offsetToLine(starts, Math.max(r.end - 1, r.start));
    for (let l = a; l <= b; l += 1) {
      const prev = lineHits.get(l) ?? 0;
      lineHits.set(l, Math.max(prev, r.count));
    }
  }
  const lines = text.split('\n');
  const total = lines.length;
  let covered = 0;
  for (let i = 1; i <= total; i += 1) if ((lineHits.get(i) ?? 0) > 0) covered += 1;
  console.log(`${file}: ${covered}/${total} lines hit (${((covered / total) * 100).toFixed(1)}%)`);
}
