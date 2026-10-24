/**
 * Embedding helpers used by the local memory index.
 *
 * `hashEmbedding` is a deterministic, dependency-free feature-hashing embedder.
 * It is **lexical**, not neural: it maps character n-grams (CJK) and word tokens
 * (Latin) into a fixed-dimension vector, so semantically similar wording scores
 * higher while unrelated text stays near zero. It runs offline and costs nothing,
 * which is the right default for a local-first app. When a real embedding model is
 * configured, `ModelGateway.embed()` is used instead (see `createMemoryIndexer`).
 */

export const HASH_DIMENSIONS = 256;

function tokenize(text: string): string[] {
  const normalized = text.toLowerCase();
  const tokens: string[] = [];

  // CJK: single characters plus adjacent bigrams carry most of the signal.
  const cjk = normalized.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? [];
  for (let index = 0; index < cjk.length; index += 1) {
    tokens.push(cjk[index] as string);
    const next = cjk[index + 1];
    if (next !== undefined) tokens.push(`${cjk[index]}${next}`);
  }

  // Latin/numbers: split on non-word characters, keep tokens of length >= 2.
  for (const word of normalized.split(/[^\p{L}\p{N}_]+/u)) {
    if (word.length >= 2) tokens.push(word);
  }
  return tokens;
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function hashEmbedding(text: string, dimensions = HASH_DIMENSIONS): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (const token of tokenize(text)) {
    const hash = fnv1a(token);
    const slot = hash % dimensions;
    const sign = (hash & 0x80000000) === 0 ? 1 : -1;
    vector[slot] = (vector[slot] as number) + sign;
  }
  return normalize(vector);
}

export function normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) return vector;
  return vector.map((value) => value / magnitude);
}

export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const length = Math.min(a.length, b.length);
  let dot = 0;
  for (let index = 0; index < length; index += 1) {
    dot += (a[index] as number) * (b[index] as number);
  }
  return dot;
}

/** Splits long text into overlapping chunks so a script is retrievable by section. */
export function chunkText(text: string, size = 600, overlap = 80): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (clean === '') return [];
  if (clean.length <= size) return [clean];

  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    const end = Math.min(start + size, clean.length);
    chunks.push(clean.slice(start, end).trim());
    if (end === clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks.filter((chunk) => chunk !== '');
}

export type EmbeddingProvider = {
  id: string;
  /** True when vectors are real model output rather than lexical hashing. */
  neural: boolean;
  embed(texts: string[]): Promise<number[][]>;
};

export function localEmbeddingProvider(dimensions = HASH_DIMENSIONS): EmbeddingProvider {
  return {
    id: 'hash-ngram',
    neural: false,
    embed: async (texts) => texts.map((text) => hashEmbedding(text, dimensions)),
  };
}
