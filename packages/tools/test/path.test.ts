import { lstatSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PathEscapeError, resolveInsideWorkspace, toWorkspaceRelative } from '../src/index.js';

let root: string;
let outside: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ws-'));
  outside = mkdtempSync(join(tmpdir(), 'outside-'));
  mkdirSync(join(root, 'script'), { recursive: true });
  writeFileSync(join(root, 'script', 'a.md'), 'x');
  writeFileSync(join(outside, 'secret.txt'), 'secret');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const resolve = (p: string) => resolveInsideWorkspace(p, { workspaceRoot: root });

/**
 * Some sandboxed Windows environments swallow symlinkSync silently (no throw, no
 * link on disk), which would turn the escape test into a false pass. Verify the
 * link actually materialized, or skip the scenario entirely.
 */
function symlinkOrSkip(target: string, link: string): boolean {
  try {
    symlinkSync(target, link, 'dir');
    return lstatSync(link).isSymbolicLink();
  } catch {
    return false;
  }
}

describe('R3 path sandbox', () => {
  it('accepts a normal relative path', () => {
    expect(resolve('script/a.md')).toContain('a.md');
  });

  it('accepts a path that does not exist yet', () => {
    expect(() => resolve('script/new/deep.md')).not.toThrow();
  });

  it('rejects parent traversal', () => {
    expect(() => resolve('../../etc/passwd')).toThrowError(PathEscapeError);
  });

  it('rejects nested traversal that still looks relative', () => {
    expect(() => resolve('script/../../../etc/passwd')).toThrowError(PathEscapeError);
  });

  it('rejects an absolute path', () => {
    const absolute = process.platform === 'win32' ? 'C:/Windows/win.ini' : '/etc/passwd';
    expect(() => resolve(absolute)).toThrowError(/PATH_ESCAPE/);
  });

  it('rejects a windows drive-relative path', () => {
    expect(() => resolve('C:Windows/win.ini')).toThrowError(/PATH_ESCAPE/);
  });

  it('rejects a UNC path', () => {
    expect(() => resolve('\\server\share\file.txt')).toThrowError(/PATH_ESCAPE/);
  });

  it('rejects an empty path', () => {
    expect(() => resolve('   ')).toThrowError(/PATH_ESCAPE/);
  });

  it('rejects a null byte', () => {
    expect(() => resolve('a\0b.md')).toThrowError(/PATH_ESCAPE/);
  });

  it('rejects a symlink pointing outside the workspace', () => {
    const link = join(root, 'escape-link');
    if (!symlinkOrSkip(outside, link)) return;
    expect(() => resolve('escape-link/secret.txt')).toThrowError(/symlink escapes/);
  });

  it('accepts a symlink pointing inside the workspace', () => {
    const link = join(root, 'inside-link');
    if (!symlinkOrSkip(join(root, 'script'), link)) return;
    expect(() => resolve('inside-link/a.md')).not.toThrow();
  });

  it('rejects a realpath escape even where OS symlinks are unavailable', () => {
    const fakeOutside = join(tmpdir(), 'elsewhere', 'secret.txt');
    expect(() =>
      resolveInsideWorkspace('link/secret.txt', {
        workspaceRoot: root,
        realpath: (path) => (path.includes('link') ? fakeOutside : path),
      }),
    ).toThrowError(/symlink escapes/);
  });
});

describe('case-insensitive comparison on windows', () => {
  it('treats differing case as the same root on win32', () => {
    const result = resolveInsideWorkspace('script/a.md', {
      workspaceRoot: root.toUpperCase(),
      platform: 'win32',
      realpath: (p) => p,
    });
    expect(result).toBeTruthy();
  });
});

describe('toWorkspaceRelative', () => {
  it('strips the workspace prefix', () => {
    const absolute = join(root, 'script', 'a.md');
    expect(toWorkspaceRelative(absolute, root).split(String.fromCharCode(92)).join('/')).toBe('script/a.md');
  });

  it('rejects a path outside the workspace', () => {
    expect(() => toWorkspaceRelative(join(outside, 'secret.txt'), root)).toThrowError(/PATH_ESCAPE/);
  });
});
