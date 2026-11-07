/**
 * Seeds a clean, presentable demo dataset for screenshots.
 *
 * Deliberately hand-written: showcase data must read like a real creator's
 * workspace, not like test fixtures. Every project here is one a person would
 * plausibly have, and each stops at a different stage so the project list shows
 * the whole pipeline rather than six copies of the same state.
 *
 * Usage: node scripts/seed-demo.mjs [baseUrl]
 */

const B = process.argv[2] || process.env.DEMO_BASE || 'http://127.0.0.1:7920';

const j = async (method, path, body) => {
  const res = await fetch(B + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (res.status >= 400) {
    console.error('FAIL', method, path, res.status, JSON.stringify(data).slice(0, 240));
  }
  return { status: res.status, data };
};

await j('POST', '/v1/onboarding/complete', {});

// ---------------------------------------------------------------- video
const video = (
  await j('POST', '/v1/projects', {
    title: '为什么你的选题没人看',
    scenarioId: 'video',
    platform: 'bilibili',
    description: '从平台推荐机制反推选题方法，拆 50 条爆款做归因',
  })
).data.project;

for (const [kind, context] of [
  ['topic-card', '选题方法论：为什么认真准备的选题没人点'],
  ['research-notes', '平台推荐机制与完播率的关系'],
  ['script', '拆解 50 条爆款后总结的选题评分表'],
  ['shot-list', '60 秒竖屏口播加屏幕录制'],
  ['publish-pack', 'B 站知识区投稿'],
]) {
  await j('POST', `/v1/projects/${video.id}/generate`, { kind, context });
}

await j('POST', `/v1/projects/${video.id}/metrics`, {
  views: 24800,
  likes: 1860,
  comments: 214,
  shares: 96,
  retentionPercent: 43,
  revenueCny: 0,
});
await j('POST', `/v1/projects/${video.id}/metrics`, {
  views: 31200,
  likes: 2410,
  comments: 289,
  shares: 128,
  retentionPercent: 47,
  revenueCny: 0,
});
await j('POST', `/v1/projects/${video.id}/review`, {});
console.log('video      ', video.id);

// ---------------------------------------------------------------- novel
const novel = (
  await j('POST', '/v1/projects', {
    title: '雾港纪事',
    scenarioId: 'novel',
    platform: 'generic',
    description: '一部关于归乡与秘密的长篇小说，双视角叙事',
  })
).data.project;

const novelCards = [
  { type: 'character', title: '林砚', fields: { name: '林砚', role: '主角', goal: '查清父亲失踪的真相', fear: '再次被抛弃', secret: '他见过父亲最后一面', voice: '短句，反问多', status: '登场', first_seen: '第 1 章' } },
  { type: 'character', title: '周望', fields: { name: '周望', role: '盟友', goal: '守住雾港的老灯塔', fear: '被时代淘汰', secret: '灯塔是他亲手关的', voice: '话少，爱用比喻', status: '登场', first_seen: '第 2 章' } },
  { type: 'character', title: '陈叙', fields: { name: '陈叙', role: '反派', goal: '把港口卖给开发商', fear: '旧账被翻出来', voice: '客气，永远在笑', status: '登场' } },
  { type: 'chapter', title: '第一章 雾从海上来', fields: { title: '第一章 雾从海上来', number: '1', status: '定稿', word_target: '3200', pov: '林砚', summary: '林砚回到雾港，码头空了', hook: '父亲的信压在门垫下' } },
  { type: 'chapter', title: '第二章 灯塔不亮', fields: { title: '第二章 灯塔不亮', number: '2', status: '定稿', word_target: '3000', pov: '林砚', summary: '灯塔停了三夜，没人上报', hook: '周望说灯塔是他关的' } },
  { type: 'chapter', title: '第三章 旧账本', fields: { title: '第三章 旧账本', number: '3', status: '修订中', word_target: '2800', pov: '周望', summary: '账本里多出一个陌生名字', hook: '那个名字是林砚的母亲' } },
  { type: 'chapter', title: '第四章 潮退之后', fields: { title: '第四章 潮退之后', number: '4', status: '草稿', word_target: '3000', pov: '林砚', summary: '', hook: '' } },
  { type: 'chapter', title: '第五章 空箱', fields: { title: '第五章 空箱', number: '5', status: '待写', word_target: '3200', pov: '林砚', summary: '', hook: '' } },
  { type: 'location', title: '雾港码头', fields: { name: '雾港码头', region: '东岸', atmosphere: '潮气、铁锈味、凌晨五点的雾' } },
  { type: 'location', title: '旧灯塔', fields: { name: '旧灯塔', region: '北岬', atmosphere: '盐霜、霉味、缓慢旋转的镜片' } },
  { type: 'foreshadow', title: '铜钥匙', fields: { clue: '铜钥匙', planted_at: '第 1 章', payoff_at: '第 3 章', status: '已回收' } },
  { type: 'foreshadow', title: '停摆的灯塔', fields: { clue: '停摆的灯塔', planted_at: '第 2 章', payoff_at: '', status: '已埋' } },
  { type: 'foreshadow', title: '账本上的陌生名字', fields: { clue: '账本上的陌生名字', planted_at: '第 3 章', payoff_at: '', status: '已埋' } },
];

const cardId = {};
const cardRevision = {};
for (const card of novelCards) {
  const result = await j('POST', `/v1/projects/${novel.id}/entities`, card);
  if (result.status === 201) {
    cardId[card.title] = result.data.card.id;
    cardRevision[card.title] = result.data.card.revision;
  }
}

const link = (from, to, relationType) =>
  j('POST', `/v1/projects/${novel.id}/entities/${cardId[from]}/links`, {
    toCardId: cardId[to],
    relationType,
  });

await link('林砚', '第一章 雾从海上来', 'appears-in');
await link('林砚', '第二章 灯塔不亮', 'appears-in');
await link('林砚', '第三章 旧账本', 'appears-in');
await link('周望', '第二章 灯塔不亮', 'appears-in');
await link('周望', '第三章 旧账本', 'appears-in');
await link('陈叙', '第三章 旧账本', 'appears-in');
await link('铜钥匙', '第一章 雾从海上来', 'plants');
await link('铜钥匙', '第三章 旧账本', 'pays-off');
await link('停摆的灯塔', '第二章 灯塔不亮', 'plants');
await link('账本上的陌生名字', '第三章 旧账本', 'plants');
await link('第一章 雾从海上来', '雾港码头', 'located-in');
await link('第二章 灯塔不亮', '旧灯塔', 'located-in');

// Card writes carry the revision the seed run read at creation time (0.19 API
// contract): a save without it is rejected rather than silently overwriting a
// concurrent edit.
const patchCard = async (title, fields) => {
  await j('PATCH', `/v1/projects/${novel.id}/entities/${cardId[title]}`, {
    ...fields,
    expectedRevision: cardRevision[title],
  });
};

await patchCard('第一章 雾从海上来', {
  body: '雾从海上来的时候，林砚正站在码头上。\n\n他回来了，带着一只空箱子。',
});
await patchCard('第二章 灯塔不亮', {
  body: '灯塔灭了三夜，周望没跟任何人提。\n\n第四夜，他提着灯油上了塔。',
});
await patchCard('第三章 旧账本', {
  body: '账本摊在桌上，第三页多了一个名字。',
});

for (const kind of ['topic-card', 'research-notes', 'outline']) {
  await j('POST', `/v1/projects/${novel.id}/generate`, { kind, context: '雾港纪事：归乡与秘密' });
}
console.log('novel      ', novel.id);

// ---------------------------------------------------------------- podcast
const podcast = (
  await j('POST', '/v1/projects', {
    title: 'EP12 一个人做播客的第一年',
    scenarioId: 'podcast',
    platform: 'generic',
    description: '独白节目：把一年的数据全部公开',
  })
).data.project;

await j('POST', `/v1/projects/${podcast.id}/entities`, {
  type: 'guest',
  title: '林漾',
  fields: { name: '林漾', role: '独立播客主', episode: 'EP12', stance: '坚持周更不如坚持做完', followups: '他为什么放弃周更' },
});
await j('POST', `/v1/projects/${podcast.id}/entities`, {
  type: 'question',
  title: '你什么时候想放弃',
  fields: { question: '你什么时候最想放弃？', theme: '坚持' },
});
for (const kind of ['topic-card', 'outline']) {
  await j('POST', `/v1/projects/${podcast.id}/generate`, { kind, context: '一个人做播客的第一年' });
}
console.log('podcast    ', podcast.id);

// ---------------------------------------------------------------- shorts
const shorts = (
  await j('POST', '/v1/projects', {
    title: '三个选题错误',
    scenarioId: 'shorts',
    platform: 'xiaohongshu',
    description: '60 秒竖屏：选题的三个致命错误',
  })
).data.project;

for (const shot of [
  { name: '特写 · 手指划过屏幕', duration: '3', status: '已剪', visual: '手机屏幕快速滑动', on_screen: '三秒定生死' },
  { name: '中景 · 主持人正面', duration: '8', status: '已剪', visual: '正对镜头', on_screen: '第一个错误：追热点' },
  { name: '特写 · 评分表', duration: '12', status: '已拍', visual: '表格特写', on_screen: '需求 竞争 差异' },
  { name: '全景 · 工作台', duration: '6', status: '待拍', visual: '俯拍桌面', on_screen: '把这套表存下来' },
]) {
  await j('POST', `/v1/projects/${shorts.id}/entities`, { type: 'shot', title: shot.name, fields: shot });
}
for (const kind of ['topic-card', 'script']) {
  await j('POST', `/v1/projects/${shorts.id}/generate`, { kind, context: '三个选题错误' });
}
console.log('shorts     ', shorts.id);

// ---------------------------------------------------------------- course
const course = (
  await j('POST', '/v1/projects', {
    title: '选题方法四讲',
    scenarioId: 'course',
    platform: 'generic',
    description: '给内容新人的四节课，每节一个可交付成果',
  })
).data.project;

for (const lesson of [
  { title: '第一讲 需求从哪里看', module: '基础', duration: '30', status: '已完成', objective: '能从三个渠道判断需求真伪' },
  { title: '第二讲 竞争怎么量化', module: '基础', duration: '35', status: '进行中', objective: '能算出目标选题的竞争分' },
  { title: '第三讲 差异化从哪来', module: '进阶', duration: '40', status: '未开始', objective: '能写出三条差异化角度' },
]) {
  await j('POST', `/v1/projects/${course.id}/entities`, { type: 'lesson', title: lesson.title, fields: lesson });
}
await j('POST', `/v1/projects/${course.id}/entities`, {
  type: 'exercise',
  title: '给三个选题打分',
  fields: { prompt: '用评分表给你手上的三个选题打分，并说明哪一项最低', difficulty: '入门', checks: '需求 竞争 差异 可讲性' },
});
for (const kind of ['topic-card', 'outline']) {
  await j('POST', `/v1/projects/${course.id}/generate`, { kind, context: '选题方法四讲' });
}
console.log('course     ', course.id);

// ---------------------------------------------------------------- copywriting
const copy = (
  await j('POST', '/v1/projects', {
    title: '转行做内容的第一年',
    scenarioId: 'copywriting',
    platform: 'xiaohongshu',
    description: '公众号长文与小红书短版，同一份素材两种写法',
  })
).data.project;

await j('POST', `/v1/projects/${copy.id}/entities`, {
  type: 'persona',
  title: '转行中的 28 岁运营',
  fields: { name: '转行中的 28 岁运营', stage: '已尝试', pain: '做了三个月没有数据', reject: '任何坚持就会成功的话' },
});
await j('POST', `/v1/projects/${copy.id}/entities`, {
  type: 'asset',
  title: '2026 春季招聘数据图',
  fields: { name: '2026 春季招聘数据图', kind: '数据', source: 'https://example.com/jobs-2026', note: '放在第二段，标注来源' },
});
for (const kind of ['topic-card', 'script']) {
  await j('POST', `/v1/projects/${copy.id}/generate`, { kind, context: '转行做内容的第一年' });
}
console.log('copywriting', copy.id);

// ---------------------------------------------------------------- style profiles
await j('POST', '/v1/styles', {
  name: '冷硬叙事',
  tone: '克制，不煽情',
  audience: '成年读者',
  bannedWords: ['绝绝子', 'yyds'],
  notes: '少用感叹号',
});
await j('POST', '/v1/styles', {
  name: '知识区口播',
  tone: '直接，先给结论',
  audience: '内容创作者',
  bannedWords: ['家人们'],
  notes: '先结论后解释',
});

// ---------------------------------------------------------------- memory index
await j('POST', '/v1/memory/reindex', {});
console.log('SEED DONE');
