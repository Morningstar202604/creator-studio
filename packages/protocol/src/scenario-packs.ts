import type { ScenarioPack, ScenarioPackInput } from './scenario.js';

/**
 * Built-in scenario packs. These are data, not code paths: the video pack keeps
 * the exact stage keys the app shipped before so existing projects keep working,
 * and the other three demonstrate that the engine is not video-shaped.
 *
 * A stage's `view` decides which generic view opens it — `generate` (artifact
 * generation), `entities` (card board for `entityType`), `publish`, `review`.
 * Packs compose existing views; adding a scenario never adds code.
 */

export const VIDEO_PACK: ScenarioPackInput = {
  id: 'video',
  name: '中长视频',
  description: '选题到发布包的七段流水线，适合 B 站 / YouTube 知识类视频',
  icon: '🎬',
  builtin: true,
  defaultPlatform: 'bilibili',
  stages: [
    { key: 'topic', label: '选题', view: 'generate', hint: '三张选题卡，按需求/竞争/差异/可讲性评分', produces: ['topic-card'], promptHint: '', required: true },
    { key: 'research', label: '资料', view: 'generate', hint: '可核查的事实要点与资料缺口', produces: ['research-notes'], promptHint: '', required: true },
    { key: 'script', label: '脚本', view: 'generate', hint: '分节口播稿，写完即改', produces: ['script'], promptHint: '', required: true },
    { key: 'shotlist', label: '分镜', view: 'generate', hint: '景别、画面、B-roll、上屏字幕与时长', produces: ['shot-list'], promptHint: '', required: false },
    { key: 'package', label: '包装', view: 'generate', hint: '标题候选、简介、标签、封面文案', produces: ['publish-pack'], promptHint: '', required: true },
    { key: 'published', label: '发布', view: 'publish', hint: '检查表全绿后导出发布包', produces: [], promptHint: '', required: false },
    { key: 'review', label: '复盘', view: 'review', hint: '回填数据后做归因', produces: ['review-report'], promptHint: '', required: false },
  ],
  entityTypes: [],
};

export const NOVEL_PACK: ScenarioPackInput = {
  id: 'novel',
  name: '长篇小说',
  description: '世界观、角色、大纲、章节、修订到投稿包，适合连载与单本长篇',
  icon: '📖',
  builtin: true,
  defaultPlatform: 'generic',
  stages: [
    {
      key: 'premise',
      label: '设定',
      view: 'generate',
      hint: '一句话卖点、题材、读者预期与差异化',
      produces: ['topic-card'],
      promptHint: '这是一部小说。给出 3 个可写的故事前提，每个包含一句话卖点、核心冲突、与同类作品的差异。',
      required: true,
    },
    {
      key: 'world',
      label: '世界观',
      view: 'generate',
      hint: '世界规则、时代背景、关键地点与不可违背的设定',
      produces: ['research-notes'],
      promptHint: '整理世界观资料卡：世界规则、时代背景、关键地点。每条都要能被后续章节引用，冲突时以这里为准。',
      required: true,
    },
    {
      key: 'outline',
      label: '大纲',
      view: 'generate',
      hint: '三幕结构、章节节拍、关键转折与伏笔',
      produces: ['outline'],
      promptHint: '输出分卷分章大纲：每章一句核心事件、一个转折或伏笔，保持主线因果链完整。',
      required: true,
    },
    {
      key: 'chapter',
      label: '章节',
      view: 'document',
      entityType: 'chapter',
      board: { groupBy: 'status', order: ['待写', '草稿', '修订中', '定稿'] },
      document: { orderField: 'number', fileStem: 'novel' },
      hint: '逐章正文；写作台直接写，看板看进度',
      produces: ['chapter'],
      promptHint: '写一章正文。保持视角一致、对话推动情节、不要用总结代替场景。',
      required: true,
    },
    {
      key: 'revision',
      label: '修订',
      view: 'review',
      hint: '连续性检查、角色一致性、节奏与删减',
      produces: ['review-report'],
      promptHint: '做修订检查：列出设定冲突、角色行为不一致、节奏拖沓处，每条给出具体章节位置与修改建议。',
      required: false,
    },
    {
      key: 'published',
      label: '投稿',
      view: 'publish',
      hint: '生成投稿包与简介',
      produces: ['publish-pack'],
      promptHint: '',
      required: false,
    },
  ],
  relationTypes: [
    { key: 'appears-in', label: '出现在', inverse: '出场于', fromTypes: ['character'], toTypes: ['chapter'], },
    { key: 'plants', label: '埋于', inverse: '埋有伏笔', fromTypes: ['foreshadow'], toTypes: ['chapter'], },
    { key: 'pays-off', label: '回收于', inverse: '回收伏笔', fromTypes: ['foreshadow'], toTypes: ['chapter'], },
    { key: 'located-in', label: '发生在', inverse: '发生地', fromTypes: ['chapter'], toTypes: ['location'], },
  ],
  entityTypes: [
    {
      key: 'character',
      label: '角色',
      labelPlural: '角色卡',
      hint: '每个重要角色一张卡：他要什么、怕什么、藏着什么',
      icon: '👤',
      titleField: 'name',
      summaryFields: ['role', 'status'],
      fields: [
        { key: 'name', label: '姓名', type: 'text', required: true, options: [], placeholder: '例如：林砚', wide: false },
        { key: 'role', label: '叙事角色', type: 'select', required: true, options: ['主角', '反派', '导师', '盟友', '对手', '功能性配角'], placeholder: '', wide: false },
        { key: 'goal', label: '想要什么', type: 'longtext', required: true, options: [], placeholder: '具体到可执行的目标，不要写"想变强"', wide: true },
        { key: 'fear', label: '害怕什么', type: 'longtext', required: false, options: [], placeholder: '恐惧决定他在压力下怎么选', wide: true },
        { key: 'secret', label: '秘密', type: 'longtext', required: false, options: [], placeholder: '读者什么时候知道？', wide: true },
        { key: 'voice', label: '说话方式', type: 'text', required: false, options: [], placeholder: '例如：短句、反问多、不说软话', wide: false },
        { key: 'status', label: '状态', type: 'select', required: false, options: ['登场', '退场', '死亡', '未登场'], placeholder: '', wide: false },
        { key: 'first_seen', label: '首次出场', type: 'text', required: false, options: [], placeholder: '第几章', wide: false },
      ],
    },
    {
      key: 'chapter',
      label: '章节',
      labelPlural: '章节卡',
      hint: '一章一张卡：状态、字数、梗概与钩子，用来盯进度',
      icon: '📄',
      titleField: 'title',
      summaryFields: ['status', 'word_target'],
      fields: [
        { key: 'title', label: '章节标题', type: 'text', required: true, options: [], placeholder: '例如：第一章 雾从海上来', wide: false },
        { key: 'number', label: '章节序号', type: 'number', required: false, options: [], placeholder: '1', wide: false },
        { key: 'status', label: '状态', type: 'select', required: false, options: ['待写', '草稿', '修订中', '定稿'], placeholder: '', wide: false },
        { key: 'word_target', label: '目标字数', type: 'number', required: false, options: [], placeholder: '3000', wide: false },
        { key: 'pov', label: '视角人物', type: 'text', required: false, options: [], placeholder: '林砚', wide: false },
        { key: 'summary', label: '本章梗概', type: 'longtext', required: false, options: [], placeholder: '一句话：谁做了什么，付出什么代价', wide: true },
        { key: 'hook', label: '结尾钩子', type: 'longtext', required: false, options: [], placeholder: '这一章最后留了什么悬念', wide: true },
      ],
    },
    {
      key: 'location',
      label: '地点',
      labelPlural: '地点卡',
      hint: '场景发生的地方，写清氛围与可用细节',
      icon: '🗺️',
      titleField: 'name',
      summaryFields: ['region'],
      fields: [
        { key: 'name', label: '名称', type: 'text', required: true, options: [], placeholder: '', wide: false },
        { key: 'region', label: '所属区域', type: 'text', required: false, options: [], placeholder: '', wide: false },
        { key: 'atmosphere', label: '氛围', type: 'longtext', required: false, options: [], placeholder: '五感细节：看到什么、闻到什么', wide: true },
      ],
    },
    {
      key: 'foreshadow',
      label: '伏笔',
      labelPlural: '伏笔表',
      hint: '埋下的线索与回收章节，避免烂尾',
      icon: '🧵',
      titleField: 'clue',
      summaryFields: ['planted_at', 'payoff_at', 'status'],
      fields: [
        { key: 'clue', label: '线索', type: 'text', required: true, options: [], placeholder: '', wide: false },
        { key: 'planted_at', label: '埋设章节', type: 'text', required: true, options: [], placeholder: '第 3 章', wide: false },
        { key: 'payoff_at', label: '回收章节', type: 'text', required: false, options: [], placeholder: '第 19 章', wide: false },
        { key: 'status', label: '状态', type: 'select', required: false, options: ['已埋', '已回收', '已放弃'], placeholder: '', wide: false },
      ],
    },
  ],
};

export const PODCAST_PACK: ScenarioPackInput = {
  id: 'podcast',
  name: '播客 / 音频',
  description: '选题、提纲、逐字稿、剪辑单到节目说明，适合访谈与独白节目',
  icon: '🎙️',
  builtin: true,
  defaultPlatform: 'generic',
  stages: [
    { key: 'topic', label: '选题', view: 'generate', hint: '本期话题与嘉宾角度', produces: ['topic-card'], promptHint: '给出 3 个适合口播讨论的话题角度，标注争议点与听众收益。', required: true },
    { key: 'research', label: '资料', view: 'generate', hint: '背景资料与提问清单', produces: ['research-notes'], promptHint: '整理背景资料与给嘉宾的提问清单，问题要具体、有冲突。', required: true },
    { key: 'outline', label: '提纲', view: 'generate', hint: '节目结构与时间分配', produces: ['outline'], promptHint: '给出节目提纲：开场钩子、3-5 个段落、每段核心问题、收尾。', required: true },
    { key: 'script', label: '逐字稿', view: 'generate', hint: '开场白与串词，嘉宾部分留白', produces: ['script'], promptHint: '写开场白与段落串词，口语化，不要书面语。', required: false },
    { key: 'editlist', label: '剪辑单', view: 'generate', hint: '需要剪掉/补录的位置', produces: ['shot-list'], promptHint: '按时间码列出需要剪辑的位置与原因。', required: false },
    { key: 'published', label: '发布', view: 'publish', hint: '节目说明、时间轴与标签', produces: ['publish-pack'], promptHint: '', required: false },
  ],
  entityTypes: [
    {
      key: 'guest',
      label: '嘉宾',
      labelPlural: '嘉宾卡',
      hint: '嘉宾背景、观点与可追问的点',
      icon: '🧑',
      titleField: 'name',
      summaryFields: ['role', 'episode'],
      fields: [
        { key: 'name', label: '姓名', type: 'text', required: true, options: [], placeholder: '', wide: false },
        { key: 'role', label: '身份', type: 'text', required: false, options: [], placeholder: '例如：独立开发者', wide: false },
        { key: 'episode', label: '参与期数', type: 'text', required: false, options: [], placeholder: 'EP12', wide: false },
        { key: 'stance', label: '核心观点', type: 'longtext', required: false, options: [], placeholder: '他坚持什么？和主流有什么不同？', wide: true },
        { key: 'followups', label: '可追问', type: 'longtext', required: false, options: [], placeholder: '一页追问清单', wide: true },
      ],
    },
    {
      key: 'question',
      label: '问题',
      labelPlural: '问题库',
      hint: '可复用的问题，按主题归档',
      icon: '❓',
      titleField: 'question',
      summaryFields: ['theme'],
      fields: [
        { key: 'question', label: '问题', type: 'text', required: true, options: [], placeholder: '', wide: true },
        { key: 'theme', label: '主题', type: 'text', required: false, options: [], placeholder: '', wide: false },
      ],
    },
  ],
};

export const COURSE_PACK: ScenarioPackInput = {
  id: 'course',
  name: '课程 / 教程',
  description: '学习目标、模块、课时、练习与考核，适合系列课与训练营',
  icon: '🎓',
  builtin: true,
  defaultPlatform: 'generic',
  stages: [
    { key: 'goals', label: '目标', view: 'generate', hint: '学完能做到什么', produces: ['topic-card'], promptHint: '用可观测的行为描述学习目标，避免"了解""熟悉"。', required: true },
    { key: 'research', label: '调研', view: 'generate', hint: '先修知识、常见误区', produces: ['research-notes'], promptHint: '列出学习者的先修知识、典型误区与卡点。', required: true },
    { key: 'outline', label: '课程大纲', view: 'generate', hint: '模块拆分与课时分配', produces: ['outline'], promptHint: '拆成模块与课时，每课时一个可交付的小成果。', required: true },
    { key: 'lesson', label: '课时', view: 'entities', entityType: 'lesson', board: { groupBy: 'status', order: ['未开始', '进行中', '已完成'] }, hint: '讲义与示例', produces: ['chapter'], promptHint: '写一节课的讲义：目标、讲解、示例、练习。', required: true },
    { key: 'exercise', label: '练习', view: 'entities', entityType: 'exercise', hint: '题目与参考答案', produces: ['other'], promptHint: '设计练习题与参考答案，难度递增。', required: false },
    { key: 'published', label: '上线', view: 'publish', hint: '课程介绍页与大纲', produces: ['publish-pack'], promptHint: '', required: false },
  ],
  entityTypes: [
    {
      key: 'lesson',
      label: '课时',
      labelPlural: '课时卡',
      hint: '一节课一张卡：目标、时长、练习',
      icon: '📚',
      titleField: 'title',
      summaryFields: ['module', 'duration'],
      fields: [
        { key: 'title', label: '课时标题', type: 'text', required: true, options: [], placeholder: '', wide: false },
        { key: 'module', label: '所属模块', type: 'text', required: false, options: [], placeholder: '', wide: false },
        { key: 'duration', label: '时长（分钟）', type: 'number', required: false, options: [], placeholder: '30', wide: false },
        { key: 'status', label: '状态', type: 'select', required: false, options: ['未开始', '进行中', '已完成'], placeholder: '', wide: false },
        { key: 'objective', label: '学习目标', type: 'longtext', required: true, options: [], placeholder: '学完能做什么', wide: true },
      ],
    },
    {
      key: 'exercise',
      label: '练习',
      labelPlural: '练习卡',
      hint: '题目、难度与考察点',
      icon: '✏️',
      titleField: 'prompt',
      summaryFields: ['difficulty'],
      fields: [
        { key: 'prompt', label: '题目', type: 'longtext', required: true, options: [], placeholder: '', wide: true },
        { key: 'difficulty', label: '难度', type: 'select', required: false, options: ['入门', '进阶', '挑战'], placeholder: '', wide: false },
        { key: 'checks', label: '考察点', type: 'text', required: false, options: [], placeholder: '', wide: false },
      ],
    },
  ],
};


export const COPYWRITING_PACK: ScenarioPackInput = {
  id: 'copywriting',
  name: '文案 / 图文',
  description: '选题、受众、钩子、正文、多平台改写到发布包，适合公众号与小红书',
  icon: '✍️',
  builtin: true,
  defaultPlatform: 'xiaohongshu',
  stages: [
    { key: 'brief', label: '简报', view: 'generate', hint: '一句话目标、受众与卖点', produces: ['topic-card'], promptHint: '给出 3 个文案方向，每个包含目标读者、核心卖点、情绪钩子与差异化角度。', required: true },
    { key: 'research', label: '素材', view: 'generate', hint: '可引用的事实、数据与用户原话', produces: ['research-notes'], promptHint: '整理可引用的数据与用户原话，标注来源；不确定的标 low。', required: true },
    { key: 'draft', label: '初稿', view: 'generate', hint: '标题、开头、正文与结尾', produces: ['script'], promptHint: '写一版完整文案：标题 3 个、开头 3 句钩子、正文分段、结尾行动号召。', required: true },
    { key: 'rewrite', label: '多平台', view: 'generate', hint: '按平台改写长度与语气', produces: ['chapter'], promptHint: '把正文改写成公众号版（长）与小红书版（短、多 emoji 以外不用）。', required: false },
    { key: 'assets', label: '配图', view: 'entities', entityType: 'asset', hint: '配图与素材清单', produces: ['other'], promptHint: '', required: false },
    { key: 'published', label: '发布', view: 'publish', hint: '检查表与发布包', produces: ['publish-pack'], promptHint: '', required: false },
  ],
  relationTypes: [],
  entityTypes: [
    {
      key: 'asset',
      label: '素材',
      labelPlural: '素材卡',
      hint: '配图、引用、数据来源，一张卡一条',
      icon: '🖼️',
      titleField: 'name',
      summaryFields: ['kind', 'source'],
      fields: [
        { key: 'name', label: '名称', type: 'text', required: true, options: [], placeholder: '例如：2026 春季招聘数据图', wide: false },
        { key: 'kind', label: '类型', type: 'select', required: false, options: ['配图', '数据', '引用', '视频'], placeholder: '', wide: false },
        { key: 'source', label: '来源', type: 'url', required: false, options: [], placeholder: 'https://', wide: true },
        { key: 'note', label: '使用说明', type: 'longtext', required: false, options: [], placeholder: '放在哪一段、需不需要标注', wide: true },
      ],
    },
    {
      key: 'persona',
      label: '读者',
      labelPlural: '读者画像',
      hint: '写给谁：他们的处境、痛点与拒绝点',
      icon: '🎯',
      titleField: 'name',
      summaryFields: ['stage'],
      fields: [
        { key: 'name', label: '画像名称', type: 'text', required: true, options: [], placeholder: '例如：转行中的 28 岁运营', wide: false },
        { key: 'stage', label: '阶段', type: 'select', required: false, options: ['未接触', '观望', '已尝试', '已放弃'], placeholder: '', wide: false },
        { key: 'pain', label: '痛点', type: 'longtext', required: false, options: [], placeholder: '', wide: true },
        { key: 'reject', label: '拒绝点', type: 'longtext', required: false, options: [], placeholder: '什么话会让他们立刻划走', wide: true },
      ],
    },
  ],
};

export const SHORTS_PACK: ScenarioPackInput = {
  id: 'shorts',
  name: '短视频',
  description: '钩子、脚本、镜头、字幕到封面，适合 60 秒内竖屏内容',
  icon: '📱',
  builtin: true,
  defaultPlatform: 'xiaohongshu',
  stages: [
    { key: 'hook', label: '钩子', view: 'generate', hint: '前 3 秒必须抓住什么', produces: ['topic-card'], promptHint: '给出 5 个前 3 秒钩子，每个配一句画面描述；钩子必须具体、有冲突。', required: true },
    { key: 'script', label: '口播稿', view: 'generate', hint: '60 秒内的完整口播', produces: ['script'], promptHint: '写 60 秒口播稿，按 4 秒一句控制节奏，每句都要能被画面支撑。', required: true },
    { key: 'shots', label: '镜头', view: 'entities', entityType: 'shot', board: { groupBy: 'status', order: ['待拍', '已拍', '已剪'] }, hint: '逐镜头标注画面与字幕', produces: ['shot-list'], promptHint: '', required: true },
    { key: 'subtitle', label: '字幕', view: 'generate', hint: '按口播稿导出 SRT', produces: ['subtitle'], promptHint: '', required: false },
    { key: 'published', label: '发布', view: 'publish', hint: '封面与发布包', produces: ['publish-pack'], promptHint: '', required: false },
  ],
  relationTypes: [],
  entityTypes: [
    {
      key: 'shot',
      label: '镜头',
      labelPlural: '镜头卡',
      hint: '一个镜头一张卡：时长、画面、字幕',
      icon: '🎞️',
      titleField: 'name',
      summaryFields: ['duration', 'status'],
      fields: [
        { key: 'name', label: '镜头', type: 'text', required: true, options: [], placeholder: '例如：特写 · 手指划过屏幕', wide: false },
        { key: 'duration', label: '时长（秒）', type: 'number', required: false, options: [], placeholder: '3', wide: false },
        { key: 'status', label: '状态', type: 'select', required: false, options: ['待拍', '已拍', '已剪'], placeholder: '', wide: false },
        { key: 'visual', label: '画面', type: 'longtext', required: false, options: [], placeholder: '', wide: true },
        { key: 'on_screen', label: '上屏字幕', type: 'text', required: false, options: [], placeholder: '', wide: true },
      ],
    },
  ],
};

export const BUILTIN_PACKS: ScenarioPackInput[] = [
  VIDEO_PACK,
  NOVEL_PACK,
  PODCAST_PACK,
  COURSE_PACK,
  COPYWRITING_PACK,
  SHORTS_PACK,
];

export const DEFAULT_PACK_ID = 'video';

export function packById(packs: ScenarioPack[], id: string): ScenarioPack | undefined {
  return packs.find((pack) => pack.id === id);
}
