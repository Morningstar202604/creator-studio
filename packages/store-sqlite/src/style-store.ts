import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import {
  StyleProfileInputSchema,
  StyleProfileSchema,
  type StyleProfile,
} from '@creator-studio/protocol';

type StyleRow = {
  id: string;
  user_id: string;
  name: string;
  tone: string;
  audience: string;
  banned_words: string;
  notes: string;
  created_at: string;
  updated_at: string;
};

function parseWords(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((word): word is string => typeof word === 'string');
  } catch {
    return [];
  }
}

function toProfile(row: StyleRow): StyleProfile {
  return StyleProfileSchema.parse({
    id: row.id,
    userId: row.user_id,
    name: row.name,
    tone: row.tone,
    audience: row.audience,
    bannedWords: parseWords(row.banned_words),
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export type SaveStyleInput = {
  id?: string;
  name: string;
  tone?: string;
  audience?: string;
  bannedWords?: string[];
  notes?: string;
};

function dedupe(words: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const word of words) {
    const trimmed = word.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length === 40) break;
  }
  return out;
}

export class SqliteStyleStore {
  constructor(
    private readonly db: Database,
    private readonly userId = 'local-user',
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(): StyleProfile[] {
    const rows = this.db
      .prepare('SELECT * FROM style_profiles WHERE user_id = ? ORDER BY updated_at DESC')
      .all(this.userId) as StyleRow[];
    return rows.map(toProfile);
  }

  get(id: string): StyleProfile | null {
    const row = this.db
      .prepare('SELECT * FROM style_profiles WHERE id = ? AND user_id = ?')
      .get(id, this.userId) as StyleRow | undefined;
    return row === undefined ? null : toProfile(row);
  }

  save(input: SaveStyleInput): StyleProfile {
    const parsed = StyleProfileInputSchema.parse({
      name: input.name,
      tone: input.tone ?? '',
      audience: input.audience ?? '',
      bannedWords: dedupe(input.bannedWords ?? []),
      notes: input.notes ?? '',
    });
    const timestamp = this.now().toISOString();
    const existing = input.id === undefined ? null : this.get(input.id);
    const profile = StyleProfileSchema.parse({
      id: existing?.id ?? input.id ?? randomUUID(),
      userId: this.userId,
      name: parsed.name,
      tone: parsed.tone,
      audience: parsed.audience,
      bannedWords: parsed.bannedWords,
      notes: parsed.notes,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
    this.db
      .prepare(
        `INSERT INTO style_profiles (id, user_id, name, tone, audience, banned_words, notes, created_at, updated_at)
         VALUES (@id, @user_id, @name, @tone, @audience, @banned_words, @notes, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           name = @name, tone = @tone, audience = @audience, banned_words = @banned_words,
           notes = @notes, updated_at = @updated_at`,
      )
      .run({
        id: profile.id,
        user_id: profile.userId,
        name: profile.name,
        tone: profile.tone,
        audience: profile.audience,
        banned_words: JSON.stringify(profile.bannedWords),
        notes: profile.notes,
        created_at: profile.createdAt,
        updated_at: profile.updatedAt,
      });
    return profile;
  }

  /** Detaches the profile from every project before removing it. */
  delete(id: string): boolean {
    const remove = this.db.transaction(() => {
      const profile = this.db
        .prepare('SELECT id FROM style_profiles WHERE id = ? AND user_id = ?')
        .get(id, this.userId) as { id: string } | undefined;
      if (profile === undefined) return false;
      this.db.prepare('UPDATE projects SET style_profile_id = NULL WHERE style_profile_id = ?').run(id);
      this.db.prepare('DELETE FROM style_profiles WHERE id = ? AND user_id = ?').run(id, this.userId);
      return true;
    });
    return remove();
  }
}
