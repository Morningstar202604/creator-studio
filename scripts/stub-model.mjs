/**
 * A deterministic, dependency-free stand-in for an OpenAI-compatible provider.
 *
 * Why this exists: the real gateway streams SSE and validates every artifact
 * against a zod contract. Exercising that path needs a server that speaks the
 * same wire format and answers with a payload per artifact kind. Pointing at a
 * live vendor would make the check slow, non-deterministic and dependent on a
 * paid key, so this stub speaks the protocol and nothing else.
 *
 * It is a test double, not a model: every reply is hand-written. A passing run
 * proves the pipeline plumbing (request shape, SSE assembly, schema coercion,
 * retry-on-bad-output), not generation quality.
 *
 * Usage:
 *   node scripts/stub-model.mjs 7996
 *   MODEL_BASE_URL=http://127.0.0.1:7996/v1 MODEL_API_KEY=stub MODEL_NAME=stub \
 *     node apps/daemon/dist/main.js --port 7878
 */

import { createServer } from 'node:http';

const PORT = Number(process.argv[2] || 7996);

/**
 * Picks a payload by reading the *system* prompt only. The user message carries
 * upstream artifacts, so matching on it would select the wrong branch as soon as
 * an earlier stage mentions a word from a later one.
 */
const payloadFor = (system) => {
  if (system.includes('选题') || system.includes('选题卡')) {
    return {
      cards: [
        {
          title: '为什么你的选题没人看',
          angle: '从平台推荐机制反推选题',
          scores: { demand: 88, competition: 42, differentiation: 76, speakability: 90 },
          composite: 74,
          rationale: '需求高竞争低',
          risks: ['与近期热榜重叠'],
        },
        {
          title: 'AI 写作的三个陷阱',
          angle: '用真实稿子对比',
          scores: { demand: 72, competition: 65, differentiation: 68, speakability: 82 },
          composite: 72,
          rationale: '有对比就有说服力',
          risks: [],
        },
        {
          title: '一个人做播客的第一年',
          angle: '数据全公开',
          scores: { demand: 60, competition: 30, differentiation: 85, speakability: 75 },
          composite: 66,
          rationale: '差异化明显',
          risks: ['受众窄'],
        },
      ],
    };
  }

  if (system.includes('事实核查') || system.includes('资料员')) {
    return {
      notes: [
        { claim: '平台推荐算法以完播率为核心权重', source: '公开平台文档', confidence: 'high', note: '2026 年更新' },
        { claim: '知识类视频平均完播率高于娱乐类', source: '行业报告', confidence: 'medium', note: '样本有限' },
        { claim: '前 3 秒流失占总流失的 40%', source: '未核实', confidence: 'low', note: '缺少一手数据' },
      ],
      gaps: ['缺少竞品播放数据', '缺少平台官方口径'],
    };
  }

  if (system.includes('结构编辑') || system.includes('分幕大纲')) {
    return {
      logline: '一个回到故乡的儿子，发现父亲的失踪与整座港口有关。',
      acts: [
        {
          title: '第一幕 归乡',
          purpose: '建立雾港与主角的裂缝',
          beats: [
            { summary: '林砚回到雾港，码头空了一半', turn: '父亲的信', foreshadow: '铜钥匙' },
            { summary: '灯塔停了三夜，没人上报', turn: '周望承认是他关的', foreshadow: '停摆的灯塔' },
          ],
        },
        {
          title: '第二幕 账本',
          purpose: '把私人失踪变成集体秘密',
          beats: [
            { summary: '旧账本里多出一个陌生名字', turn: '名字是林砚的母亲', foreshadow: '账本上的陌生名字' },
            { summary: '陈叙上门要买港口', turn: '交易对象是父亲的旧合伙人', foreshadow: '' },
          ],
        },
        {
          title: '第三幕 潮退',
          purpose: '让主角在真相与留下之间选择',
          beats: [{ summary: '林砚打开父亲留下的空箱', turn: '箱子里只有一把钥匙', foreshadow: '' }],
        },
      ],
      estimatedChapters: 20,
    };
  }

  if (system.includes('分镜') || system.includes('shot')) {
    return {
      shots: [
        { index: 1, time: '00:00-00:03', shot: '特写', visual: '手指划过屏幕', broll: '', caption: '三秒定生死', duration: '3s' },
        { index: 2, time: '00:03-00:11', shot: '中景', visual: '主持人正面', broll: '代码编辑器特写', caption: '选题错在第一步', duration: '8s' },
        { index: 3, time: '00:11-00:17', shot: '全景', visual: '工作台', broll: '', caption: '方法比灵感重要', duration: '6s' },
      ],
      totalDuration: '60s',
      notes: '节奏偏快',
    };
  }

  // Matched on the wording the daemon's prompts actually use. Each branch names
  // the role in that prompt; matching on the artifact kind would fail, because the
  // prompt text does not contain it.
  if (system.includes('包装编辑') || system.includes('标题候选')) {
    return {
      titles: [
        { title: '选题没人看？先看这三点', score: 88, reason: '具体痛点' },
        { title: '我拆了 50 条爆款', score: 84, reason: '数字可信' },
        { title: '别再这样选题了', score: 80, reason: '否定式钩子' },
      ],
      description: '一份可执行的选题方法论，含评分表与避坑清单。',
      tags: ['选题', '内容创作', '增长'],
      chapters: [
        { time: '00:00', label: '开场' },
        { time: '01:20', label: '评分表' },
      ],
      coverBrief: '深色背景 + 大字号标题 + 左侧人物剪影',
      compliance: ['无夸大宣传', '无绝对化用语'],
    };
  }

  if (system.includes('复盘') || system.includes('归因')) {
    return {
      summary: '完播率偏低，但标题点击率健康，问题集中在开场。',
      findings: [
        { title: '前 15 秒流失', evidence: '完播率 42%，低于同类均值', action: '重写开场三句，砍掉铺垫' },
        { title: '节奏偏慢', evidence: '单镜头平均 8 秒', action: '切成 4 秒以内快切' },
      ],
      nextTopics: ['选题评分表怎么用', '爆款标题的三种结构'],
      score: 72,
    };
  }

  return {
    hook: '你选题的方向错了',
    sections: [
      { heading: '开场', content: '你选题的方向错了。', notes: '语速放慢' },
      { heading: '主体', content: '先看需求，再看竞争，最后看差异。', notes: '' },
      { heading: '收尾', content: '把这套表存下来，下次直接用。', notes: '' },
    ],
    cta: '评论区留下你的选题，我帮你打分。',
    estimatedMinutes: 8,
  };
};

const writeStream = (res, content) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const id = 'chatcmpl-stub';
  for (let i = 0; i < content.length; i += 64) {
    res.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'stub',
        choices: [{ index: 0, delta: { content: content.slice(i, i + 64) }, finish_reason: null }],
      })}\n\n`,
    );
  }
  res.write(
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'stub',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 120, completion_tokens: 260, total_tokens: 380 },
    })}\n\n`,
  );
  res.write('data: [DONE]\n\n');
  res.end();
};

createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    if (req.url?.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'stub', object: 'model' }] }));
      return;
    }

    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      // Answered below rather than thrown: one malformed request must not take
      // the server down for the rest of a run.
    }

    const messages = body.messages ?? [];
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    const content = JSON.stringify(payloadFor(system));

    if (body.stream) {
      writeStream(res, content);
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-stub',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'stub',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 120, completion_tokens: 260, total_tokens: 380 },
      }),
    );
  });
}).listen(PORT, () => console.log(`stub model on http://127.0.0.1:${PORT}/v1`));
