import { describe, expect, it } from 'vitest';
import { UPSTREAM, UPSTREAM_CHAR_LIMIT, buildUpstreamContext } from '../src/generate.js';

describe('R1 upstream context', () => {
  it('returns an empty string when there are no docs', () => {
    expect(buildUpstreamContext([])).toBe('');
  });

  it('includes the kind label and body', () => {
    const text = buildUpstreamContext([{ kind: 'script', content: '这是脚本正文' }]);
    expect(text).toContain('上游产物：script');
    expect(text).toContain('这是脚本正文');
  });

  it('joins multiple docs with a blank line', () => {
    const text = buildUpstreamContext([
      { kind: 'topic-card', content: 'A' },
      { kind: 'script', content: 'B' },
    ]);
    expect(text).toContain('A');
    expect(text).toContain('B');
    expect(text.split('\n\n').length).toBeGreaterThanOrEqual(2);
  });

  it('truncates a single oversized document', () => {
    const huge = 'x'.repeat(UPSTREAM_CHAR_LIMIT + 500);
    const text = buildUpstreamContext([{ kind: 'script', content: huge }]);
    expect(text).toContain('已截断');
    expect(text.length).toBeLessThan(huge.length);
  });

  it('stops adding docs once the total budget is spent', () => {
    const big = 'y'.repeat(UPSTREAM_CHAR_LIMIT);
    const text = buildUpstreamContext([
      { kind: 'a', content: big },
      { kind: 'b', content: big },
      { kind: 'c', content: big },
      { kind: 'd', content: big },
    ]);
    // 6000 char budget / 2000 per doc means at most three blocks.
    expect(text.split('上游产物：').length - 1).toBeLessThanOrEqual(3);
  });
});

describe('upstream stage map', () => {
  it('topic has no upstream', () => {
    expect(UPSTREAM['topic-card']).toEqual([]);
  });

  it('research builds on topic', () => {
    expect(UPSTREAM['research-notes']).toContain('topic-card');
  });

  it('publish builds on topic, research and script', () => {
    expect(UPSTREAM['publish-pack']).toEqual(['topic-card', 'research-notes', 'script']);
  });
});
