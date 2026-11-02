# 稿台 Creator Studio

**给一个人独立交付作品的本地优先创作台。**

视频、小说、播客、课程、长文——每一样都是一个项目，有既定的流水线、带版本的产物，
以及一份必须全绿才能导出的检查表。模型可以指向任何地方：本地端点或远程 API。
除非你主动配置远程模型，否则文件不会离开这台机器。

[快速开始](#快速开始) · [界面](#界面) · [它能做什么](#它能做什么) · [架构](#架构) · [验证](#验证) · [English](README.en.md)

![项目列表](docs/screenshots/01-projects-light.png)

---

## 它消除的问题

活是一件，工具是十五件。选题来自榜单，资料散在三十个标签页，脚本躺在文档里，
封面和标题在另一个软件里做，复盘靠回忆。

稿台把「项目」当作单位。项目知道自己进行到哪个阶段、有哪些产物、缺什么、
哪些已经批准。模型可以起草每个阶段，由你判断这个阶段是否完成。
导出是本地行为——不会替你把内容上传到任何平台。

---

## 界面

| 工作台：阶段、产物、检查表 | 脚本：就地写，就地改 |
|---|---|
| ![工作台](docs/screenshots/02-workspace-light.png) | ![脚本](docs/screenshots/05-script-light.png) |

| 选题：带评分的候选 | 复盘：趋势与完播 |
|---|---|
| ![选题](docs/screenshots/03-topic-light.png) | ![复盘](docs/screenshots/09-review-light.png) |

| 发布：检查表卡住导出 | 深色主题 |
|---|---|
| ![发布](docs/screenshots/08-publish-light.png) | ![深色](docs/screenshots/15-projects-dark.png) |

[`docs/screenshots/`](docs/screenshots/) 里有七十五张截图：每个页面的明暗两套、
1440 / 1100 / 900 三档宽度，以及命令面板、记忆检索、场景包、关系图、叙事时间轴与写作台。
演示录屏：[`docs/media/demo.mp4`](docs/media/demo.mp4)。

---

## 快速开始

三种跑法，选一种。

### 1. 桌面端

```bash
pnpm install
pnpm -r build
node scripts/install-daemon-deps.mjs
cd apps/desktop && pnpm tauri build
```

产物在 `apps/desktop/src-tauri/target/release/bundle/`。安装包里带了 daemon 文件，
但启动时仍要求系统 `PATH` 里有 Node.js ≥ 22。构建需要 Rust。

### 2. 浏览器 + 本地 daemon —— 开发时最方便

```bash
pnpm install && pnpm -r build
pnpm --filter @creator-studio/daemon start -- --port 7878
# 打开 http://127.0.0.1:7878/
```

daemon 自己托管构建好的前端。没有独立的前端服务，不需要配 CORS。

### 3. 只要 API 或 CLI

```bash
node apps/daemon/dist/main.js --port 7878
node apps/cli/dist/main.js health
```

### 接模型

界面里：**设置 → 模型** → Base URL、模型名、API Key → 保存 → 测试连接。
密钥写入 `<dataDir>/secrets.json`，权限 0600，不进 SQLite、不进日志、不进事件流。

或用环境变量：

```bash
export MODEL_BASE_URL="https://api.openai.com/v1"
export MODEL_API_KEY="sk-..."
export MODEL_NAME="gpt-4o-mini"
node apps/daemon/dist/main.js --port 7878
```

支持 OpenAI 兼容端点与 Anthropic 原生协议。用远程模型时，提示词与相关项目上下文
会发送到该服务商；用远程 embeddings 时，待索引文本也会发送。把未发表的稿子交给它之前，
先确认服务商的数据政策。

---

## 它能做什么

### 场景包：一套引擎，六种创作活

场景包是 JSON。它声明阶段、每个阶段用六个视图中的哪一个、卡片类型及其字段、
卡片之间的关系，以及检查表。引擎只读取场景包，从不执行包里的代码。

| 场景包 | 阶段 | 卡片 |
|---|---|---|
| 中长视频 | 选题 · 资料 · 脚本 · 分镜 · 包装 · 发布 · 复盘 | — |
| 长篇小说 | 设定 · 世界观 · 大纲 · 章节 · 修订 · 投稿 | 角色 · 章节 · 地点 · 伏笔 |
| 播客 | 选题 · 资料 · 提纲 · 逐字稿 · 剪辑单 · 发布 | 嘉宾 · 问题 |
| 课程 | 目标 · 调研 · 大纲 · 课时 · 练习 · 上线 | 课时 · 练习 |
| 文案 | 简报 · 素材 · 初稿 · 多平台 · 配图 · 发布 | 素材 · 读者 |
| 短视频 | 钩子 · 口播稿 · 镜头 · 字幕 · 发布 | 镜头 |

新增场景是一份 JSON，不是一次改代码。复制一个内置包，改阶段，导入。
遇到不认识的视图会连带支持列表一起拒绝，而不是等到运行时才炸。

### 六个视图

`generate`（模型出产物）· `entities`（卡片板，可按字段分组看板）·
`document`（单栏写作台）· `publish`（检查表卡住导出）· `review`（指标与归因）·
`board`（拖拽换列）。

### 写作台

声明了 `document` 的阶段会变成：章节栏、无干扰编辑器、实时字数、
本章目标进度环、全书进度、章节篇幅柱。900ms 自动保存，按章隔离，
切章不串稿。一键导出 Word（`.docx`）与 Markdown。

### 叙事工具

关系图把每张卡片渲染成网络，带类型着色与正反向关系词；点一个节点只看它的直接关系。
时间轴按序号把章节横排，伏笔从埋设章连到回收章，未回收的线红框标出，
旁边列出还欠哪几条。

### 流水线保证

| 关注点 | 行为 |
|---|---|
| 结构化输出 | 每类产物一份 zod 契约。模型输出先矫正（数字字符串、单值转数组、嵌套解包）再校验，失败带示例重试一次 |
| 审批 | 删除、写工作区外、执行命令必须人工批准。批准一次只用一次，批准后从中断处续跑 |
| 恢复 | 每步转录落盘。崩溃把在途 Run 标为 `INTERRUPTED`；批准后可续跑 |
| 工具权限 | 按工具 ×路径 glob 判定 `auto / ask / deny`，deny 优先于 ask 优先于 auto，无授权即拒绝 |
| 审计 | 每次工具调用记录目标、判定、耗时与结果，可通过 `GET /v1/audit` 导出 |
| 预算 | 按 Run 记录用量与花费；智能体运行支持硬性预算上限 |
| 溯源 | 给出参考链接就真抓原文（私网、内嵌凭据、非 http(s) 一律拒绝；robots 与体积有守门）。每条事实标注是否可核，不可核的降为 low，产物末尾附抓取记录与逐源 sha256 |
| 记忆 | 所有产物切片索引，检索混合 FTS5 子串与向量排序。默认离线特征哈希嵌入，可切到服务商的 `/embeddings` |
| 风格 | 可复用的语气 / 受众 / 禁用词档案，按项目挂载并注入每次生成。禁用词命中会在检查表标出 |

### 导出与复盘

发布包是一个 ZIP，只有当所有必需检查项全绿时才会生成。里面是每类产物的最新版、
一份 `README.md`，以及逐文件 sha256 的 `manifest.json`。导出会把项目推进到发布阶段。
不会向任何平台发送内容。

指标（播放、点赞、评论、完播、收益）手工回填，用 ECharts 画趋势与环比。
一键让模型做归因，报告成为带版本的产物，并把项目推进到复盘阶段。

### 各处细节

明 / 暗 / 跟随系统三套主题，每个颜色都是 token，每个 token 都做过对比度核算。
`Ctrl/Cmd + K` 命令面板。响应式下探到 900px。字幕可导出 SRT，
时间是按标点与文本长度估算的，必须按实际录音校准——界面在导出处就写明了这一点。

---

## 命令行

```bash
node apps/cli/dist/main.js health
node apps/cli/dist/main.js new "为什么 AI 正在改变初级岗位" --platform bilibili --tag AI
node apps/cli/dist/main.js pipeline <projectId> "AI 与初级岗位"
node apps/cli/dist/main.js publish <projectId>
```

完整列表见 [`docs/CLI.md`](docs/CLI.md)。CLI 与界面走同一套 HTTP API，
可以用 `--url` 指向远程 daemon。

---

## 架构

```
apps/
  desktop/   React 19 + Vite + Tauri 2（HashRouter，tauri:// 与 http:// 都能跑）
  daemon/    Fastify 5 —— 79 条路由、SSE、静态托管、调度器、密钥库
  cloud/     控制面：配对、隧道、配额、计费
  cli/       cs 命令，与界面同一套 API
packages/
  protocol/       实体 schema、不变量、产物契约、输出矫正
  tools/          路径沙箱（realpath、防符号链接）、授权、审批门、审计
  model-gateway/  OpenAI 与 Anthropic 适配器、SSE 解析、预算预检、退避、脱敏
  store-sqlite/   12 个迁移、SQLite 仓储
  agent-core/     Agent 循环、工具回灌、审批暂停与恢复、转录落盘
```

**设计规则：** 引擎拥有行为，视图是固定的六个，场景包是数据。
所以新增一种创作活不需要写代码，所以导入别人的场景包不会执行他的代码。

完整设计：[`ARCHITECTURE.md`](ARCHITECTURE.md)。HTTP 接口：[`docs/API.md`](docs/API.md)。
决策记录：[`docs/adr/`](docs/adr/)。

### 安全默认值

- daemon 只绑 `127.0.0.1`。CORS 只放行回环与 Tauri 伪源。
- 所有文件路径经 `resolveInsideWorkspace`，拒绝绝对路径、`..` 与符号链接逃逸。
- 渲染 Markdown 一律经 DOMPurify 消毒。模型输出视为不可信输入。
- API Key 存在 0600 的密钥文件里，不进数据库、不进日志。
- 云端提供设备配对与隧道，设备令牌可吊销、可轮换；端到端未打通的部分见「已知边界」。

---

## 验证

```bash
pnpm verify          # lint → build → typecheck → test → 离线冒烟 → 安全 → 对比度 → 版本一致
pnpm -r test         # 657 passed, 0 skipped
pnpm test:postgres   # 对真实数据库跑租户隔离（需显式开启）
```

改了界面还必须过真浏览器：

```bash
python scripts/shoot.py --base http://127.0.0.1:7878         # 26 页，布局断言
python scripts/click-sweep.py --base http://127.0.0.1:7878   # 每个控件点一遍 + 键盘巡检
```

每一层能证明什么、不能证明什么，写在 [`docs/VERIFICATION.md`](docs/VERIFICATION.md)。
当前状态（包括**未**验证项）写在 [`docs/STATUS.md`](docs/STATUS.md)。简版：

| 已验证 | 未验证 |
|---|---|
| 单元、契约与存储测试；离线模型契约；安全与对比度审计；浏览器布局与交互巡检；对本地模型桩的完整产物链路 | 真实厂商账号、macOS / Linux 安装包、自动更新往返、Postgres 压测、桌面到云端的执行链、任何人工省时数字 |

本仓库不发布任何省时数字，因为没有测过。

---

## 与同类项目的差别

Dify、n8n、langflow 是通用编排。OpenHands、cline 是 Agent 执行环境。
MoneyPrinterTurbo 是一键成片。稿台更窄：一个项目、一条由场景包定义的流水线、
本地优先存储、带审批的工具，以及让模型输出可复现的产物契约。

对十五个项目的逐机制对标，连同仍然存在的差距，在
[`docs/COMPETITIVE.md`](docs/COMPETITIVE.md)。

---

## 已知边界

写在这里，是为了让你在死线之前就知道。

1. **章节自动保存整章覆盖**：同一章两个客户端会互相覆盖，单人使用是安全的。见 §0.19。
2. **写作台是纯 Markdown**：没有批注、修订模式、目录域；复杂版式交给导出的 Word。
3. **默认记忆检索是词法的**：n-gram 特征哈希加子串匹配，不是神经语义模型。
   真正的语义检索需要支持 `/embeddings` 的服务商，界面在选择处就写明。
4. **字幕时间是估算的**：按标点与文本长度推算，不与音视频对齐，需按录音校准。
5. **云端未端到端验证**：配对、隧道、配额与租户隔离都在，Postgres 谓词也在 SQL 层，
   但桌面到云端的任务从未真正执行过。
6. **自动更新接线未验证**：签名与 updater 插件已就位，但一次真实的旧版→新版升级
   从未做过。Windows 安装包未做代码签名，SmartScreen 会提示。
7. **没有真人计时研究**：你在别处看到的这类工具的提效数字，都不来自这个项目。

---

## 开发

```bash
pnpm install
pnpm verify            # 全部门禁，CI 跑的就是它
pnpm -r test           # 657 passed, 0 skipped
```

两个脚本让完整链路在没有凭据的情况下也能复现：

```bash
node scripts/stub-model.mjs 7996            # 确定性的 OpenAI 兼容桩
node scripts/seed-demo.mjs http://127.0.0.1:7878   # 可展示的演示数据集
```

- 贡献指南：[`CONTRIBUTING.md`](CONTRIBUTING.md)
- 安全策略：[`SECURITY.md`](SECURITY.md)
- 行为准则：[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)
- 变更记录：[`CHANGELOG.md`](CHANGELOG.md)
- 发布流程：[`docs/RELEASING.md`](docs/RELEASING.md)
- 架构文档：[`ARCHITECTURE.md`](ARCHITECTURE.md)
- 接口清单：[`docs/API.md`](docs/API.md)
- 界面规格：[`docs/UI-SPEC.md`](docs/UI-SPEC.md) · 设计系统：[`docs/DESIGN-SYSTEM.md`](docs/DESIGN-SYSTEM.md)

## 用小说场景试试

```bash
# 建一个小说项目：阶段顺序由场景包决定
curl -s -X POST http://127.0.0.1:7878/v1/projects \
  -H 'content-type: application/json' \
  -d '{"title":"雾港纪事","scenarioId":"novel"}'

# 加一张角色卡：字段由 novel 场景包声明，缺必填项会被拒
curl -s -X POST http://127.0.0.1:7878/v1/projects/<projectId>/entities \
  -H 'content-type: application/json' \
  -d '{"type":"character","title":"林砚","fields":{"name":"林砚","role":"主角","goal":"查清父亲失踪的真相"}}'
```

界面里：项目卡上的场景徽标 → 工作台按场景显示阶段 → 「打开卡片」进入角色、章节、地点、伏笔。

## 自定义场景

```json
POST /v1/scenarios
{
  "id": "screenplay",
  "name": "剧本",
  "stages": [
    { "key": "logline", "label": "一句话", "view": "generate", "produces": ["topic-card"], "required": true },
    { "key": "scene",   "label": "场次",   "view": "entities", "entityType": "scene", "produces": ["chapter"], "required": true }
  ],
  "entityTypes": [
    { "key": "scene", "label": "场次", "titleField": "slug", "fields": [
      { "key": "slug", "label": "场次号", "type": "text", "required": true }
    ]}
  ]
}
```

`inherits` 让子包只写增量、不必重抄父包：同名阶段覆盖，深度上限 4，循环会被拒绝。

## 许可证

[MIT](LICENSE)
