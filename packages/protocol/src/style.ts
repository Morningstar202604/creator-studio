import { z } from 'zod';

const IsoDateTime = z.string().datetime({ offset: false });

/**
 * A creator's reusable voice: tone, audience, banned words and free-form notes.
 * Profiles are user-scoped and may be attached to many projects; the generated
 * prompt treats them as preferences, never as instructions that override the
 * system contract.
 */
export const StyleProfileSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  name: z.string().min(1).max(60),
  tone: z.string().max(400).default(''),
  audience: z.string().max(200).default(''),
  bannedWords: z.array(z.string().min(1).max(20)).max(40).default([]),
  notes: z.string().max(600).default(''),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type StyleProfile = z.infer<typeof StyleProfileSchema>;

export const StyleProfileInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  tone: z.string().max(400).default(''),
  audience: z.string().max(200).default(''),
  bannedWords: z.array(z.string().trim().min(1).max(20)).max(40).default([]),
  notes: z.string().max(600).default(''),
});
export type StyleProfileInput = z.infer<typeof StyleProfileInputSchema>;

export type BannedWordHit = { word: string; count: number };

/** Counts each banned word once per occurrence; case-insensitive for latin terms. */
export function lintBannedWords(content: string, bannedWords: string[]): BannedWordHit[] {
  const haystack = content.toLowerCase();
  const hits: BannedWordHit[] = [];
  for (const raw of bannedWords) {
    const word = raw.trim();
    if (word === '') continue;
    const needle = word.toLowerCase();
    let count = 0;
    let cursor = haystack.indexOf(needle);
    while (cursor !== -1) {
      count += 1;
      cursor = haystack.indexOf(needle, cursor + needle.length);
    }
    if (count > 0) hits.push({ word, count });
  }
  return hits;
}
