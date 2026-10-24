import { z } from 'zod';

const Score = z.number().int().min(0).max(100);

export const TopicCardSchema = z.object({
  title: z.string().min(1).max(120),
  angle: z.string().min(1).max(300),
  scores: z.object({
    demand: Score,
    competition: Score,
    differentiation: Score,
    speakability: Score,
  }),
  composite: Score,
  rationale: z.string().min(1).max(500),
  risks: z.array(z.string().min(1).max(200)).max(5),
});
export type TopicCard = z.infer<typeof TopicCardSchema>;

export const TopicCardsSchema = z.object({
  cards: z.array(TopicCardSchema).min(1).max(6),
});
export type TopicCards = z.infer<typeof TopicCardsSchema>;

export const ResearchNoteSchema = z.object({
  claim: z.string().min(1).max(400),
  source: z.string().min(1).max(300),
  confidence: z.enum(['high', 'medium', 'low']),
  note: z.string().max(300),
});
export type ResearchNote = z.infer<typeof ResearchNoteSchema>;

export const ResearchNotesSchema = z.object({
  notes: z.array(ResearchNoteSchema).min(1).max(20),
  gaps: z.array(z.string().min(1).max(200)).max(10),
});
export type ResearchNotes = z.infer<typeof ResearchNotesSchema>;

export const TitleCandidateSchema = z.object({
  title: z.string().min(1).max(80),
  score: Score,
  reason: z.string().min(1).max(200),
});
export type TitleCandidate = z.infer<typeof TitleCandidateSchema>;

export const PublishPackSchema = z.object({
  titles: z.array(TitleCandidateSchema).min(3).max(15),
  description: z.string().min(1).max(1200),
  tags: z.array(z.string().min(1).max(20)).min(1).max(15),
  chapters: z.array(z.object({ time: z.string().min(1).max(12), label: z.string().min(1).max(80) })).max(30),
  coverBrief: z.string().min(1).max(300),
  compliance: z.array(z.string().max(200)).max(10),
});
export type PublishPack = z.infer<typeof PublishPackSchema>;

export function parseByKind(kind: GenerateKind, value: unknown): unknown {
  const coerced = coerceByKind(kind, value);
  if (kind === 'topic-card') return TopicCardsSchema.parse(coerced);
  if (kind === 'research-notes') return ResearchNotesSchema.parse(coerced);
  if (kind === 'script') return ScriptDraftSchema.parse(coerced);
  if (kind === 'shot-list') return ShotListSchema.parse(coerced);
  if (kind === 'review-report') return ReviewReportSchema.parse(coerced);
  return PublishPackSchema.parse(coerced);
}

/**
 * Models frequently wrap JSON in a markdown fence or add prose around it.
 * Strip the fence and take the outermost object before parsing.
 */
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = fenced !== null ? (fenced[1] as string) : trimmed;

  try {
    return JSON.parse(body) as unknown;
  } catch {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('NO_JSON_OBJECT');
    }
    return JSON.parse(body.slice(start, end + 1)) as unknown;
  }
}

export const ScriptDraftSchema = z.object({
  hook: z.string().min(1).max(400),
  sections: z
    .array(
      z.object({
        heading: z.string().min(1).max(80),
        content: z.string().min(1).max(4000),
        broll: z.string().max(300).optional(),
      }),
    )
    .min(2)
    .max(16),
  cta: z.string().min(1).max(300),
  estimatedMinutes: z.number().min(0.5).max(120),
});
export type ScriptDraft = z.infer<typeof ScriptDraftSchema>;

export const ShotSchema = z.object({
  index: z.number().int().nonnegative(),
  time: z.string().min(1).max(16),
  shot: z.string().min(1).max(200),
  visual: z.string().min(1).max(300),
  broll: z.string().max(300),
  onScreenText: z.string().max(120),
  durationSec: z.number().min(1).max(600),
});
export type Shot = z.infer<typeof ShotSchema>;

export const ShotListSchema = z.object({ shots: z.array(ShotSchema).min(3).max(80) });
export type ShotList = z.infer<typeof ShotListSchema>;

export const ReviewReportSchema = z.object({
  summary: z.string().min(1).max(600),
  findings: z
    .array(
      z.object({
        title: z.string().min(1).max(120),
        evidence: z.string().min(1).max(400),
        action: z.string().min(1).max(300),
      }),
    )
    .min(1)
    .max(10),
  nextTopics: z.array(z.string().min(1).max(120)).min(1).max(6),
  score: z.number().int().min(0).max(100),
});
export type ReviewReport = z.infer<typeof ReviewReportSchema>;

export type GenerateKind =
  | 'topic-card'
  | 'research-notes'
  | 'script'
  | 'shot-list'
  | 'publish-pack'
  | 'review-report';

export const GENERATE_KINDS: GenerateKind[] = [
  'topic-card',
  'research-notes',
  'script',
  'shot-list',
  'publish-pack',
  'review-report',
];

/**
 * Models drift: numbers arrive as strings, `risks` as a single string, and some
 * providers nest the payload one level too deep. Repair only these known shapes so
 * a good answer is not thrown away, then hand the result to the strict schema.
 * Anything else still fails closed.
 */
export function coerceByKind(kind: GenerateKind, value: unknown): unknown {
  const root = unwrap(value);

  if (kind === 'topic-card') {
    const cards = arrayOf(root, 'cards').map((card) => {
      const record = asRecord(card);
      return {
        ...record,
        title: text(record['title']),
        angle: text(record['angle']),
        composite: score(record['composite']),
        rationale: text(record['rationale']),
        scores: {
          demand: score(asRecord(record['scores'])['demand']),
          competition: score(asRecord(record['scores'])['competition']),
          differentiation: score(asRecord(record['scores'])['differentiation']),
          speakability: score(asRecord(record['scores'])['speakability']),
        },
        risks: stringList(record['risks']).slice(0, 5),
      };
    });
    return { cards };
  }

  if (kind === 'research-notes') {
    const notes = arrayOf(root, 'notes').map((note) => {
      const record = asRecord(note);
      return {
        claim: text(record['claim']),
        source: text(record['source']),
        confidence: confidence(record['confidence']),
        note: text(record['note']),
      };
    });
    return { notes, gaps: stringList(asRecord(root)['gaps']).slice(0, 10) };
  }

  if (kind === 'script') {
    const record = asRecord(root);
    return {
      hook: text(record['hook']),
      sections: arrayOf(root, 'sections').map((section) => {
        const entry = asRecord(section);
        return {
          heading: text(entry['heading']),
          content: text(entry['content']),
          ...(typeof entry['broll'] === 'string' && entry['broll'] !== '' ? { broll: entry['broll'] } : {}),
        };
      }),
      cta: text(record['cta']),
      estimatedMinutes: number(record['estimatedMinutes'], 8),
    };
  }

  if (kind === 'shot-list') {
    return {
      shots: arrayOf(root, 'shots').map((shot, index) => {
        const entry = asRecord(shot);
        return {
          index: Math.trunc(number(entry['index'], index)),
          time: text(entry['time']),
          shot: text(entry['shot']),
          visual: text(entry['visual']),
          broll: text(entry['broll']),
          onScreenText: text(entry['onScreenText']),
          durationSec: Math.max(1, Math.round(number(entry['durationSec'], 6))),
        };
      }),
    };
  }

  if (kind === 'review-report') {
    const record = asRecord(root);
    return {
      summary: text(record['summary']),
      findings: arrayOf(root, 'findings').map((finding) => {
        const entry = asRecord(finding);
        return { title: text(entry['title']), evidence: text(entry['evidence']), action: text(entry['action']) };
      }),
      nextTopics: stringList(record['nextTopics']).slice(0, 6),
      score: score(record['score']),
    };
  }

  const record = asRecord(root);
  return {
    titles: arrayOf(root, 'titles').map((title) => {
      const entry = asRecord(title);
      return { title: text(entry['title']), score: score(entry['score']), reason: text(entry['reason']) };
    }),
    description: text(record['description']),
    tags: stringList(record['tags']).slice(0, 15),
    chapters: arrayOf(root, 'chapters').map((chapter) => {
      const entry = asRecord(chapter);
      return { time: text(entry['time']), label: text(entry['label']) };
    }),
    coverBrief: text(record['coverBrief']),
    compliance: stringList(record['compliance']).slice(0, 10),
  };
}

function unwrap(value: unknown): unknown {
  const keys = ['cards', 'notes', 'shots', 'titles', 'findings'];
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return current;
    const record = current as Record<string, unknown>;
    const nestedWrapper = keys.find((key) => {
      const nested = record[key];
      if (typeof nested !== 'object' || nested === null || Array.isArray(nested)) return false;
      return Array.isArray((nested as Record<string, unknown>)[key]);
    });
    if (nestedWrapper !== undefined) {
      current = record[nestedWrapper];
      continue;
    }

    // Shape `{cards:[{cards:[...]}]}`: one wrapper element around the real list.
    const listWrapper = keys.find((key) => {
      const list = record[key];
      if (!Array.isArray(list) || list.length !== 1) return false;
      const only = list[0];
      return typeof only === 'object' && only !== null && Array.isArray((only as Record<string, unknown>)[key]);
    });
    if (listWrapper !== undefined) {
      const list = record[listWrapper] as unknown[];
      current = list[0];
      continue;
    }
    return current;
  }
  return current;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayOf(value: unknown, key: string): unknown[] {
  const candidate = asRecord(value)[key];
  return Array.isArray(candidate) ? candidate : [];
}

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function number(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value.replace(/[^\d.-]/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function score(value: unknown): number {
  const raw = number(value, 60);
  return Math.min(100, Math.max(0, Math.round(raw)));
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => text(entry)).filter((entry) => entry !== '');
  if (typeof value === 'string' && value.trim() !== '') {
    return value
      .split(/[;；\n]/)
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
  }
  return [];
}

function confidence(value: unknown): 'high' | 'medium' | 'low' {
  const raw = text(value).toLowerCase();
  if (raw.startsWith('high') || raw.includes('高')) return 'high';
  if (raw.startsWith('low') || raw.includes('低')) return 'low';
  return 'medium';
}
