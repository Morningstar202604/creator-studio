import { describe, expect, it } from 'vitest';
import {
  PublishPackSchema,
  ResearchNotesSchema,
  TopicCardsSchema,
  extractJson,
  parseByKind,
} from '../src/index.js';

const validCard = {
  title: 'AI 正在杀死初级岗位吗',
  angle: '从招聘数据切入，讲结构性变化',
  scores: { demand: 82, competition: 45, differentiation: 71, speakability: 76 },
  composite: 76,
  rationale: '近 7 天搜索上升，但头部内容少',
  risks: ['数据来源较旧'],
};

describe('R1 topic card schema', () => {
  it('accepts a valid card set', () => {
    expect(TopicCardsSchema.parse({ cards: [validCard] }).cards).toHaveLength(1);
  });

  it('rejects a card missing scores', () => {
    const broken = { cards: [{ title: 'x', angle: 'y', composite: 50, rationale: 'z', risks: [] }] };
    expect(() => TopicCardsSchema.parse(broken)).toThrow();
  });

  it('rejects an out-of-range score', () => {
    const broken = {
      cards: [{ ...validCard, scores: { ...validCard.scores, demand: 140 } }],
    };
    expect(() => TopicCardsSchema.parse(broken)).toThrow();
  });

  it('rejects a non-integer score', () => {
    const broken = {
      cards: [{ ...validCard, scores: { ...validCard.scores, demand: 82.5 } }],
    };
    expect(() => TopicCardsSchema.parse(broken)).toThrow();
  });

  it('rejects an empty card list', () => {
    expect(() => TopicCardsSchema.parse({ cards: [] })).toThrow();
  });
});

describe('R1 research and pack schemas', () => {
  it('accepts research notes with confidence levels', () => {
    const value = {
      notes: [{ claim: '校招名额下降', source: 'example.com', confidence: 'medium', note: '二手来源' }],
      gaps: ['缺少官方统计'],
    };
    expect(ResearchNotesSchema.parse(value).notes).toHaveLength(1);
  });

  it('rejects an unknown confidence', () => {
    expect(() =>
      ResearchNotesSchema.parse({
        notes: [{ claim: 'x', source: 'y', confidence: 'certain', note: '' }],
        gaps: [],
      }),
    ).toThrow();
  });

  it('accepts a publish pack', () => {
    const value = {
      titles: [
        { title: '标题一', score: 92, reason: '信息密度高' },
        { title: '标题二', score: 88, reason: '有反差' },
        { title: '标题三', score: 84, reason: '具体' },
      ],
      description: '简介正文',
      tags: ['AI', '职场'],
      chapters: [{ time: '00:00', label: '开场' }],
      coverBrief: '人物 + 屏幕对比',
      compliance: [],
    };
    expect(PublishPackSchema.parse(value).titles).toHaveLength(3);
  });

  it('rejects a pack with too few titles', () => {
    expect(() =>
      PublishPackSchema.parse({
        titles: [{ title: 'a', score: 1, reason: 'b' }],
        description: 'd',
        tags: ['t'],
        chapters: [],
        coverBrief: 'c',
        compliance: [],
      }),
    ).toThrow();
  });
});

describe('R2 JSON extraction', () => {
  it('parses a bare JSON object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips a json code fence', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('strips a fence without a language tag', () => {
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('ignores prose around the object', () => {
    expect(extractJson('好的，结果如下：\n{"a":1}\n希望有帮助')).toEqual({ a: 1 });
  });

  it('throws when there is no object', () => {
    expect(() => extractJson('没有 JSON')).toThrowError(/NO_JSON_OBJECT/);
  });

  it('throws on malformed json inside the braces', () => {
    expect(() => extractJson('{"a":}')).toThrow();
  });
});

describe('parseByKind dispatch', () => {
  it('routes by kind', () => {
    expect(() => parseByKind('topic-card', { cards: [validCard] })).not.toThrow();
    expect(() => parseByKind('research-notes', { notes: [], gaps: [] })).toThrow();
  });
});
