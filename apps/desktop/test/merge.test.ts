// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mergeThreeWay } from '../src/features/merge';

const BASE = ['第一段。', '第二段。', '第三段。', '第四段。', '第五段。'].join('\n');

describe('R1 disjoint edits merge without duplication', () => {
  it('applies one change from each side and keeps shared paragraphs once', () => {
    const mine = ['第一段。', '第二段（甲改）。', '第三段。', '第四段。', '第五段。'].join('\n');
    const theirs = ['第一段。', '第二段。', '第三段。', '第四段。', '第五段（乙改）。'].join('\n');
    const result = mergeThreeWay(BASE, mine, theirs);
    expect(result.conflicts).toBe(0);
    expect(result.text.split('\n')).toEqual([
      '第一段。',
      '第二段（甲改）。',
      '第三段。',
      '第四段。',
      '第五段（乙改）。',
    ]);
  });

  it('does not duplicate the unchanged base, which the first implementation did', () => {
    const mine = BASE.replace('第二段。', '第二段甲。');
    const theirs = BASE.replace('第四段。', '第四段乙。');
    const result = mergeThreeWay(BASE, mine, theirs);
    // Each base paragraph must appear exactly once in the merged output.
    for (const line of ['第一段。', '第三段。', '第五段。']) {
      expect(result.text.split(line).length - 1).toBe(1);
    }
    expect(result.text).not.toContain('---');
  });

  it('concatenates insertions at different offsets', () => {
    const mine = `${BASE}\n第六段甲。`;
    const theirs = `开篇乙。\n${BASE}`;
    const result = mergeThreeWay(BASE, mine, theirs);
    expect(result.conflicts).toBe(0);
    expect(result.text.startsWith('开篇乙。')).toBe(true);
    expect(result.text.endsWith('第六段甲。')).toBe(true);
  });
});

describe('R2 overlapping edits are flagged, not silently picked', () => {
  it('marks the same paragraph rewritten by both sides', () => {
    const mine = BASE.replace('第三段。', '第三段甲。');
    const theirs = BASE.replace('第三段。', '第三段乙。');
    const result = mergeThreeWay(BASE, mine, theirs);
    expect(result.conflicts).toBe(1);
    expect(result.text).toContain('<<<<<<< 你的版本');
    expect(result.text).toContain('第三段甲。');
    expect(result.text).toContain('=======');
    expect(result.text).toContain('第三段乙。');
    expect(result.text).toContain('>>>>>>> 已存下的版本');
  });

  it('marks two insertions at the same position', () => {
    const result = mergeThreeWay(BASE, `${BASE}\n甲新增。`, `${BASE}\n乙新增。`);
    expect(result.conflicts).toBe(1);
    expect(result.text).toContain('甲新增。');
    expect(result.text).toContain('乙新增。');
  });
});

describe('R3 trivial cases are exact', () => {
  it('returns the other side unchanged when this side did not edit', () => {
    const theirs = `${BASE}\n乙新增。`;
    expect(mergeThreeWay(BASE, BASE, theirs)).toEqual({ text: theirs, conflicts: 0, degraded: false });
  });

  it('returns this side unchanged when the other did not edit', () => {
    const mine = `${BASE}\n甲新增。`;
    expect(mergeThreeWay(BASE, mine, BASE)).toEqual({ text: mine, conflicts: 0, degraded: false });
  });

  it('returns one copy when both made the identical edit', () => {
    const same = BASE.replace('第二段。', '改过了。');
    expect(mergeThreeWay(BASE, same, same).text).toBe(same);
  });

  it('degrades to keeping both when no base is available', () => {
    const result = mergeThreeWay(null, '甲的整篇。', '乙的整篇。');
    expect(result.degraded).toBe(true);
    expect(result.text).toContain('甲的整篇。');
    expect(result.text).toContain('乙的整篇。');
  });
});

describe('R4 deletion on one side is honoured', () => {
  it('removes the paragraph this side deleted while keeping the other side edit', () => {
    const mine = ['第一段。', '第三段。', '第四段。', '第五段。'].join('\n');
    const theirs = BASE.replace('第五段。', '第五段乙。');
    const result = mergeThreeWay(BASE, mine, theirs);
    expect(result.conflicts).toBe(0);
    expect(result.text).not.toContain('第二段。');
    expect(result.text).toContain('第五段乙。');
  });
});
