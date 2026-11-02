import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import type { EntityCard } from '@creator-studio/protocol';

/**
 * Manuscript assembly.
 *
 * A writing project keeps its prose on cards, so "export the book" means: order
 * the cards, take the configured prose field (or the card body), and hand the
 * result to a real OOXML writer. `docx` is used instead of hand-rolling Word
 * packaging: a minimal .docx is a zip of five related XML parts, and every one of
 * them has schema rules that are easy to get subtly wrong.
 */

export const MANUSCRIPT_MAX_CHARS = 2_000_000;

export type ManuscriptSource = {
  /** Field holding prose; undefined means the card body. */
  bodyField?: string | undefined;
  /** Field used as the heading; undefined means the card title. */
  titleField?: string | undefined;
  /** Field that orders chapters; undefined means the card `order` column. */
  orderField?: string | undefined;
};

export type ManuscriptChapter = { id: string; title: string; text: string; order: number };

/**
 * Sort key for a chapter: the declared order field wins, then the card's own
 * order column, then the position it arrived in. Cards without a usable number
 * sort after numbered ones instead of jumping to the front.
 */
export function chapterSortKey(
  card: EntityCard,
  orderField: string | undefined,
  index: number,
): [number, number, number] {
  if (orderField !== undefined) {
    const parsed = Number.parseInt(card.fields[orderField] ?? '', 10);
    if (!Number.isNaN(parsed)) return [0, parsed, index];
  }
  return [1, card.order, index];
}

export function collectChapters(cards: EntityCard[], source: ManuscriptSource = {}): ManuscriptChapter[] {
  const withIndex = cards.map((card, index) => ({ card, index }));
  withIndex.sort((a, b) => {
    const left = chapterSortKey(a.card, source.orderField, a.index);
    const right = chapterSortKey(b.card, source.orderField, b.index);
    return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
  });
  return withIndex.map(({ card, index }) => ({
    id: card.id,
    title: (source.titleField === undefined ? card.title : card.fields[source.titleField]) || card.title,
    text: source.bodyField === undefined ? card.body : (card.fields[source.bodyField] ?? ''),
    order: chapterSortKey(card, source.orderField, index)[1],
  }));
}

function paragraphsFor(text: string): Paragraph[] {
  const lines = text.split(/\r?\n/);
  const paragraphs: Paragraph[] = [];
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed.trim() === '') continue;
    paragraphs.push(
      new Paragraph({
        children: [new TextRun({ text: trimmed, size: 24 })],
        spacing: { line: 360, after: 120 },
      }),
    );
  }
  if (paragraphs.length === 0) paragraphs.push(new Paragraph({ children: [new TextRun('')] }));
  return paragraphs;
}

export type ManuscriptOptions = {
  title: string;
  chapters: ManuscriptChapter[];
  /** Prepended as a cover page; skipped when empty. */
  author?: string;
};

export function buildMarkdown(options: ManuscriptOptions): string {
  const parts = [`# ${options.title}`, ''];
  if (options.author !== undefined && options.author !== '') parts.push(`作者：${options.author}`, '');
  for (const chapter of options.chapters) {
    parts.push(`## ${chapter.title}`, '', chapter.text.trim(), '');
  }
  return parts.join('\n');
}

export async function buildDocx(options: ManuscriptOptions): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({
      children: [new TextRun({ text: options.title, bold: true, size: 64 })],
      alignment: 'center',
      spacing: { before: 2400, after: 240 },
    }),
  ];
  if (options.author !== undefined && options.author !== '') {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: options.author, size: 28 })],
        alignment: 'center',
        spacing: { after: 2000 },
      }),
    );
  }

  options.chapters.forEach((chapter, index) => {
    children.push(
      new Paragraph({
        text: chapter.title,
        heading: HeadingLevel.HEADING_1,
        pageBreakBefore: index > 0,
        spacing: { after: 240 },
      }),
    );
    children.push(...paragraphsFor(chapter.text));
  });

  const document = new Document({
    creator: 'Creator Studio',
    title: options.title,
    description: `${options.chapters.length} chapters`,
    sections: [{ children }],
  });
  return Packer.toBuffer(document);
}

export function countChars(text: string): number {
  return text.replace(/\s/g, '').length;
}
