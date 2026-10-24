import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';

export class PathEscapeError extends Error {
  readonly code = 'PATH_ESCAPE';
  readonly attempted: string;

  constructor(attempted: string, reason: string) {
    super(`PATH_ESCAPE: ${reason}: ${attempted}`);
    this.name = 'PathEscapeError';
    this.attempted = attempted;
  }
}

export type ResolveOptions = {
  workspaceRoot: string;
  platform?: NodeJS.Platform;
  realpath?: (path: string) => string;
};

function canonical(path: string, platform: NodeJS.Platform): string {
  const normalized = normalize(path).replace(/[\\/]+$/, '');
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * Resolves a caller-supplied relative path against the workspace root and
 * guarantees the result stays inside it. Rejects absolute paths, drive
 * letters, UNC paths, parent traversal, and symlink escapes.
 */
export function resolveInsideWorkspace(relativePath: string, options: ResolveOptions): string {
  const platform = options.platform ?? process.platform;
  const realpath = options.realpath ?? defaultRealpath;

  if (relativePath.trim() === '') {
    throw new PathEscapeError(relativePath, 'empty path');
  }
  if (relativePath.includes('\0')) {
    throw new PathEscapeError(relativePath, 'null byte');
  }

  // A leading backslash is a UNC path (`\\server\share`) or a root-relative path.
  // On POSIX it is technically an ordinary filename character, but a caller passing
  // one is handing us a Windows path, so reject it on every platform.
  const looksAbsolute = isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath) || relativePath.startsWith('\\');
  if (looksAbsolute) {
    throw new PathEscapeError(relativePath, 'absolute path not allowed');
  }

  const root = canonical(resolve(options.workspaceRoot), platform);
  const resolved = canonical(resolve(options.workspaceRoot, relativePath), platform);

  if (!isInside(resolved, root)) {
    throw new PathEscapeError(relativePath, 'parent traversal');
  }

  const realRoot = canonical(realpath(root), platform);

  let real: string;
  try {
    real = canonical(realpath(resolved), platform);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;

    // The target does not exist yet (a new file). Canonicalise the nearest existing
    // ancestor and re-append the remaining segments; comparing the raw (possibly
    // 8.3 short-name) path against the realpath'd root would wrongly reject valid
    // paths on Windows.
    const ancestor = canonical(realpathNearestExisting(resolved, realpath), platform);
    if (!isInside(ancestor, realRoot)) {
      throw new PathEscapeError(relativePath, 'parent traversal via realpath');
    }
    return resolved;
  }

  if (!isInside(real, realRoot)) {
    throw new PathEscapeError(relativePath, 'symlink escapes workspace');
  }
  return real;
}

/**
 * Walks up until a realpath resolves, then appends the missing tail. Only ENOENT
 * is swallowed; any other filesystem error propagates so callers fail closed.
 */
function realpathNearestExisting(target: string, realpath: (path: string) => string): string {
  const missing: string[] = [];
  let current = target;
  while (true) {
    try {
      const real = realpath(current);
      return missing.length === 0 ? real : join(real, ...missing.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(basename(current));
      current = parent;
    }
  }
}

function defaultRealpath(path: string): string {
  return realpathSync.native(path);
}

export function toWorkspaceRelative(absolutePath: string, workspaceRoot: string, platform = process.platform): string {
  const root = canonical(resolve(workspaceRoot), platform);
  const target = canonical(resolve(absolutePath), platform);
  if (!isInside(target, root)) {
    throw new PathEscapeError(absolutePath, 'not inside workspace');
  }
  return target.slice(root.length).replace(/^[\\/]+/, '');
}
