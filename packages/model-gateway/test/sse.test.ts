import { describe, expect, it } from 'vitest';
import { SseParser } from '../src/index.js';

describe('SseParser', () => {
  it('parses a single event with LF separators', () => {
    const parser = new SseParser();
    expect(parser.push('data: hello\n\n')).toEqual([{ event: null, data: 'hello' }]);
  });

  it('parses CRLF separators', () => {
    const parser = new SseParser();
    expect(parser.push('data: hi\r\n\r\n')).toEqual([{ event: null, data: 'hi' }]);
  });

  it('parses an event split across chunks', () => {
    const parser = new SseParser();
    expect(parser.push('data: {"choi')).toEqual([]);
    expect(parser.push('ces":[{"delta":{"content":"你"}}]}\n\n')).toEqual([
      { event: null, data: '{"choices":[{"delta":{"content":"你"}}]}' },
    ]);
  });

  it('parses several events in one chunk', () => {
    const parser = new SseParser();
    expect(parser.push('data: a\n\ndata: b\n\n')).toEqual([
      { event: null, data: 'a' },
      { event: null, data: 'b' },
    ]);
  });

  it('ignores comment lines', () => {
    const parser = new SseParser();
    expect(parser.push(': keep-alive\n\ndata: x\n\n')).toEqual([{ event: null, data: 'x' }]);
  });

  it('captures the event name', () => {
    const parser = new SseParser();
    expect(parser.push('event: message_stop\ndata: {}\n\n')).toEqual([
      { event: 'message_stop', data: '{}' },
    ]);
  });

  it('joins multiple data lines with a newline', () => {
    const parser = new SseParser();
    expect(parser.push('data: line1\ndata: line2\n\n')).toEqual([
      { event: null, data: 'line1\nline2' },
    ]);
  });

  it('emits nothing for a blank block', () => {
    const parser = new SseParser();
    expect(parser.push('\n\n')).toEqual([]);
  });

  it('flushes a trailing event without a blank line', () => {
    const parser = new SseParser();
    expect(parser.push('data: tail')).toEqual([]);
    expect(parser.flush()).toEqual([{ event: null, data: 'tail' }]);
  });

  it('does not emit empty data events', () => {
    const parser = new SseParser();
    expect(parser.push('data:\n\n')).toEqual([]);
  });
});
