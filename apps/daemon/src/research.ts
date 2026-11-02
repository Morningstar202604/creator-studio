import { createHash } from 'node:crypto';
import { fenceUntrusted } from '@creator-studio/tools';
import { FetchGuardError, fetchPage, type FetchedPage } from '@creator-studio/tools';
import type { ResearchNotes, ResearchNote } from '@creator-studio/protocol';

export type SourceRef = {
  url: string;
  finalUrl: string;
  title: string;
  status: number;
  bytes: number;
  truncated: boolean;
  fetchedAt: string;
  sha256: string;
};

export type FetchFailure = { url: string; code: string; message: string };

export type ResearchBundle = {
  sources: SourceRef[];
  failures: FetchFailure[];
  /** Fetched text kept for quote verification; never serialized to the client. */
  pages: Array<{ url: string; text: string }>;
  /** Fenced excerpts handed to the model; never raw HTML. */
  promptBlock: string;
};

export const MAX_SOURCES = 5;
export const MAX_CHARS_PER_SOURCE = 6_000;

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Normalizes for quote matching: case, whitespace, punctuation width and entities. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u00a0]+/g, '')
    .replace(/[，,。.！!？?；;：:、"'“”‘’()（）\[\]【】《》<>—–-]/g, '');
}

/**
 * Fetches the caller-supplied sources and builds the fenced prompt block. Each
 * failure is reported rather than hidden: a stage with zero sources must be able
 * to tell the user why, instead of silently falling back to model memory.
 */
export async function gatherSources(
  urls: string[],
  options: { fetchImpl?: typeof fetch; lookup?: Parameters<typeof fetchPage>[1] extends infer O ? O extends { lookup?: infer L } ? L : never : never } = {},
): Promise<ResearchBundle> {
  const unique: string[] = [];
  for (const raw of urls) {
    const trimmed = raw.trim();
    if (trimmed === '' || unique.includes(trimmed)) continue;
    unique.push(trimmed);
    if (unique.length >= MAX_SOURCES) break;
  }

  const sources: SourceRef[] = [];
  const failures: FetchFailure[] = [];
  const blocks: string[] = [];
  const pages: Array<{ url: string; text: string }> = [];

  for (const url of unique) {
    try {
      const page: FetchedPage = await fetchPage(url, {
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        ...(options.lookup === undefined ? {} : { lookup: options.lookup }),
      });
      if (page.status >= 400) {
        failures.push({ url, code: `HTTP_${page.status}`, message: `server returned ${page.status}` });
        continue;
      }
      const excerpt = page.text.slice(0, MAX_CHARS_PER_SOURCE);
      sources.push({
        url,
        finalUrl: page.finalUrl,
        title: page.title,
        status: page.status,
        bytes: page.bytes,
        truncated: page.truncated || page.text.length > MAX_CHARS_PER_SOURCE,
        fetchedAt: page.fetchedAt,
        sha256: sha256(page.text),
      });
      pages.push({ url: page.finalUrl, text: page.text });
      blocks.push(
        fenceUntrusted(
          `标题：${page.title || '（无标题）'}\n来源：${page.finalUrl}\n抓取时间：${page.fetchedAt}\n\n${excerpt}`,
          `fetch:${page.finalUrl}`,
        ),
      );
    } catch (error) {
      const code = error instanceof FetchGuardError ? error.code : 'FETCH_FAILED';
      failures.push({ url, code, message: error instanceof Error ? error.message : String(error) });
    }
  }

  return { sources, failures, pages, promptBlock: blocks.join('\n\n') };
}

/** Markdown ledger appended to the artifact so every claim has a traceable origin. */
export function renderSourceLedger(bundle: ResearchBundle): string {
  const lines: string[] = ['', '---', '', '## 抓取记录', ''];
  if (bundle.sources.length === 0) {
    lines.push('（本轮没有成功抓取任何来源）', '');
  } else {
    lines.push('| 来源 | 标题 | 抓取时间 | 字节 | sha256(前 12) |', '|---|---|---|---|---|');
    for (const source of bundle.sources) {
      const title = source.title === '' ? '（无标题）' : source.title.replace(/\|/g, '\\|');
      lines.push(
        `| ${source.finalUrl} | ${title} | ${source.fetchedAt} | ${source.bytes}${source.truncated ? '（截断）' : ''} | \`${source.sha256.slice(0, 12)}\` |`,
      );
    }
    lines.push('');
  }
  if (bundle.failures.length > 0) {
    lines.push('抓取失败：', '');
    for (const failure of bundle.failures) lines.push(`- ${failure.url} — ${failure.code}`);
    lines.push('');
  }
  return lines.join('\n');
}

export type VerifiedNote = ResearchNote & {
  /** True when at least one sentence-ish slice of `note`/`claim` appears in a source. */
  quoteVerified: boolean;
  matchedUrl: string | null;
};

export type VerificationResult = {
  notes: VerifiedNote[];
  unverified: number;
  downgraded: number;
};

/**
 * Downgrades confidence for notes whose claim cannot be located in the fetched
 * text. A high-confidence claim with no matching quote is exactly the failure mode
 * this project exists to prevent, so it becomes `low` with an explicit reason
 * instead of being silently trusted.
 */
export function verifyNotes(payload: ResearchNotes, pages: Array<{ url: string; text: string }>): VerificationResult {
  const normalizedPages = pages.map((page) => ({ url: page.url, text: normalizeForMatch(page.text) }));
  let unverified = 0;
  let downgraded = 0;

  const notes = payload.notes.map((note): VerifiedNote => {
    const needles = [note.claim, note.note]
      .filter((value) => value.trim() !== '')
      .map((value) => normalizeForMatch(value))
      .filter((value) => value.length >= 6);
    const matchedUrl =
      needles.length === 0
        ? null
        : (normalizedPages.find((page) => needles.some((needle) => page.text.includes(needle)))?.url ?? null);
    if (matchedUrl !== null) return { ...note, quoteVerified: true, matchedUrl };
    unverified += 1;
    const wasConfident = note.confidence !== 'low';
    if (wasConfident) downgraded += 1;
    const reason = '未在已抓取原文中找到对应表述，已降级为 low；请人工核对';
    return {
      ...note,
      confidence: 'low',
      note: note.note === '' ? reason : `${note.note}（${reason}）`,
      quoteVerified: false,
      matchedUrl: null,
    };
  });

  return { notes, unverified, downgraded };
}
