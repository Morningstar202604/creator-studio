import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { resolveInsideWorkspace } from './path.js';
import { ToolError } from './types.js';

export type ListEntry = { name: string; kind: 'file' | 'directory'; bytes: number | null };

/**
 * One-level directory listing inside the workspace. It deliberately does not
 * recurse: an agent asked to "look at the assets folder" should get a map, not a
 * disk dump, and a recursive walk on a huge tree would blow the tool timeout.
 */
export function listDirectory(path: string, options: { workspaceRoot: string; limit?: number }): {
  path: string;
  entries: ListEntry[];
  truncated: boolean;
} {
  const absolute = resolveInsideWorkspace(path === '' ? '.' : path, { workspaceRoot: options.workspaceRoot });
  const limit = options.limit ?? 200;
  let names: string[];
  try {
    names = readdirSync(absolute);
  } catch {
    throw new ToolError('EXECUTION_FAILED', `cannot list ${path}`);
  }
  const entries: ListEntry[] = [];
  let truncated = false;
  for (const name of names.sort()) {
    if (entries.length >= limit) {
      truncated = true;
      break;
    }
    const full = join(absolute, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    entries.push(
      stat.isDirectory()
        ? { name, kind: 'directory', bytes: null }
        : { name, kind: 'file', bytes: stat.size },
    );
  }
  return { path: relative(options.workspaceRoot, absolute).split('\\').join('/') || '.', entries, truncated };
}
