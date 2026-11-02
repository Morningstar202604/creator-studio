import { describe, expect, it } from 'vitest';
import { buildSrt, formatTimestamp, scriptToCues } from '../src/subtitle.js';

const script = `# 开场钩子

你有没有发现，招聘网站上的初级岗位正在变少。

## 1. 数据

先看一组数据：2026 年春招，初级开发岗位同比下降 18%。这不是单一平台的现象。

> 画面建议：招聘网站录屏

## 2. 原因

企业不是不需要人，而是需要能直接交付的人。AI 把「写样板代码」这件事变得很便宜。

# 结尾行动号召

如果你正在准备面试，先把一个完整项目做深。`;

describe('R3 subtitle cues', () => {
  it('splits a markdown script into speaking cues without headings or b-roll', () => {
    const cues = scriptToCues(script);
    expect(cues.length).toBeGreaterThan(3);
    expect(cues.every((cue) => cue.text.length <= 18)).toBe(true);
    const joined = cues.map((cue) => cue.text).join('');
    expect(joined).not.toContain('画面建议');
    expect(joined).not.toContain('开场钩子');
    expect(joined).toContain('初级开发岗位同比下降');
  });

  it('produces monotonic timestamps with a positive duration', () => {
    const cues = scriptToCues(script);
    for (const [index, cue] of cues.entries()) {
      expect(cue.index).toBe(index + 1);
      expect(cue.endMs).toBeGreaterThan(cue.startMs);
      if (index > 0) expect(cue.startMs).toBeGreaterThanOrEqual(cues[index - 1]?.endMs ?? 0);
    }
  });

  it('renders valid SRT blocks', () => {
    const srt = buildSrt(scriptToCues(script));
    expect(srt.startsWith('1\n00:00:00,000 --> ')).toBe(true);
    expect(srt).toContain('\n\n2\n');
    expect(srt.endsWith('\n')).toBe(true);
  });

  it('formats hours, minutes, seconds and milliseconds', () => {
    expect(formatTimestamp(0)).toBe('00:00:00,000');
    expect(formatTimestamp(3_723_456)).toBe('01:02:03,456');
  });

  it('returns an empty string for a script with no speakable text', () => {
    expect(buildSrt(scriptToCues('# 标题\n\n> 仅供画面\n'))).toBe('');
  });
});
