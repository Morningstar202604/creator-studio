export type SseEvent = {
  event: string | null;
  data: string;
};

/**
 * Parses SSE text incrementally. Feed it chunk strings; it returns complete
 * events and keeps the remainder buffered. Handles LF, CRLF and CR newlines,
 * comment lines, and multi-line data fields.
 */
export class SseParser {
  private buffer = '';

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];

    let index = this.findEventBoundary();
    while (index !== -1) {
      const raw = this.buffer.slice(0, index.start);
      this.buffer = this.buffer.slice(index.end);
      const event = parseBlock(raw);
      if (event !== null) events.push(event);
      index = this.findEventBoundary();
    }

    return events;
  }

  flush(): SseEvent[] {
    const raw = this.buffer;
    this.buffer = '';
    if (raw.trim() === '') return [];
    const event = parseBlock(raw);
    return event === null ? [] : [event];
  }

  private findEventBoundary(): { start: number; end: number } | -1 {
    const regex = /\r\n\r\n|\n\n|\r\r/;
    const match = regex.exec(this.buffer);
    if (match === null) return -1;
    return { start: match.index, end: match.index + match[0].length };
  }
}

function parseBlock(raw: string): SseEvent | null {
  const lines = raw.split(/\r\n|\n|\r/);
  let event: string | null = null;
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }

  if (dataLines.length === 0) return null;
  const data = dataLines.join('\n');
  if (data === '') return null;
  return { event, data };
}
