export type DiffOp = 'equal' | 'insert' | 'delete';

export type DiffLine = {
  op: DiffOp;
  text: string;
  oldIndex: number | null;
  newIndex: number | null;
};

export type DiffHunk = {
  id: string;
  startOld: number;
  endOld: number;
  startNew: number;
  endNew: number;
  removed: string[];
  added: string[];
};

export type DiffResult = {
  lines: DiffLine[];
  hunks: DiffHunk[];
  truncated: boolean;
};

/** Above this many lines the quadratic LCS is replaced by a single replace hunk. */
export const MAX_LCS_LINES = 3000;

export function diffLines(oldText: string, newText: string): DiffResult {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  if (oldLines.length > MAX_LCS_LINES || newLines.length > MAX_LCS_LINES) {
    return {
      lines: [
        ...oldLines.map((text, index): DiffLine => ({ op: 'delete', text, oldIndex: index, newIndex: null })),
        ...newLines.map((text, index): DiffLine => ({ op: 'insert', text, oldIndex: null, newIndex: index })),
      ],
      hunks: [
        {
          id: 'hunk-0',
          startOld: 0,
          endOld: oldLines.length,
          startNew: 0,
          endNew: newLines.length,
          removed: oldLines,
          added: newLines,
        },
      ],
      truncated: true,
    };
  }

  const table = lcsTable(oldLines, newLines);
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      lines.push({ op: 'equal', text: oldLines[i] as string, oldIndex: i, newIndex: j });
      i += 1;
      j += 1;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      lines.push({ op: 'delete', text: oldLines[i] as string, oldIndex: i, newIndex: null });
      i += 1;
    } else {
      lines.push({ op: 'insert', text: newLines[j] as string, oldIndex: null, newIndex: j });
      j += 1;
    }
  }
  while (i < oldLines.length) {
    lines.push({ op: 'delete', text: oldLines[i] as string, oldIndex: i, newIndex: null });
    i += 1;
  }
  while (j < newLines.length) {
    lines.push({ op: 'insert', text: newLines[j] as string, oldIndex: null, newIndex: j });
    j += 1;
  }

  return { lines, hunks: groupHunks(lines), truncated: false };
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.split('\n');
}

function lcsTable(a: string[], b: string[]): number[][] {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    const row = table[i] as number[];
    const next = table[i + 1] as number[];
    for (let j = b.length - 1; j >= 0; j -= 1) {
      row[j] =
        a[i] === b[j]
          ? (next[j + 1] ?? 0) + 1
          : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  return table;
}

function groupHunks(lines: DiffLine[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;

  for (const line of lines) {
    if (line.op === 'equal') {
      if (current !== null) {
        hunks.push(current);
        current = null;
      }
      continue;
    }
    if (current === null) {
      current = {
        id: `hunk-${hunks.length}`,
        startOld: line.oldIndex ?? 0,
        endOld: line.oldIndex ?? 0,
        startNew: line.newIndex ?? 0,
        endNew: line.newIndex ?? 0,
        removed: [],
        added: [],
      };
    }
    if (line.op === 'delete') {
      current.removed.push(line.text);
      current.endOld = (line.oldIndex ?? 0) + 1;
    } else {
      current.added.push(line.text);
      current.endNew = (line.newIndex ?? 0) + 1;
    }
  }
  if (current !== null) hunks.push(current);
  return hunks;
}

/**
 * Applies only the hunks whose ids are listed. Everything else keeps the old text.
 * Hunks are applied bottom-up so earlier line offsets stay valid.
 */
export function applyHunks(oldText: string, newText: string, acceptedHunkIds: readonly string[]): string {
  const accepted = new Set(acceptedHunkIds);
  if (accepted.size === 0) return oldText;

  const { hunks, truncated } = diffLines(oldText, newText);
  if (truncated) {
    return accepted.has(hunks[0]?.id ?? '') ? newText : oldText;
  }

  const oldLines = splitLines(oldText);
  const ordered = [...hunks].sort((a, b) => b.startOld - a.startOld);
  const output = [...oldLines];

  for (const hunk of ordered) {
    if (!accepted.has(hunk.id)) continue;
    output.splice(hunk.startOld, hunk.endOld - hunk.startOld, ...hunk.added);
  }

  return output.join('\n');
}
