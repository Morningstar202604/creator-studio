import {
  GENERATE_KINDS,
  extractJson,
  parseByKind,
  type GenerateKind,
} from '@creator-studio/protocol';

export type GeneratePrompts = Record<GenerateKind, { system: string; user: (context: string) => string }>;

export const PROMPTS: GeneratePrompts = {
  'topic-card': {
    system:
      '你是中文长视频的选题策划。只输出 JSON，不要 Markdown 围栏，不要任何解释。' +
      'JSON 形如 {"cards":[{"title","angle","scores":{"demand","competition","differentiation","speakability"},"composite","rationale","risks"}]}。' +
      '四项分数与 composite 都是 0-100 的整数；competition 越高表示竞争越激烈（越低越好）；risks 是字符串数组，最多 5 条。',
    user: (context) =>
      `方向：${context}\n\n请给出 3 个差异化选题，评分要有区分度，不要都给高分。`,
  },
  'research-notes': {
    system:
      '你是事实核查型资料员。只输出 JSON，不要围栏。' +
      'JSON 形如 {"notes":[{"claim","source","confidence":"high|medium|low","note"}],"gaps":[string]}。' +
      'source 写你可以识别的来源名称或域名；不确定来源时 confidence 必须为 low，并在 note 里说明。',
    user: (context) => `主题：${context}\n\n请列出 5-8 条可核查的事实要点，并指出资料缺口。`,
  },
  'publish-pack': {
    system:
      '你是中文视频的包装编辑。只输出 JSON，不要围栏。' +
      'JSON 形如 {"titles":[{"title","score","reason"}],"description","tags":[string],"chapters":[{"time","label"}],"coverBrief","compliance":[string]}。' +
      'titles 至少 3 条、最多 15 条，score 是 0-100 整数；compliance 列出可能违规的点，没有就给空数组。',
    user: (context) => `内容概要：${context}\n\n请给出标题候选、简介、标签、章节与封面文案 brief。`,
  },
};

export function artifactPathFor(kind: GenerateKind, version: number): string {
  const folder = kind === 'topic-card' ? 'topic' : kind === 'research-notes' ? 'research' : 'publish';
  return `${folder}/${kind}.v${version}.md`;
}

export type GenerateRequest = {
  kind: GenerateKind;
  context: string;
};

/** Kinds that may feed each other's prompts, in pipeline order. */
/** Upstream stages may include artifact kinds that are not generate targets (script). */
export const UPSTREAM: Record<GenerateKind, string[]> = {
  'topic-card': [],
  'research-notes': ['topic-card'],
  'publish-pack': ['topic-card', 'research-notes', 'script'],
};

export const UPSTREAM_CHAR_LIMIT = 2000;
export const UPSTREAM_TOTAL_LIMIT = 6000;

const NL = String.fromCharCode(10);
const LINE_BREAK = NL + NL;
const TRUNCATION_MARK = NL + '…（已截断）';
const UPSTREAM_HEADER = '【上游产物：';
const UPSTREAM_HEADER_END = '】';
const BLOCK_JOIN = NL + NL;

export type UpstreamDoc = { kind: string; content: string };

/**
 * Appends prior-stage artifacts to the user prompt so a later stage can build on
 * earlier output. Each document is truncated and the total is capped, so a long
 * script cannot blow the context window.
 */
/**
 * Upstream artifacts are authored by this project, but a research note may quote a
 * web page. They enter the prompt inside a fence so quoted instructions stay inert.
 */
export function buildUpstreamContext(docs: UpstreamDoc[], fence?: (text: string, source: string) => string): string {
  if (docs.length === 0) return '';
  let budget = UPSTREAM_TOTAL_LIMIT;
  const blocks: string[] = [];
  for (const doc of docs) {
    if (budget <= 0) break;
    const limit = Math.min(UPSTREAM_CHAR_LIMIT, budget);
    const truncated = doc.content.length > limit;
    const body = truncated ? doc.content.slice(0, limit) + TRUNCATION_MARK : doc.content;
    budget -= body.length;
    const wrapped = fence === undefined ? body : fence(body, `artifact:${doc.kind}`);
    blocks.push(UPSTREAM_HEADER + doc.kind + UPSTREAM_HEADER_END + LINE_BREAK + wrapped);
  }
  return blocks.join(BLOCK_JOIN);
}

export function isGenerateKind(value: string): value is GenerateKind {
  return (GENERATE_KINDS as string[]).includes(value);
}

/**
 * Turns raw model text into a validated payload. Throws `MODEL_BAD_OUTPUT` when the
 * content cannot be parsed or fails the contract, so callers can fail closed.
 */
export function parseGenerated(kind: GenerateKind, raw: string): unknown {
  let extracted: unknown;
  try {
    extracted = extractJson(raw);
  } catch {
    throw new Error('MODEL_BAD_OUTPUT: response contained no JSON object');
  }
  try {
    return parseByKind(kind, extracted);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'schema validation failed';
    throw new Error(`MODEL_BAD_OUTPUT: ${message}`);
  }
}

export function renderMarkdown(kind: GenerateKind, payload: unknown): string {
  if (kind === 'topic-card') {
    const data = payload as { cards: Array<Record<string, unknown>> };
    return data.cards
      .map((card, index) => {
        const scores = card.scores as Record<string, number>;
        return [
          `## ${index + 1}. ${String(card.title)}`,
          '',
          `- 角度：${String(card.angle)}`,
          `- 综合分：${String(card.composite)}`,
          `- 需求 ${scores.demand} / 竞争 ${scores.competition} / 差异 ${scores.differentiation} / 可讲 ${scores.speakability}`,
          `- 理由：${String(card.rationale)}`,
          ...(Array.isArray(card.risks) && card.risks.length > 0
            ? [`- 风险：${(card.risks as string[]).join('；')}`]
            : []),
        ].join('\n');
      })
      .join('\n\n');
  }

  if (kind === 'research-notes') {
    const data = payload as { notes: Array<Record<string, unknown>>; gaps: string[] };
    const notes = data.notes
      .map((note, index) => `${index + 1}. ${String(note.claim)}（${String(note.confidence)}）—— ${String(note.source)}`)
      .join('\n');
    const gaps = data.gaps.length === 0 ? '（无）' : data.gaps.map((gap) => `- ${gap}`).join('\n');
    return `## 事实要点\n\n${notes}\n\n## 资料缺口\n\n${gaps}`;
  }

  const data = payload as {
    titles: Array<Record<string, unknown>>;
    description: string;
    tags: string[];
    chapters: Array<{ time: string; label: string }>;
    coverBrief: string;
    compliance: string[];
  };
  const titles = data.titles
    .map((item, index) => `${index + 1}. ${String(item.title)}（${String(item.score)}）— ${String(item.reason)}`)
    .join('\n');
  const chapters = data.chapters.map((chapter) => `- ${chapter.time} ${chapter.label}`).join('\n');
  const compliance = data.compliance.length === 0 ? '（无）' : data.compliance.map((item) => `- ${item}`).join('\n');
  return [
    '## 标题候选',
    '',
    titles,
    '',
    '## 简介',
    '',
    data.description,
    '',
    '## 标签',
    '',
    data.tags.join(' / '),
    '',
    '## 章节',
    '',
    chapters === '' ? '（无）' : chapters,
    '',
    '## 封面上屏文案',
    '',
    data.coverBrief,
    '',
    '## 合规提示',
    '',
    compliance,
  ].join('\n');
}
