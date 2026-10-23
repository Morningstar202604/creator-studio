import { describe, expect, it } from 'vitest';
import { matchScope } from '../src/index.js';

describe('matchScope', () => {
  const cases: Array<[string, string, boolean]> = [
    ['**', 'script/a.md', true],
    ['**', 'a.md', true],
    ['workspace/**', 'workspace/script/a.md', true],
    ['workspace/**', 'script/a.md', false],
    ['workspace/*', 'workspace/a.md', true],
    ['workspace/*', 'workspace/script/a.md', false],
    ['workspace/**/*.md', 'workspace/script/a.md', true],
    ['workspace/**/*.md', 'workspace/script/a.png', false],
    ['*.md', 'a.md', true],
    ['*.md', 'dir/a.md', false],
    ['script/*.md', 'script/a.md', true],
    ['script/*.md', 'script/sub/a.md', false],
  ];

  for (const [pattern, target, expected] of cases) {
    it(`${pattern} vs ${target} -> ${expected}`, () => {
      expect(matchScope(pattern, target)).toBe(expected);
    });
  }
});
