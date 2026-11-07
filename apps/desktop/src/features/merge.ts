import { MAX_LCS_LINES, diffLines, type DiffHunk } from './diff';

/**
 * Three-way merge for prose.
 *
 * A conflict has three texts, not two: the base both writers started from, mine,
 * and theirs. Concatenating mine and theirs (the first implementation) produces a
 * chapter where every unchanged paragraph appears twice, which is worse than
 * asking the writer to choose. This merges the way a version-control tool does:
 * apply each side's hunks to the base; when two hunks touch the same base region,
 * emit a conflict block for the writer to resolve.
 *
 * It is line-based on purpose. Prose paragraphs are the unit a writer thinks in,
 * and a character-level merge would silently interleave two people's sentences
 * inside one paragraph — the case where "merged" is worse than "conflicted".
 */

export type MergeResult = {
  text: string;
  /** Regions both sides rewrote in the same place; they are marked in `text`. */
  conflicts: number;
  /** True when the inputs were too large for the LCS and the merge was abandoned. */
  degraded: boolean;
};

const MARK_START = '<<<<<<< 你的版本';
const MARK_SPLIT = '=======';
const MARK_END = '>>>>>>> 已存下的版本';

type Change = { start: number; end: number; lines: string[] };

/** Turns diff hunks against the base into `[start, end)` splices. */
function changesFromHunks(hunks: DiffHunk[]): Change[] {
  return hunks.map((hunk) => ({ start: hunk.startOld, end: hunk.endOld, lines: hunk.added }));
}

function overlaps(a: Change, b: Change): boolean {
  // A pure insertion has start === end; it only collides when it sits strictly
  // inside the other side's replaced range, or both insert at the same offset.
  if (a.start === a.end && b.start === b.end) return a.start === b.start;
  if (a.start === a.end) return a.start > b.start && a.start < b.end;
  if (b.start === b.end) return b.start > a.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
}

/**
 * Merges two edits made against the same base.
 *
 * `base` is what both writers last saw; pass the text as of the last successful
 * save. When a caller cannot supply a base (the version was never loaded), pass
 * `null` and the result degrades to appending — still lossless, just less tidy.
 */
export function mergeThreeWay(base: string | null, mine: string, theirs: string): MergeResult {
  if (mine === theirs) return { text: mine, conflicts: 0, degraded: false };
  if (base === null || base === '') {
    // Nothing to attribute changes to. Keep both fully rather than guess.
    return { text: appendBlock(mine, theirs), conflicts: 1, degraded: true };
  }
  if (mine === base) return { text: theirs, conflicts: 0, degraded: false };
  if (theirs === base) return { text: mine, conflicts: 0, degraded: false };

  const baseLines = base.split('\n');
  if (baseLines.length > MAX_LCS_LINES || mine.split('\n').length > MAX_LCS_LINES || theirs.split('\n').length > MAX_LCS_LINES) {
    return { text: appendBlock(mine, theirs), conflicts: 1, degraded: true };
  }

  const mineChanges = changesFromHunks(diffLines(base, mine).hunks);
  const theirsChanges = changesFromHunks(diffLines(base, theirs).hunks);

  // Both lists are ordered by start offset. Walk the base once, emitting each
  // change as it is reached and grouping the ones that collide.
  const out: string[] = [];
  let cursor = 0;
  let conflicts = 0;
  let mineIndex = 0;
  let theirsIndex = 0;

  while (mineIndex < mineChanges.length || theirsIndex < theirsChanges.length) {
    const nextMine = mineChanges[mineIndex];
    const nextTheirs = theirsChanges[theirsIndex];

    let group: Change[];
    let groupStart: number;
    let groupEnd: number;

    if (nextMine === undefined) {
      group = [nextTheirs as Change];
      groupStart = (nextTheirs as Change).start;
      groupEnd = (nextTheirs as Change).end;
      theirsIndex += 1;
    } else if (nextTheirs === undefined) {
      group = [nextMine];
      groupStart = nextMine.start;
      groupEnd = nextMine.end;
      mineIndex += 1;
    } else if (overlaps(nextMine, nextTheirs)) {
      group = [nextMine, nextTheirs];
      groupStart = Math.min(nextMine.start, nextTheirs.start);
      groupEnd = Math.max(nextMine.end, nextTheirs.end);
      mineIndex += 1;
      theirsIndex += 1;
    } else if (nextMine.start <= nextTheirs.start) {
      group = [nextMine];
      groupStart = nextMine.start;
      groupEnd = nextMine.end;
      mineIndex += 1;
    } else {
      group = [nextTheirs];
      groupStart = nextTheirs.start;
      groupEnd = nextTheirs.end;
      theirsIndex += 1;
    }

    // Copy the untouched base text before this change.
    for (let index = cursor; index < groupStart; index += 1) out.push(baseLines[index] as string);

    if (group.length === 1) {
      out.push(...(group[0] as Change).lines);
    } else {
      // Same region rewritten by both: keep both, clearly delimited.
      out.push(MARK_START, ...(group[0] as Change).lines, MARK_SPLIT, ...(group[1] as Change).lines, MARK_END);
      conflicts += 1;
    }
    cursor = Math.max(cursor, groupEnd);
  }

  for (let index = cursor; index < baseLines.length; index += 1) out.push(baseLines[index] as string);

  return { text: out.join('\n'), conflicts, degraded: false };
}

/** Last-resort composition: nothing is lost, and it is visibly two versions. */
function appendBlock(mine: string, theirs: string): string {
  return `${mine}\n\n---\n\n${theirs}`;
}
