import { realpathSync } from 'node:fs';
import { isAbsolute, normalize, resolve, sep } from 'node:path';

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

  const looksAbsolute = isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath) || relativePath.startsWith('\\\\');
  if (looksAbsolute) {
    throw new PathEscapeError(relativePath, 'absolute path not allowed');
  }

  const root = canonical(resolve(options.workspaceRoot), platform);
  const resolved = canonical(resolve(options.workspaceRoot, relativePath), platform);

  if (!isInside(resolved, root)) {
    throw new PathEscapeError(relativePath, 'parent traversal');
  }

  let real: string;
  try {
    real = canonical(realpath(resolved), platform);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      const realRoot = canonical(realpath(root), platform);
      if (!isInside(resolved, realRoot)) {
        throw new PathEscapeError(relativePath, 'parent traversal via realpath');
      }
      return resolved;
    }
    throw error;
  }

  const realRoot = canonical(realpath(root), platform);
  if (!isInside(real, realRoot)) {
    throw new PathEscapeError(relativePath, 'symlink escapes workspace');
  }
  return real;
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
