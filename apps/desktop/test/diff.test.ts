// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { MAX_LCS_LINES, applyHunks, diffLines } from '../src/features/diff';

describe('R3 diff and hunk application', () => {
  it('marks identical text as all equal', () => {
    const result = diffLines('a\nb\nc', 'a\nb\nc');
    expect(result.hunks).toHaveLength(0);
    expect(result.lines.every((line) => line.op === 'equal')).toBe(true);
  });

  it('detects a single insertion', () => {
    const result = diffLines('a\nc', 'a\nb\nc');
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]?.added).toEqual(['b']);
    expect(result.hunks[0]?.removed).toEqual([]);
  });

  it('detects a single deletion', () => {
    const result = diffLines('a\nb\nc', 'a\nc');
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]?.removed).toEqual(['b']);
    expect(result.hunks[0]?.added).toEqual([]);
  });

  it('groups two distant changes into separate hunks', () => {
    const oldText = 'a\nb\nc\nd\ne';
    const newText = 'A\nb\nc\nd\nE';
    const result = diffLines(oldText, newText);
    expect(result.hunks.length).toBe(2);
  });

  it('applies only the accepted hunk', () => {
    const oldText = '第一行\n第二行\n第三行\n第四行\n第五行';
    const newText = '第一行改\n第二行\n第三行\n第四行改\n第五行';
    const result = diffLines(oldText, newText);
    expect(result.hunks.length).toBe(2);

    const onlyFirst = applyHunks(oldText, newText, [result.hunks[0]?.id ?? '']);
    expect(onlyFirst).toContain('第一行改');
    expect(onlyFirst).toContain('第四行');
    expect(onlyFirst).not.toContain('第四行改');
  });

  it('applies all hunks to reproduce the new text', () => {
    const oldText = 'a\nb\nc\nd\ne';
    const newText = 'A\nb\nc\nd\nE';
    const result = diffLines(oldText, newText);
    const all = applyHunks(oldText, newText, result.hunks.map((hunk) => hunk.id));
    expect(all).toBe(newText);
  });

  it('returns the old text when nothing is accepted', () => {
    expect(applyHunks('a\nb', 'a\nc', [])).toBe('a\nb');
  });

  it('handles Chinese text with newlines', () => {
    const oldText = '开场\n正文一\n正文二';
    const newText = '开场\n正文一（改）\n正文二';
    const result = diffLines(oldText, newText);
    expect(result.hunks).toHaveLength(1);
    expect(applyHunks(oldText, newText, [result.hunks[0]?.id ?? ''])).toBe(newText);
  });

  it('degrades to one replace hunk above the LCS limit', () => {
    const huge = Array.from({ length: MAX_LCS_LINES + 10 }, (_, index) => `line ${index}`).join('\n');
    const result = diffLines(huge, `${huge}\nextra`);
    expect(result.truncated).toBe(true);
    expect(result.hunks).toHaveLength(1);
  });

  it('stays fast on a 2000-line diff', () => {
    const before = Array.from({ length: 2000 }, (_, index) => `line ${index}`).join('\n');
    const after = before.replace('line 1000', 'line 1000 changed');
    const started = Date.now();
    const result = diffLines(before, after);
    const elapsed = Date.now() - started;
    expect(result.truncated).toBe(false);
    expect(result.hunks).toHaveLength(1);
    expect(elapsed).toBeLessThan(1500);
  });
});
