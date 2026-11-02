export type SubtitleCue = {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
};

/** Characters per cue; roughly one short spoken clause at Chinese speaking speed. */
export const CUE_CHAR_LIMIT = 18;
/** Reading speed used to derive cue duration: ~5 Chinese characters per second. */
export const CHARS_PER_SECOND = 4.5;
export const MIN_CUE_MS = 1_000;
export const MAX_CUE_MS = 8_000;

/**
 * Strips Markdown furniture that is not spoken: headings, block quotes (b-roll and
 * stage directions), table rows and fenced code. The remaining prose is split on
 * Chinese/Latin sentence punctuation and then hard-wrapped at `CUE_CHAR_LIMIT`.
 */
export function scriptToCues(script: string): SubtitleCue[] {
  const lines = script.split(/\r?\n/);
  const prose: string[] = [];
  let inFence = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('>')) continue;
    if (trimmed.startsWith('|')) continue;
    prose.push(trimmed.replace(/^[-*+]\s+/, ''));
  }

  const sentences = prose
    .join('')
    .split(/(?<=[。！？!?；;])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '');

  const pieces: string[] = [];
  for (const sentence of sentences) {
    // Respect clause boundaries first: a cue that ends mid-clause reads badly.
    const clauses = sentence.split(/(?<=[，、：,:])/).filter((clause) => clause.trim() !== '');
    let packed = '';
    for (const clause of clauses) {
      if (clause.length > CUE_CHAR_LIMIT) {
        if (packed !== '') {
          pieces.push(packed);
          packed = '';
        }
        for (let start = 0; start < clause.length; start += CUE_CHAR_LIMIT) {
          const piece = clause.slice(start, start + CUE_CHAR_LIMIT).trim();
          if (piece !== '') pieces.push(piece);
        }
        continue;
      }
      if (packed.length + clause.length > CUE_CHAR_LIMIT && packed !== '') {
        pieces.push(packed);
        packed = '';
      }
      packed += clause;
    }
    if (packed !== '') pieces.push(packed);
  }

  let cursor = 0;
  return pieces.map((text, index) => {
    const duration = Math.min(MAX_CUE_MS, Math.max(MIN_CUE_MS, Math.round((text.length / CHARS_PER_SECOND) * 1000)));
    const cue = { index: index + 1, startMs: cursor, endMs: cursor + duration, text };
    cursor += duration;
    return cue;
  });
}

export function formatTimestamp(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1_000);
  const millis = safe % 1_000;
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
}

export function buildSrt(cues: SubtitleCue[]): string {
  if (cues.length === 0) return '';
  return `${cues
    .map((cue) => `${cue.index}\n${formatTimestamp(cue.startMs)} --> ${formatTimestamp(cue.endMs)}\n${cue.text}`)
    .join('\n\n')}\n`;
}
