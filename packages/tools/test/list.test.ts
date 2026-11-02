import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listDirectory } from '../src/list.js';

function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'list-'));
  mkdirSync(join(root, 'assets', 'clips'), { recursive: true });
  writeFileSync(join(root, 'assets', 'a.txt'), 'hello');
  writeFileSync(join(root, 'readme.md'), '# x');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('R1 directory listing stays inside the workspace', () => {
  it('lists one level with directories and sizes', () => {
    const { root, cleanup } = fixture();
    const result = listDirectory('assets', { workspaceRoot: root });
    expect(result.path).toBe('assets');
    expect(result.entries.map((entry) => `${entry.kind}:${entry.name}`)).toEqual([
      'file:a.txt',
      'directory:clips',
    ]);
    cleanup();
  });

  it('lists the workspace root for an empty path', () => {
    const { root, cleanup } = fixture();
    const result = listDirectory('', { workspaceRoot: root });
    expect(result.entries.map((entry) => entry.name)).toEqual(['assets', 'readme.md']);
    cleanup();
  });

  it('refuses traversal and absolute paths', () => {
    const { root, cleanup } = fixture();
    expect(() => listDirectory('../', { workspaceRoot: root })).toThrow(/PATH_ESCAPE|escapes/);
    expect(() => listDirectory('C:/Windows', { workspaceRoot: root })).toThrow();
    cleanup();
  });

  it('caps the entry count', () => {
    const { root, cleanup } = fixture();
    for (let index = 0; index < 12; index += 1) writeFileSync(join(root, `f${index}.txt`), 'x');
    const result = listDirectory('', { workspaceRoot: root, limit: 5 });
    expect(result.entries).toHaveLength(5);
    expect(result.truncated).toBe(true);
    cleanup();
  });
});
