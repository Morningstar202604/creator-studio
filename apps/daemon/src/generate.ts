import {
  GENERATE_KINDS,
  extractJson,
  parseByKind,
  type GenerateKind,
} from '@creator-studio/protocol';

export type GeneratePrompts = Record<GenerateKind, { system: string; user: (context: string) => string }>;

const JSON_ONLY =
  '只输出一个 JSON 对象，第一个字符必须是 {，最后一个字符必须是 }。不要 Markdown 围栏，不要任何解释。';

export const PROMPTS: GeneratePrompts = {
  'topic-card': {
    system:
      '你是中文长视频的选题策划。' +
      JSON_ONLY +
      'JSON 形如 {"cards":[{"title","angle","scores":{"demand","competition","differentiation","speakability"},"composite","rationale","risks"}]}。' +
      '四项分数与 composite 都是 0-100 的整数；competition 越高表示竞争越激烈（越低越好）；risks 是字符串数组，最多 5 条。',
    user: (context) => `方向：${context}\n\n请给出 3 个差异化选题，评分要有区分度，不要都给高分。`,
  },
  'research-notes': {
    system:
      '你是事实核查型资料员。' +
      JSON_ONLY +
      'JSON 形如 {"notes":[{"claim","source","confidence":"high|medium|low","note"}],"gaps":[string]}。' +
      'source 写你可以识别的来源名称或域名；不确定来源时 confidence 必须为 low，并在 note 里说明。',
    user: (context) => `主题：${context}\n\n请列出 5-8 条可核查的事实要点，并指出资料缺口。`,
  },
  script: {
    system:
      '你是中文长视频编剧。' +
      JSON_ONLY +
      'JSON 形如 {"hook","sections":[{"heading","content","broll"}],"cta","estimatedMinutes"}。' +
      'hook 是开场 3 句内的钩子；sections 2-16 段，每段 content 是可直接口播的完整段落，不要写镜头提示；' +
      'broll 是可选的画面建议；estimatedMinutes 是按每分钟 260 字估算的时长。',
    user: (context) =>
      `选题与资料：${context}\n\n请写一版 8-15 分钟的口播脚本，观点要具体、有例子，避免空话。`,
  },
  'shot-list': {
    system:
      '你是中文视频导演助理。' +
      JSON_ONLY +
      'JSON 形如 {"shots":[{"index","time","shot","visual","broll","onScreenText","durationSec"}]}。' +
      'index 从 0 递增；time 是 mm:ss；shot 是景别与运镜；visual 是画面内容；broll 是可用素材；' +
      'onScreenText 是上屏字幕，没有就空字符串；durationSec 是 1-600 的整数秒。',
    user: (context) => `脚本：${context}\n\n请拆出 8-30 个镜头，节奏上每 5-12 秒一个镜头。`,
  },
  'publish-pack': {
    system:
      '你是中文视频的包装编辑。' +
      JSON_ONLY +
      'JSON 形如 {"titles":[{"title","score","reason"}],"description","tags":[string],"chapters":[{"time","label"}],"coverBrief","compliance":[string]}。' +
      'titles 至少 3 条、最多 15 条，score 是 0-100 整数；compliance 列出可能违规的点，没有就给空数组。',
    user: (context) => `内容概要：${context}\n\n请给出标题候选、简介、标签、章节与封面文案 brief。`,
  },
  'review-report': {
    system:
      '你是内容复盘分析师。' +
      JSON_ONLY +
      'JSON 形如 {"summary","findings":[{"title","evidence","action"}],"nextTopics":[string],"score"}。' +
      'findings 必须引用给出的数据，不许编造平台指标；score 是 0-100 的整数；nextTopics 给 1-6 条下一期方向。',
    user: (context) => `本期数据与内容摘要：${context}\n\n请给出可执行的归因结论与下一期建议。`,
  },
};

/** A literal, minimal example. Providers follow examples far better than prose. */
export const EXAMPLES: Record<GenerateKind, string> = {
  'topic-card': JSON.stringify({
    cards: [
      {
        title: '一句话选题标题',
        angle: '从什么角度讲，和同题内容的差异在哪',
        scores: { demand: 82, competition: 45, differentiation: 71, speakability: 76 },
        composite: 76,
        rationale: '为什么值得做，给出依据',
        risks: ['可能的风险一', '可能的风险二'],
      },
    ],
  }),
  'research-notes': JSON.stringify({
    notes: [
      { claim: '可核查的事实陈述', source: '来源名称或域名', confidence: 'medium', note: '口径或限制' },
    ],
    gaps: ['还缺哪类资料'],
  }),
  script: JSON.stringify({
    hook: '开场三句内的钩子',
    sections: [
      { heading: '一、小节标题', content: '可直接口播的完整段落。', broll: '可选画面建议' },
      { heading: '二、小节标题', content: '第二段口播。' },
    ],
    cta: '结尾行动号召',
    estimatedMinutes: 9,
  }),
  'shot-list': JSON.stringify({
    shots: [
      {
        index: 0,
        time: '00:00',
        shot: '近景 / 固定',
        visual: '画面内容',
        broll: '可替换素材',
        onScreenText: '上屏字幕',
        durationSec: 8,
      },
      {
        index: 1,
        time: '00:08',
        shot: '中景 / 推',
        visual: '屏幕录屏',
        broll: '代码片段',
        onScreenText: '',
        durationSec: 10,
      },
      {
        index: 2,
        time: '00:18',
        shot: '远景',
        visual: '环境空镜',
        broll: '城市延时',
        onScreenText: '结论',
        durationSec: 6,
      },
    ],
  }),
  'publish-pack': JSON.stringify({
    titles: [
      { title: '标题候选一', score: 90, reason: '具体、有信息量' },
      { title: '标题候选二', score: 85, reason: '有冲突' },
      { title: '标题候选三', score: 80, reason: '有收益承诺' },
    ],
    description: '简介正文',
    tags: ['标签一', '标签二'],
    chapters: [{ time: '00:00', label: '开场' }],
    coverBrief: '封面构图与上屏文案 brief',
    compliance: [],
  }),
  'review-report': JSON.stringify({
    summary: '一段总结',
    findings: [{ title: '归因结论', evidence: '引用的数据', action: '下一步动作' }],
    nextTopics: ['下一期方向'],
    score: 82,
  }),
};

/** Second attempt: show the exact shape and name the failure. */
export function repairPrompt(example: string, failure: string): string {
  return `上一次输出不符合契约（${failure.slice(0, 200)}）。请严格按下面的字段名与类型重新输出，字段一个都不能少，值必须是示例同类型：

${example}

只输出这个 JSON 对象本身。`;
}

export function artifactPathFor(kind: GenerateKind, version: number): string {
  const folder =
    kind === 'topic-card'
      ? 'topic'
      : kind === 'research-notes'
        ? 'research'
        : kind === 'script'
          ? 'script'
          : kind === 'shot-list'
            ? 'shotlist'
            : kind === 'review-report'
              ? 'review'
              : 'publish';
  return `${folder}/${kind}.v${version}.md`;
}

/** Kinds that may feed each other's prompts, in pipeline order. */
export const UPSTREAM: Record<GenerateKind, string[]> = {
  'topic-card': [],
  'research-notes': ['topic-card'],
  script: ['topic-card', 'research-notes'],
  'shot-list': ['script'],
  'publish-pack': ['topic-card', 'research-notes', 'script'],
  'review-report': ['publish-pack', 'script'],
};

export const UPSTREAM_CHAR_LIMIT = 2400;
export const UPSTREAM_TOTAL_LIMIT = 8000;

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

  if (kind === 'script') {
    const data = payload as {
      hook: string;
      sections: Array<{ heading: string; content: string; broll?: string }>;
      cta: string;
      estimatedMinutes: number;
    };
    const sections = data.sections
      .map((section, index) => {
        const lines = [`## ${index + 1}. ${section.heading}`, '', section.content];
        if (section.broll !== undefined && section.broll !== '') lines.push('', `> 画面建议：${section.broll}`);
        return lines.join('\n');
      })
      .join('\n\n');
    return [
      '# 开场钩子',
      '',
      data.hook,
      '',
      sections,
      '',
      '# 结尾行动号召',
      '',
      data.cta,
      '',
      `> 预估时长：约 ${data.estimatedMinutes} 分钟`,
    ].join('\n');
  }

  if (kind === 'shot-list') {
    const data = payload as {
      shots: Array<{
        index: number;
        time: string;
        shot: string;
        visual: string;
        broll: string;
        onScreenText: string;
        durationSec: number;
      }>;
    };
    const header = '| # | 时间 | 景别 | 画面 | B-roll | 上屏字幕 | 秒 |\n|---|---|---|---|---|---|---|';
    const rows = data.shots.map(
      (shot) =>
        `| ${shot.index} | ${shot.time} | ${shot.shot} | ${shot.visual} | ${shot.broll} | ${shot.onScreenText} | ${shot.durationSec} |`,
    );
    return ['## 分镜表', '', header, ...rows].join('\n');
  }

  if (kind === 'review-report') {
    const data = payload as {
      summary: string;
      findings: Array<{ title: string; evidence: string; action: string }>;
      nextTopics: string[];
      score: number;
    };
    const findings = data.findings
      .map(
        (finding, index) =>
          `${index + 1}. **${finding.title}**\n   - 证据：${finding.evidence}\n   - 动作：${finding.action}`,
      )
      .join('\n');
    const topics = data.nextTopics.map((topic) => `- ${topic}`).join('\n');
    return [
      `## 综合评分：${data.score}`,
      '',
      data.summary,
      '',
      '## 归因结论',
      '',
      findings,
      '',
      '## 下一期方向',
      '',
      topics,
    ].join('\n');
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
