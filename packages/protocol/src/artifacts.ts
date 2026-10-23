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

export type GenerateKind = 'topic-card' | 'research-notes' | 'publish-pack';

export const GENERATE_KINDS: GenerateKind[] = ['topic-card', 'research-notes', 'publish-pack'];

export function parseByKind(kind: GenerateKind, value: unknown): unknown {
  if (kind === 'topic-card') return TopicCardsSchema.parse(value);
  if (kind === 'research-notes') return ResearchNotesSchema.parse(value);
  return PublishPackSchema.parse(value);
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
