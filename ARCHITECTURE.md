# 架构设计文档：Creator Studio Agent

> 本文档是本项目的唯一真理源（Single Source of Truth）。
> 任何影响架构、接口、数据模型、依赖或目录结构的代码变更，都必须同步更新本文档。
> 最后更新：2026-11-02 ｜ 文档版本：v0.17（质量门禁与运行时可靠性）

当前版本的实际状态、已验证项与已知缺陷见 [`docs/STATUS.md`](docs/STATUS.md)；
验证方法与实测记录见 [`docs/VERIFICATION.md`](docs/VERIFICATION.md)；
版本迭代计划见 [`docs/ROADMAP.md`](docs/ROADMAP.md)。

## 1. 概述与目标

- **项目定位**：面向个人创作者的本地优先 AI Agent 工作台，把「选题 → 调研 → 脚本 → 分镜 → 包装 → 发布包 → 复盘」做成一条可监督、可恢复、可追责的流水线。
- **核心问题**：创作者的工具是碎的（文档、表格、剪辑软件、聊天窗口互不相通），通用 AI 助手没有项目上下文、碰不到本地文件、每次从零开始。
- **质量属性优先级**：可信可控 > 可恢复性 > 执行能力 > 生成质量 > 性能 > 成本。
- **范围边界**：
  - In scope：项目管理、多 Agent 编排、本地工具执行、云端调度、模型接入、审阅与留痕、发布包导出。
  - Out of scope（第一版）：时间线剪辑、自动发布、素材下载、MCN 多账号矩阵、移动端。

### 1.1 两条正交的轴（本项目的核心设计前提）

用户提出的两个诉求必须被拆成两个独立维度，否则架构会纠缠：

| 维度 | 取值 | 说明 |
|---|---|---|
| **模型在哪** | 本地模型 / 云端 API | 只影响「推理算力」，不影响工具与文件 |
| **Agent 在哪执行** | 本地环境 / 云端服务器 | 只影响「工具与调度」，不影响模型选择 |

四种组合都必须成立：

| 组合 | 场景 | Agent 循环运行在 | 工具执行在 | 典型用户 |
|---|---|---|---|---|
| A. 本地执行 + API 模型 | 默认形态，未部署服务器 | 本机 daemon | 本机 | 绝大多数个人创作者 |
| B. 本地执行 + 本地模型 | 断网、隐私敏感、零成本 | 本机 daemon | 本机 | 高隐私需求 / 无网环境 |
| C. 云端执行 + API 模型 | 已部署，7x24 定时任务 | 云端 worker | 云端 + 经隧道回连本机 | 付费用户 |
| D. 云端执行 + 本地模型 | 少见，仅本地模型暴露公网时 | 云端 worker | 云端 + 隧道 | 自建模型的重度用户 |

结论：**模型层与执行层通过两个独立接口解耦**（`ModelProvider` 与 `ToolTransport`），上层 Agent 循环对四者无感知。

## 2. 约束

### 2.1 技术约束

- 桌面端必须能装在没有管理员权限的 Windows/macOS 机器上；安装包 < 120MB。
- 本地运行时必须能在无网络时完成「读文件、跑 ffmpeg、改文档」等基础任务。
- 云端不得直连用户本机端口（家庭宽带无公网 IP、有 NAT、有防火墙）。
- 模型供应商必须可插拔，不允许把业务逻辑写死在某一家 SDK 上。
- 单条视频的 AI 成本必须可预估、可封顶。
- 所有对外动作（发布、付费、删除）必须人工确认。

### 2.2 关键假设（需在实施前校验）

1. 目标用户主力系统为 Windows 10/11，macOS 次之，Linux 极少。
2. 用户能接受「安装一个桌面客户端」，但不接受「配置 Python 环境 / 命令行」。
3. 主流模型均提供 OpenAI 兼容接口，或可用适配器转换。
4. 用户素材目录结构不统一，必须允许用户手动指定工作区根目录。
5. 平台发布接口普遍不开放，产品只交付「发布包」。

## 3. 架构总览

### 3.1 系统上下文

```mermaid
graph TB
    U[创作者] -->|操作| Desktop[桌面客户端]
    Desktop --> LocalAgent[本地 Agent Daemon]
    LocalAgent --> FS[(本地工作区)]
    LocalAgent --> FFMPEG[ffmpeg / ffprobe]
    LocalAgent --> Browser[本地浏览器自动化]
    LocalAgent --> MCP[本地 MCP Servers]
    LocalAgent -->|HTTPS| ModelAPI[模型 API<br/>OpenAI/Anthropic/DeepSeek/...]
    LocalAgent -->|可选，出站长连接| Cloud[云端控制面]
    Cloud --> PG[(Postgres)]
    Cloud --> Redis[(Redis / 队列)]
    Cloud --> S3[(对象存储)]
    Cloud --> CloudBrowser[云端无头浏览器]
    Cloud -->|HTTPS| ModelAPI
    Web[公开网页/平台数据] --> Browser
    Web --> CloudBrowser
```

关键点：**本地 daemon 是唯一的本机执行者**。云端即使存在，也不能直接读写本地磁盘，只能通过 daemon 建立的出站隧道下发工具调用。

### 3.2 容器视图

```mermaid
graph LR
    subgraph 桌面端
        UI[Renderer<br/>React + TS]
        Core[Agent Core<br/>本地进程]
        Tools[Tool Host<br/>fs / shell / browser / media]
        DB[(SQLite)]
        UI <-->|IPC / JSON-RPC| Core
        Core --> Tools
        Core --> DB
    end

    subgraph 云端
        API[Control API<br/>Fastify]
        Worker[Run Worker<br/>Agent Core 同构]
        Sched[调度器]
        Q[(BullMQ)]
        PG[(Postgres + pgvector)]
        S3[(S3)]
        API --> PG
        API --> Q
        Q --> Worker
        Worker --> PG
        Worker --> S3
        Sched --> Q
    end

    Core <-.->|Agent Link<br/>WSS 出站| API
    Worker <-.->|Agent Link 反向调用| API
    API <-.->|隧道转发 ToolCall| Core
```

**同构核心**：`packages/agent-core` 在两处运行，代码完全相同。差异只在注入的 `ModelProvider`、`ToolTransport`、`Store` 实现。

### 3.3 运行模式

| 模式 | 触发条件 | Agent 循环 | 工具通道 | 数据 |
|---|---|---|---|---|
| `local` | 默认；未登录或未订阅 | 本地进程 | 进程内调用 | 全本地 SQLite |
| `hybrid` | 已登录 + 开启云增强 | 云端 worker | 隧道回连本地 daemon | 状态同步到 Postgres，素材留本地 |
| `cloud` | 关机后仍需执行的任务 | 云端 worker | 云端工具 + 可选隧道 | 云端为主 |

模式切换不改变项目数据结构，只改变 `Run.executionMode`。

## 4. 技术栈

| 层 | 选型 | 版本 | 理由 |
|---|---|---|---|
| 桌面壳 | Tauri 2 | 2.x | 体积小、内存低、Rust 侧可做进程守护；Electron 包体与内存代价过高 |
| 前端 | React + TypeScript + Vite | React 19 | 生态成熟，招聘与外包成本低 |
| UI | Tailwind CSS + shadcn/ui | 最新稳定 | 不手搓组件，速度快 |
| Agent Core | TypeScript（Node 22） | Node 22 LTS | 桌面与云端同构，一份代码两处跑 |
| 本地数据库 | SQLite（better-sqlite3）+ sqlite-vec | 最新稳定 | 零运维、支持向量检索 |
| 云端 API | Fastify | 5.x | 轻、快、插件生态足够 |
| 云端数据库 | Postgres 16 + pgvector | 16 | 关系 + 向量一体，避免多引一个向量库 |
| 队列 | BullMQ + Redis | 5.x | 延迟任务、重试、定时任务成熟 |
| 对象存储 | S3 兼容（R2/MinIO） | - | 产物与截图，便宜 |
| 媒体 | ffmpeg / ffprobe | 6.x | 事实标准 |
| 语音转写 | whisper.cpp（本地）/ 云端 ASR | - | 本地优先，云端兜底 |
| 浏览器自动化 | Playwright | 最新 | 本地与云端同一套 API |
| 模型接入 | 自研 `ModelProvider` + OpenAI 兼容协议 | - | 一家 SDK 不绑死 |
| 工具协议 | MCP（stdio + streamable HTTP） | 2025-06 规范 | 复用生态，不自造插件协议 |
| 可观测 | OpenTelemetry + 结构化日志 | - | 一次 Run 全链路可查 |
| 打包 | Tauri bundler + GitHub Actions | - | 三平台产物 |

不引入：Kubernetes、微服务拆分、Kafka、图数据库。单机 + 一个小云端足够支撑到数千用户。

## 5. 模块 / 目录结构

```
creator-studio/
├─ apps/
│  ├─ desktop/                 # Tauri 壳 + React UI
│  │  ├─ src/app/              # AppShell、路由、全局状态
│  │  ├─ src/pages/            # P0–P17 页面（见 docs/UI-SPEC.md §4）
│  │  ├─ src/components/       # 复用组件（见 docs/UI-SPEC.md §8）
│  │  ├─ src/features/         # 按领域分：projects/runs/approvals/settings
│  │  └─ src-tauri/            # Rust 侧：进程守护、单实例、自动更新
│  ├─ daemon/                  # 本地 Agent 运行时（Node）
│  │  ├─ src/main.ts           # 启动、配对、模式选择
│  │  ├─ src/ipc.ts            # 与 UI 的 JSON-RPC
│  │  └─ src/tunnel.ts         # Agent Link 客户端
│  └─ cloud/                   # 云端控制面
│     ├─ src/api/              # Fastify 路由
│     ├─ src/worker/           # Run Worker
│     ├─ src/scheduler/        # 定时任务
│     └─ src/tunnel/           # 隧道网关
├─ packages/
│  ├─ agent-core/              # Agent 循环、规划、上下文管理（同构核心）
│  ├─ protocol/                # 所有 zod schema 与 TS 类型（唯一契约源）
│  ├─ tools/                   # 工具实现：fs/shell/http/browser/media/doc
│  ├─ model-gateway/           # 供应商适配、路由、预算、缓存
│  ├─ store-sqlite/            # 本地 Store 实现
│  ├─ store-pg/                # 云端 Store 实现
│  └─ shared/                  # 日志、错误、ID、时间
├─ prompts/                    # 各 Agent 的提示词与评分 rubric
├─ docs/
│  ├─ PRODUCT-BRAINSTORM.md
│  ├─ UI-SPEC.md               # 界面、布局、交互与页面清单
│  ├─ DESIGN-SYSTEM.md         # 品牌、色彩 token、排版、组件视觉
│  ├─ COMPONENT-TREE.md        # 页面 DOM 层级、组件边界、数据依赖
│  └─ adr/                     # 架构决策记录
└─ scripts/                    # 开发、打包、迁移、冒烟
```

模块边界规则：

- `protocol` 不依赖任何其他包；其他包只能依赖它。
- `agent-core` 不直接 import 任何具体工具或数据库，只通过接口。
- `tools` 不感知 Agent，只接收 `ToolCall` 返回 `ToolResult`。
- UI 不直接调用工具，一律走 daemon 的 JSON-RPC。

### 5.1 前端结构（路由、状态、三栏布局）

界面细节见 `docs/UI-SPEC.md`，此处只固定架构约束。

**布局**：`AppShell` = 顶栏（项目/阶段/模式/模型/预算/设备）+ 左导航（220px，可收 56px）+ 主工作区 + 右检查器（320–420px，可折叠）。禁止页面自建全局导航。

**路由表**（与 UI-SPEC §4 一一对应）：

| 路由 | 页面 | 布局 |
|---|---|---|
| `/onboarding` | P0 首次引导 | 无 Shell，三步向导 |
| `/` | P1 项目列表 | Shell |
| `/p/:id` | P2 工作台概览 | Shell |
| `/p/:id/topic` | P3 选题 | Shell |
| `/p/:id/research` | P4 资料 | Shell，双栏 |
| `/p/:id/script` | P5 脚本 | Shell，主区编辑器占满 |
| `/p/:id/shotlist` | P6 分镜 | Shell |
| `/p/:id/package` | P7 包装 | Shell |
| `/p/:id/publish` | P8 发布 | Shell |
| `/p/:id/review` | P9 复盘 | Shell |
| `/runs` | P10 任务 | Shell |
| `/approvals` | P11 待办 | Shell |
| `/library` | P12 资料库 | Shell |
| `/automations` | P13 自动化 | Shell |
| `/settings/*` | P14–P17 设置 | Shell，左导航切子页 |

> Tauri 壳内使用 HashRouter（`#/p/:id/script`），路径语义与上表一致，仅多一层 `#`；WebView2 在 `file://` 下无法用 BrowserRouter。

**状态分层**：

```ts
// 服务端状态：TanStack Query，key 以资源为中心
['projects'] ['project', id] ['runs', filter] ['run', id] ['events', runId, afterSeq]
['approvals', status] ['artifacts', projectId] ['models'] ['grants', deviceId]

// 客户端状态：Zustand，只存 UI 偏好
{ sidebarCollapsed, inspectorOpen, theme, activeProjectId, commandPaletteOpen }

// 实时状态：daemon JSON-RPC 推送 → 写入 Query cache（不另建 store）
```

约束：

- Run 事件按 `seq` 增量合并，断线重连用 `after=lastSeq`，禁止全量刷新。
- 任何写操作走 mutation + 乐观更新 + 失败回滚，不直接改 cache。
- 页面不得直接读 SQLite；所有数据经 daemon IPC 或云端 API。
- 页面组件只做编排，业务逻辑放 `features/`，复用组件放 `components/`。

**视觉 token**：颜色、间距、圆角、字号集中在 `src/styles/tokens.css`，组件不写死值。


## 6. 核心数据模型

### 6.1 实体与字段（精确签名）

```ts
type Project = {
  id: string;              // uuid v7
  ownerId: string;
  title: string;
  platform: 'bilibili' | 'youtube' | 'xiaohongshu' | 'generic';
  stage: 'topic' | 'research' | 'script' | 'shotlist' | 'package' | 'published' | 'review';
  workspacePath: string | null;   // 本地工作区绝对路径，仅本地存
  styleProfileId: string | null;
  createdAt: string;       // ISO 8601
  updatedAt: string;
  deletedAt: string | null;
};

type StyleProfile = {
  id: string;
  userId: string;
  name: string;            // ≤60
  tone: string;            // ≤400
  audience: string;        // ≤200
  bannedWords: string[];   // ≤40，每项 ≤20
  notes: string;           // ≤600
  createdAt: string;
  updatedAt: string;
};

type Run = {
  id: string;
  projectId: string;
  parentRunId: string | null;
  agentId: AgentId;
  executionMode: 'local' | 'hybrid' | 'cloud';
  status: 'queued' | 'running' | 'waiting_approval' | 'paused' | 'succeeded' | 'failed' | 'cancelled';
  modelProfileId: string;
  budget: { maxTokens: number; maxCostCny: number; usedTokens: number; usedCostCny: number };
  inputRef: string | null;   // Artifact id
  outputRef: string | null;
  error: { code: string; message: string; retryable: boolean } | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
};

type Step = {
  id: string;
  runId: string;
  index: number;
  kind: 'model' | 'tool' | 'approval' | 'handoff';
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  toolName: string | null;
  toolArgs: unknown | null;
  resultRef: string | null;
  startedAt: string | null;
  endedAt: string | null;
};

type Artifact = {
  id: string;
  projectId: string;
  runId: string;
  kind: 'topic-card' | 'research-notes' | 'script' | 'shot-list' | 'subtitle' | 'publish-pack' | 'review-report' | 'image' | 'audio' | 'other';
  path: string;            // 项目内相对路径
  sha256: string;
  mime: string;
  size: number;
  visibility: 'local' | 'synced';   // local 表示永不上传
  createdAt: string;
};

type Approval = {
  id: string;
  runId: string;
  stepId: string;
  kind: 'publish' | 'purchase' | 'delete' | 'write-outside-workspace' | 'shell-exec' | 'send-message';
  payload: unknown;
  decision: 'pending' | 'approved' | 'rejected' | 'expired';
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
};

type Device = {
  id: string;
  userId: string;
  name: string;
  os: 'windows' | 'macos' | 'linux';
  publicKey: string;       // 设备公钥，用于隧道鉴权
  capabilities: ToolCapability[];
  lastSeenAt: string | null;
  revokedAt: string | null;
};

type ToolGrant = {
  id: string;
  deviceId: string;
  tool: string;            // 如 "fs.write"
  scope: string;           // 如 "workspace/**" 或 "*"
  mode: 'auto' | 'ask' | 'deny';
};

type ModelProfile = {
  id: string;
  userId: string;
  name: string;
  provider: 'openai' | 'anthropic' | 'gemini' | 'deepseek' | 'qwen' | 'ollama' | 'openai-compatible';
  baseUrl: string;
  model: string;
  apiKeyRef: string;       // 指向系统钥匙串的键名，绝不存明文
  contextWindow: number;
  priceInPerM: number;     // 元 / 百万 token
  priceOutPerM: number;
  isLocal: boolean;
};

type MemoryRecord = {
  id: string;
  projectId: string | null;   // null 表示跨项目的用户级记忆
  scope: 'user' | 'project';
  kind: 'style' | 'fact' | 'decision' | 'preference';
  content: string;
  embedding: number[] | null;
  sourceRef: string | null;
  createdAt: string;
};

type RunEvent = {
  id: string;
  runId: string;
  seq: number;              // 单调递增，用于断线续传
  type: 'step.started' | 'step.finished' | 'tool.called' | 'tool.result' | 'approval.requested' | 'budget.warning' | 'run.finished' | 'error';
  payload: unknown;
  ts: string;
};
```

### 6.2 关系

```mermaid
erDiagram
    PROJECT ||--o{ RUN : has
    PROJECT ||--o{ ARTIFACT : owns
    RUN ||--o{ STEP : contains
    RUN ||--o{ APPROVAL : requires
    USER ||--o{ DEVICE : registers
    DEVICE ||--o{ TOOL_GRANT : grants
    USER ||--o{ MODEL_PROFILE : configures
    PROJECT ||--o{ MEMORY_RECORD : remembers
    RUN ||--o{ RUN_EVENT : emits
```

### 6.3 运行时不变量

| # | 不变量 | 作用域 | 维护方 | 校验方式 |
|---|---|---|---|---|
| INV-1 | 一个 Run 任意时刻最多一个 `status='running'` 的 Step | Run 生命周期 | agent-core | 状态机断言 + 唯一索引 `(runId, status)` 部分索引 |
| INV-2 | `Artifact.sha256` 必须与落盘内容一致 | 产物写入 | tool-host | 写入后重算比对，不一致即失败 |
| INV-3 | `kind in (publish,purchase,delete)` 的 Approval 未 approved 时，对应工具不得执行 | 工具调用前 | tool-host | 执行前强制查 Approval |
| INV-4 | 云端进程不得直接打开本地路径；只能经 Device 隧道 | 云端全进程 | cloud/worker | 代码层禁止 fs 访问本地根；隧道外无路径入口 |
| INV-5 | API Key 明文不得出现在日志、RunEvent、Artifact、错误信息中 | 全系统 | model-gateway / logger | 日志脱敏中间件 + 启动自检 |
| INV-6 | `usedCostCny <= maxCostCny` 且 `usedTokens <= maxTokens`；触顶前必须暂停并请求批准 | 每次模型调用前 | agent-core | 调用前预算检查（fail-closed） |
| INV-7 | 同一 Project 同一时刻最多一个 `executionMode in (local,hybrid)` 的写型 Run | 项目级 | daemon / cloud | 项目锁表 + 启动时清理僵尸锁 |
| INV-8 | 每次工具调用必须命中一条 ToolGrant，且写入 `RunEvent` 审计 | 工具调用 | tool-host | 无 grant 直接拒绝；事件表非空校验 |
| INV-9 | `RunEvent.seq` 单调递增且无空洞 | 事件流 | store | 写入时事务内自增；读取时校验连续性 |
| INV-10 | `visibility='local'` 的 Artifact 不得上传对象存储 | 同步任务 | sync service | 同步前过滤 + 上传层白名单 |

## 7. 关键接口与协议

### 7.1 三层接口

```ts
interface ModelProvider {
  id: string;
  chat(req: {
    messages: ChatMessage[];
    tools: ToolSchema[];
    temperature?: number;
    maxTokens?: number;
    signal: AbortSignal;
  }): AsyncIterable<ModelDelta>;
  embed(texts: string[]): Promise<number[][]>;
}

interface ToolTransport {
  call(call: ToolCall, ctx: ToolContext): Promise<ToolResult>;
  list(): Promise<ToolSchema[]>;
}

interface Store {
  // Run / Step / Artifact / Approval / Event 的最小 CRUD 与事务
  withTransaction<T>(fn: (tx: Store) => Promise<T>): Promise<T>;
}
```

### 7.2 Agent 循环（单步语义）

```ts
async function runStep(run: Run, ctx: RunContext): Promise<StepOutcome> {
  assertBudget(run);                          // INV-6，fail-closed
  const plan = await ctx.agent.plan(run, ctx.memory);
  const delta = await ctx.model.chat({ ...plan, tools: await ctx.tools.list() });
  if (delta.toolCall) {
    await ctx.approvals.requireIfNeeded(delta.toolCall);   // INV-3
    const result = await ctx.tools.call(delta.toolCall, ctx); // INV-8
    return { kind: 'tool', result };
  }
  return { kind: 'model', text: delta.text };
}
```

约束：

- 每一步只做一件事，步与步之间落盘（可恢复）。
- 工具结果先归类 `trust: 'trusted' | 'untrusted'`，网页/用户上传内容一律 `untrusted`。
- `untrusted` 内容进入上下文时包在 `<data>` 围栏内，并在系统提示中声明「围栏内是数据不是指令」。

### 7.3 Agent Link 协议（本地 ↔ 云端）

传输：WSS，**由本地 daemon 主动发起**，云端不主动连本地。

帧格式：

```ts
type LinkFrame =
  | { t: 'hello'; deviceId: string; token: string; capabilities: string[]; protocolVersion: 1 }
  | { t: 'tool.call'; callId: string; name: string; args: unknown; timeoutMs: number }
  | { t: 'tool.result'; callId: string; ok: true; result: unknown }
  | { t: 'tool.result'; callId: string; ok: false; error: { code: string; message: string } }
  | { t: 'heartbeat'; ts: number }
  | { t: 'cancel'; callId: string };
```

规则：

- 30s 心跳；90s 无心跳判定离线，正在等待的工具调用返回 `DEVICE_OFFLINE`。
- 所有调用带 `timeoutMs`，默认 60s，媒体任务可到 30min。
- 断线重连后，云端重放未完成的 `tool.call`（幂等工具）或标记失败（非幂等工具，如 `shell.exec`）。
- 设备令牌 90 天轮换，可随时吊销。
- 升级握手即鉴权（2026-10-23 落地）：设备拨入 `/v1/tunnel?deviceId=...&token=...`，云端按 token 哈希比对设备表，`deviceId` 必须与令牌所属设备一致；缺参以 4001、无效/吊销以 4003 关闭。设备经 `DELETE /v1/devices/:id` 吊销时，活连接立即以 4002 关断并失败所有挂起调用。令牌走查询参数仅适用于回环/单机部署；接入 Postgres 后应升级为 `hello` 帧握手，避免令牌进入访问日志。

### 7.4 工具清单（第一版）

| 工具 | 作用 | 风险 | 默认授权 |
|---|---|---|---|
| `fs.list` | 列目录 | 低 | auto（限工作区） |
| `fs.read` | 读文件 | 中 | auto（限工作区） |
| `fs.write` | 写文件 | 中 | ask（工作区外）/ auto（工作区内新文件） |
| `fs.delete` | 删除 | 高 | ask 且必须 Approval |
| `shell.exec` | 执行命令 | 高 | ask，命令白名单 |
| `http.fetch` | 抓网页 | 中 | auto，限频 + 域名策略 |
| `browser.open` | 打开页面并读取 | 中 | auto |
| `browser.act` | 点击/输入 | 高 | ask |
| `media.probe` | 读媒体信息 | 低 | auto |
| `media.transcode` | 转码/抽帧 | 中 | auto（工作区内） |
| `asr.transcribe` | 语音转写 | 中 | auto |
| `doc.render` | Markdown → docx/pdf | 低 | auto |

### 7.5 对外 HTTP API（云端，节选）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/devices/pair` | 设备配对，返回 deviceId + token |
| POST | `/v1/devices/:id/rotate` | 轮换设备令牌，旧令牌立即失效；跨用户 404 遮蔽，已吊销 409 |
| POST | `/v1/runs` | 创建 Run，指定 projectId/agentId/mode |
| GET | `/v1/runs/:id` | 查状态 |
| GET | `/v1/runs/:id/events?after=seq` | 增量拉事件 |
| POST | `/v1/runs/:id/approvals/:approvalId` | 批准/拒绝 |
| POST | `/v1/runs/:id/cancel` | 取消 |
| GET | `/v1/models` | 可用模型与价格 |

约定：全部 JSON；错误体 `{ error: { code, message, retryable } }`；幂等键 `Idempotency-Key` 头。

## 8. 架构决策记录（ADR 索引）

### ADR-001：桌面壳选 Tauri 而非 Electron

- 状态：已采纳
- 背景：需要 Windows 10 兼容、安装包小、内存占用低；团队无 Rust 深度经验。
- 选项：Electron（生态最熟、包体 150MB+、内存 300MB+）；Tauri 2（包体 10–20MB、内存低、Rust 学习成本）；纯 Web + 本地服务（安装体验差、无法守护进程）。
- 决定：Tauri 2。
- 理由：目标用户是老笔记本，体积和内存是真实门槛；Rust 只用在壳层，业务全在 TS。
- 后果：需要处理 WebView2 运行时缺失；Rust 侧调试成本略高；自动更新需自建或接 Tauri updater。

### ADR-002：Agent Core 用 TypeScript 同构，而不是 Python

- 状态：已采纳
- 背景：桌面与云端都要跑 Agent 循环，希望一份代码。
- 选项：Python（AI 生态最好、但桌面打包与进程管理麻烦）；TypeScript（前后端同构、打包成熟、AI SDK 已够用）；双语言（维护成本翻倍）。
- 决定：TypeScript。
- 理由：本项目以「编排 + 工具调用」为主，不训练模型，Python 生态优势用不上；媒体处理交给 ffmpeg 子进程。
- 后果：复杂 NLP 任务需调外部服务；重 CPU 任务用 sidecar 进程隔离。

### ADR-003：本地优先 + 出站隧道，云端不直连本地

- 状态：已采纳
- 背景：家庭网络无公网 IP；用户对开放端口有安全顾虑。
- 选项：端口映射/内网穿透（配置复杂、不安全）；云端直连（不可行）；本地发起 WSS 长连接（NAT 友好）。
- 决定：Agent Link 出站隧道。
- 理由：零网络配置，天然穿透 NAT，设备可随时吊销。
- 后果：需要处理断线重连、消息重放、离线队列；长连接有保活成本。

### ADR-004：本地 SQLite + 云端 Postgres，按可见性同步

- 状态：已采纳
- 背景：素材不能上传，但项目状态要多设备可见。
- 选项：全云端（隐私不成立）；全本地（多设备与云端任务不成立）；分层同步。
- 决定：结构化状态同步，素材按 `visibility` 过滤。
- 理由：满足隐私承诺，同时保留云端能力。
- 后果：需要冲突解决策略（第一版：项目级最后写入胜，Run/Event 只追加不冲突）。

### ADR-005：模型接入走 OpenAI 兼容协议 + 适配器

- 状态：已采纳
- 背景：用户要求可选本地模型或 API，且 API 居多。
- 选项：每家用官方 SDK（绑定深、升级烦）；统一 OpenAI 兼容（覆盖大多数）；自研抽象层 + 适配器（灵活但工作量大）。
- 决定：统一抽象 + OpenAI 兼容实现 + Anthropic/Gemini 薄适配器。
- 理由：90% 的供应商支持 OpenAI 协议；Ollama/llama.cpp/vLLM 也支持。
- 后果：部分厂商特有能力（如 prompt caching 细节）需单独适配；需要能力探测与降级。

### ADR-006：工具协议采用 MCP，不自造插件规范

- 状态：已采纳
- 背景：需要接第三方工具与本地服务。
- 决定：内部工具也用 MCP 风格 schema，外部 MCP Server 直接挂载。
- 理由：生态在收敛，复用现成 Server；自造协议无人跟随。
- 后果：MCP 规范仍在演进，需要版本兼容层；第三方 Server 质量参差，需要白名单与权限隔离。

### ADR-007：第一版不做自动发布

- 状态：已采纳
- 背景：B 站/抖音个人号无公开上传接口，抓取与自动化发布违反平台条款且有账号风险。
- 决定：只产出「发布包」，发布由人完成。
- 后果：少一个卖点，但避免封号与合规风险；后续可对接官方开放平台。

### ADR-008：Agent 编制采用 Supervisor + 专家，不用 Swarm

- 状态：已采纳
- 背景：创作流程有明确阶段与依赖，需要可控、可审计。
- 决定：Producer 编排，专家按阶段执行，Critic 独立审阅。
- 理由：Swarm 难调试、成本不可控；流水线式更适合内容生产。
- 后果：Producer 是单点，需要超时与降级；专家 Agent 之间不直接对话，减少上下文爆炸。

## 9. 实施计划

> 状态：[ ] 未开始 [~] 进行中 [x] 已完成

### 阶段 0：地基（第 1–2 周）

- [x] T1 仓库脚手架与 `packages/protocol` — 验证：`pnpm -r build` 通过，39 个单测通过，AQG 检查 PASSED（plan, 16 files, 2202 lines）
- [x] T2 SQLite schema 与迁移 — 依赖 T1 — 验证：迁移可重复执行（22 测试），INV-1/INV-9/INV-10 有测试，AQG PASSED
- [x] T3 ModelGateway（OpenAI 兼容 + Ollama）— 依赖 T1 — 验证：39 测试 + 真实 HTTP 端到端冒烟通过；真实供应商调用待 owner 提供密钥（`scripts/smoke-model.mjs`）
- [x] T4 ToolHost 与权限模型 — 依赖 T2 — 验证：无 grant 调用被拒（51 测试含 INV-3/INV-8），路径沙箱含符号链接，AQG PASSED
- [x] T5 Agent Core 单步循环 + 预算 — 依赖 T2/T3/T4 — 验证：11 例集成测试（真实 HTTP + 真实 SQLite + 真实 fs），变异测试确认测试有效

### 阶段 1：本地可用（第 3–5 周）

- [x] T6 Tauri 壳 + daemon 启动 — 验证：真实 `tauri build` 出 8.28MB exe；启动后自动拉起 daemon（健康检查 200）；WebView2 内 UI 可建项目、进工作台、发起 Run；关闭窗口时 kill 子进程
- [x] T7 AppShell + 路由 + 项目列表/工作台骨架 — 依赖 T6 — 验证：15 条路由全部可达（28 组件测试），三栏结构 + skip link，Tauri 真机 hash 路由跳转通过
- [x] T8 任务卡、事件流与待办 UI（P10/P11）— 依赖 T5/T7 — 验证：SSE 实时推送（7 条事件按序到达）、after 游标续传、断线清理、批准/拒绝生效，20+33 测试
- [x] T9 编辑与审阅界面（P5 脚本）— 依赖 T7 — 验证：版本化保存（sha256 校验）、行级 diff、按选区位置改写、逐段接受，48 测试 + 真机
- [x] T10 阶段页 P3/P4/P7 与 Agent 产物契约 — 依赖 T5/T9 — 验证：三类产物 zod 契约、代码围栏剥离、不合规输出 502 且不落盘，三页真机生成成功
- [x] T10b 首次引导 P0 + 设置 P14/P16/P17 — 依赖 T3/T4/T7 — 验证：三步引导可走完（环境→模型→工作区）、设置三页可读写（模型/权限/预算），真机验证 6 项
- [x] T11 端到端 MVP 链路（选题→发布包）— 依赖 T8/T9/T10 — 验证：四阶段产物齐备后导出 zip（PowerShell 解压验证）；「8 小时降到 2 小时」未做真人计时，仍需用户实测

### 阶段 2：云端（第 6–9 周）

- [x] T12 云端 API + 认证 + 设备配对 — 验证：6 位配对码（5 分钟 TTL、一次性）、Bearer 设备令牌、撤销后立即 401，13 例测试
- [x] T13 Agent Link 隧道网关 — 验证：设备主动 dial WSS，云端下发 `tool.call` 并收到 `tool.result`；断线/重连/超时均有明确错误码
- [x] T14 云端 worker 与调度 — 验证：云端 `/v1/runs` 生命周期（queued→running→succeeded/failed）+ 每月配额；**未接 BullMQ/Redis，任务为进程内排队**
- [x] T15 同步服务（visibility 过滤）— 验证：本地 `visibility='local'` 的产物从不经过云端 API，云端只存运行元数据，无产物内容通道（INV-10 由数据路径保证）
- [x] T16 计费与配额 — 验证：free/creator/pro 三档，超配额返回 402 `PLAN_LIMIT`，`/v1/usage` 按用户聚合运行数与费用

### 阶段 4：可运营（v0.2，2026-10-24）

- [x] T22 审批续跑与转录落盘 — 迁移 004/006，`AgentRunner.resume()`，审批一次性消费 — 验证：`apps/daemon/test/features.test.ts` R3（批准后续跑删文件、未批准 409）
- [x] T23 运行取消与项目生命周期 — `/cancel`、`PATCH/DELETE/restore`、关键词搜索 — 验证：R1/R4 共 6 例
- [x] T24 六类产物契约 — script / shot-list / review-report 加入 schema、提示词、渲染、上游映射 — 验证：R2 四例含 fail-closed
- [x] T25 复盘与资料库 — metrics 表 + `/v1/dashboard` + `/v1/library` — 验证：R6 三例
- [x] T26 自动化调度 — automations 表 + 30s 调度器 + 立即运行 — 验证：R5 两例
- [x] T27 模型密钥库与即时生效 — `SecretVault` + `replaceProfiles()` + 连通性测试 — 验证：R7 两例 + 设置页真机
- [x] T28 Web 形态 — daemon 托管前端 + 同源识别 — 验证：`http://127.0.0.1:7911/` 返回 200，29 张截图由真浏览器产出
- [x] T29 CLI — `apps/cli` 14 条命令 — 验证：5 例客户端契约测试 + 对活 daemon 跑 health/projects/checklist/artifacts/usage
- [x] T30 真实模型端到端 — 本机自定义网关跑通 6 阶段并导出发布包 — 验证：6 个产物落盘、zip 14.6 KB / 6 文件 / manifest 可复核

### 阶段 3：加固（第 10–12 周）

- [x] T17 提示注入防护与 untrusted 围栏 — 验证：`fenceUntrusted` 中和闭合标签、10 条注入模式扫描、上游产物入 prompt 前加围栏（60 测试）
- [x] T18 崩溃恢复与重放 — 验证：重启时扫描 running/queued 的 Run 并标记 `INTERRUPTED`（可重试），已完成的 Run 不受影响；真库两次启动验证
- [x] T19 可观测（trace + 成本报表）— 验证：`/v1/usage` 按 Agent×状态聚合 runs/tokens/费用/平均耗时，`/health` 暴露项目/运行/产物/事件计数与 uptime（70 测试）
- [x] T20 安装包与自动更新 — 验证：NSIS 安装包 11.12MB，静默安装后独立启动（内置 daemon runtime + node_modules），真机建项目通过；自动更新未做（无签名证书）
- [x] T21 安全审计（密钥、路径穿越、命令注入）— 验证：`scripts/security-audit.mjs` 扫 111 个源文件，5 类检查通过（密钥/子进程模板/未沙箱 fs/密钥日志/回环绑定）

### 关键路径

T1 → T2 → T4 → T5 → T10 → T11 → T12 → T13 → T14。

### 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| Tauri WebView2 在旧 Windows 缺失 | 高 | 安装包内置引导，启动检测并提示 |
| 隧道稳定性 | 高 | 心跳 + 重连 + 幂等重放 + 离线队列 |
| 模型输出不稳定 | 中 | 结构化输出 + schema 校验 + 重试一次 + 降级模板 |
| 长上下文成本 | 中 | 分层摘要 + 检索式记忆 + 预算封顶 |
| 提示注入 | 高 | untrusted 围栏 + 工具权限 + 破坏性操作审批 |

## 9.1 v0.2 增量（2026-10-24）

v0.1 的 T1–T21 覆盖了「一条链路的骨架」。v0.2 补齐的是**可运营**：审批后能续跑、花费可归因、
占位页全部落地、界面可日常使用、以及一个不依赖浏览器的脚本化入口。全部为增量，未推翻既有契约。

### 9.1.1 新增数据

| 迁移 | 内容 | 用途 |
|---|---|---|
| `004_run_messages.sql` | `runs.input_message`、`run_messages(run_id, seq, role, content, tool_call_id, name, tool_calls)` | 转录落盘，审批/中断后按最后一条 assistant 的未完成工具调用续跑 |
| `005_library_automations.sql` | `projects.description/tags`、`automations`、`automation_runs`、`project_metrics` | 项目元信息、定时生成、复盘数据回填 |
| `006_run_resume.sql` | `approvals.consumed_at` | 审批一次性消费，禁止同一批准复用 |

### 9.1.2 新增/变更接口

见 `docs/API.md` 全量清单。要点：

- 审批 → 续跑：`POST /v1/runs/:id/resume`，`ApprovalProvider` 只在 `executeOne` 缺省时请求；恢复时以持久化转录为准。
- 取消：`POST /v1/runs/:id/cancel`，同时把 pending 审批置 `expired`。
- 项目：`PATCH/DELETE /v1/projects/:id`、`POST /restore`、`GET /v1/projects?q=`、`GET /v1/projects/:id`（含 stats + checklist）。
- 生成：`kind` 扩到 6 类；每次生成建 Run 记账（`runId` 随 201 返回）；`pipeline.ts` 抽出复用。
- 设置：`POST /v1/settings/models/:id/key`、`POST /test`；`ModelGateway.replaceProfiles()` 让设置即时生效。
- 自动化：`/v1/automations` CRUD + `/run`，daemon 内置 30s 调度。
- 复盘：`/v1/projects/:id/metrics` 与 `/v1/dashboard`。
- 静态托管：`@fastify/static` + SPA fallback，浏览器可直接用 daemon 端口访问界面。

### 9.1.3 前端结构变化

- `AppShell` 增加：预算 chip、模型 chip（缺密钥时告警）、待办计数、主题切换、命令面板（Ctrl/Cmd+K）。
- 新增页面：`LibraryPage`、`AutomationsPage`、`ReviewPage`（ECharts 懒加载 1.1 MB chunk）；`StagePage` 增加分镜。
- 主题：`tokens.css` 双主题 + `prefers-reduced-motion`；`bootTheme()` 在首帧前应用。
- Markdown：`marked` + `DOMPurify`（模型输出按不可信输入处理）。

### 9.1.4 产物路径变更（破坏性，但仅影响本地文件布局）

产物从 `workspace/<relative>` 改为 `workspace/projects/<projectId>/<relative>`。原因：v0.1 两个项目写
`script/script.v1.md` 会互相覆盖。DB 里的 `path` 仍是项目内相对路径，`ArtifactStore` 负责拼接项目前缀。

### 9.1.5 生成健壮性（真实模型踩出来的）

1. **容错矫正**（`coerceByKind`）：数字字符串转数字、`risks: "a；b"` 转数组、`{cards:[{cards:[…]}]}` 解包。
   只修已知形状，其余仍 fail-closed。
2. **输出契约 + 一次纠正重试**：`jsonInstruction()` 追加字段级要求；首次 schema 失败时把字面示例塞回对话再请求一次（温度降到 0.2）。
3. **生成记账**：生成也走 Run 行，`/v1/usage` 能反映真实 token 与费用。

### 9.1.6 验证基线

9 个包 386 测试；`security-audit` 139 文件 5 类 PASS；对比度全过；Tauri 安装包 11.93 MiB；
真实模型（本机 OpenAI 兼容网关，glm-5.3-flash / deepseek-v4.1-flash）6 阶段全通。

## 9.15 v0.16 增量：细节与打包（2026-10-28）

### 9.15.1 截图审出来的六处细节

| 症状 | 根因 | 修法 |
|---|---|---|
| 项目卡写「0% 完成」，实际已有 5 个产物 | 百分比 = 当前阶段序号 / 阶段总数 − 1 | 改为「阶段 4/6」，进度条同步 |
| 阶段筛选 chip 撑成三行 | 六个包合计约 20 个阶段，`flex-wrap: wrap` | 单行横向滚动，工具栏高度固定 |
| 模型 chip 把「（缺密钥）」截掉一半 | `max-width` 作用在整个药丸上 | 药丸完整，内部 `.chip-label` 省略 |
| 深色下四类进度条消失 | `--track` 接近深色卡片底色 | 统一改 `--border` |
| 时间轴底部章节名贴边被裁 | 画布未留内边距 | 18px padding |
| 资料库「5 个产物 · 跨 6 个项目」自相矛盾 | 前者是筛选结果，后者是全局 | 文案区分「当前筛选」与「库内共」 |

### 9.15.2 ECharts 按需组装

全量 `echarts` 入口 1,090 KB（gzip 370 KB），而项目只画折线、柱状、网格、tooltip、图例。
`apps/desktop/src/lib/echarts.ts` 用 `echarts/core` 注册：

```ts
echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);
```

运行时降到 **547 KB**（gzip 185 KB），仍由 `Chart` 动态 import，只有复盘页加载。
`EChartsOption` 继续从 `echarts` 以 `import type` 取，编译期擦除。

### 9.15.3 v0.16 验证

- `pnpm verify`：9 个包 **636 passed + 9 skipped**；security-audit 200 files PASS；对比度 PASS
- 六场景造数，20 页 × 2 宽度 × 2 主题截图：0 console error、0 横向溢出
- 打包：`index 539 KB` / `echarts 547 KB`（动态）/ `cytoscape 433 KB`（动态）
- 截图：`70-projects-polished` / `71-timeline-padded` / `72-library-counts`（各含 `-dark`）

## 9.14 v0.15 增量：交互巡检（2026-10-27）

### 9.14.1 为什么截图不够

截图证明「页面画出来了」，不证明「点下去不出事」。这一轮把每个路由上的每个可用控件
都点一遍：728 次点击覆盖 4 个项目 × 全部场景阶段 + 5 个跨项目页，每次点击前强制重新加载文档，
避免单页应用的状态掩盖问题。

### 9.14.2 巡检脚本

`scripts/click-sweep.py` 从 `/v1/projects` 与 `/v1/scenarios` 推导路由，因此新增场景包不用改脚本。
每个控件执行：刷新 → 点击 → 检查崩溃边界 / `页面不存在` / 弹窗是否卡死 / 未预期的 HTTP 错误码。
错误码白名单只包含「无密钥安装下预期会出现的业务错误」（`MODEL_AUTH`、`NO_METRICS` 等），
其余一律算发现。第二遍处理键盘：Tab 是否落在可见元素、Escape、Ctrl+K 开关。
退出码非 0 可直接作为 CI 门禁。

### 9.14.3 本轮发现

| 症状 | 根因 | 修法 |
|---|---|---|
| 写作台「新建」必 400 | 只发 `number`，漏了包里必填的 `title` 字段 | 按 `entityType.titleField` 补字段；加回归测试 |
| 空项目写作台显示空图表骨架 | 0 章仍渲染篇幅区与图例 | 无章节时不画，右栏改为「先新建一章」 |

### 9.14.4 v0.15 验证

- `pnpm verify`：9 个包 **634 passed + 9 skipped**；security-audit 198 files PASS；对比度 PASS
- `click-sweep.py` 728 次点击 0 findings；键盘 12 页 Tab 全部可见、Ctrl+K 正常
- 压力：30 次连续跳转 / 3 轮明暗切换 / 三档宽度 / 快速输入切章 / 全部抽屉开关，0 error 0 溢出
- 健壮性：空项目 7 页 + 8 个畸形深链 + 损坏 localStorage，均可读空态无白屏

## 9.13 v0.14 增量：可视化的一致性与可读性（2026-10-27）

### 9.13.1 canvas 读不到 CSS 变量

ECharts 与 Cytoscape 都绘制到 canvas，`var(--fg)` 这类自定义属性对它们不可见。此前这两个库的
颜色全部硬编码为浅色值，浅色主题正常，深色主题下图表等于空白（深灰字画在深灰卡片上）。
`apps/desktop/src/lib/canvasTheme.ts` 从 `getComputedStyle` 读 token 得到一份具体色值，
并用 `MutationObserver` 监听 `documentElement[data-theme]`，主题切换后重新取色并重绘。

### 9.13.2 三个可视化问题

| 症状 | 根因 | 修法 |
|---|---|---|
| 深色图表空白 | 颜色硬编码 | `chartPalette(theme)` 提供两套序列色 + 轴/网格/图例色，option 构造函数接收调色板 |
| 关系图下半屏空白 | `fit()` 把整图缩进固定 620px 画布，孤立卡把布局拉高 | 画布高度按内容计算（360–620），只做横向缩放；孤立卡默认隐藏并提供开关 |
| 时间轴跨度条看不出问题 | `gapChapters === null` 按 0 渲染 | 改为虚线占位，文案补「跨度 N 章」 |

### 9.13.3 写作台的进度表达

| 元素 | 数据来源 | 说明 |
|---|---|---|
| 本章进度环 | 卡片 `word_target` 字段 | SVG 圆环，0 目标时不显示 |
| 全书进度条 | 所有卡片 `word_target` 之和 | 没有目标字段的场景包自动省略 |
| 章节篇幅柱 | 每章字数（CJK 字符 + 拉丁词） | 高度编码字数，颜色编码 `status` |
| 章节栏圆点 | `status` select | 与柱子同一套 tone 映射 |

所有字段名都来自场景包的 `fields` 声明，没有写死 `word_target` 就一定存在。

### 9.13.4 v0.14 验证

- `pnpm verify`：9 个包 **631 passed + 9 skipped**；security-audit 197 files PASS；对比度 PASS
- 浅色/深色各 12 页截图复核：0 console error、0 横向溢出；深色图表文字可读
- 截图：`64`–`67`（各含浅色与 `-dark`）

## 9.12 v0.13 增量：视图驱动的路由与场景一致性（2026-10-27）

### 9.12.1 问题

v0.9–v0.12 把「场景是数据」落到了存储和检查表，但前端路由与几处后端推进仍按视频的键名写死。
实机复现的四个症状：小说项目点「设定」得到「页面不存在」；「继续当前阶段」把用户送到角色卡；
章节产物进不了记忆索引；复盘后项目停在 `review`，而小说包只有 `revision`。
共同点不是某个页面写错，而是**用 key 当身份**。

### 9.12.2 路由

| 项 | 做法 |
|---|---|
| 单一入口 | `stageHref(projectId, stage)`：文档视图 → 写作台；卡片/看板 → 卡片页；发布/复盘 → 各自页面；视频五个键保留专属 URL；其余 generate 阶段 → `/stage/:stageKey` |
| 通用阶段页 | 同一组件按包解析标签、hint、`promptHint` 与产物类型；不再是「一个场景一组页面」 |
| 兜底 | 包里没有该阶段时给出「这个阶段不存在」并回到工作台，而不是空白页 |

### 9.12.3 数据一致性

| 症状 | 根因 | 修法 |
|---|---|---|
| 章节不进记忆 | 迁移 007 的 `kind` CHECK 只认视频产物，插入失败被 best-effort 吞掉 | 迁移 012 重建表放宽枚举，并重建随 `DROP TABLE` 一起消失的三个 FTS 触发器 |
| 复盘停在不存在的阶段 | `advanceStage(id, 'review')` 写死 | 找包里产出 `review-report` 的阶段 |
| 导出不推进 | 写死 `published` | 找 `view: publish` 的阶段 |
| 发布页少算文件 | 前端白名单漏 `outline`/`chapter` | 与 `isExportableKind` 对齐 |

### 9.12.4 包的校验更严

`board.groupBy` 必须指向该卡片类型上真实存在的 select 字段；`document` 的 body/title/order 字段同理。
写错的包在导入时被拒绝，而不是渲染成一列「未分组」或空编辑器。

### 9.12.5 v0.13 验证

- `pnpm verify`：9 个包 **628 passed + 9 skipped**；security-audit 195 files PASS；对比度 PASS
- 新增 14 例：`apps/daemon/test/consistency.test.ts` 4、`packages/store-sqlite/test/memory-migration.test.ts` 5、
  `apps/desktop/test/stage-route.test.tsx` 5
- 真机：小说 `设定` → `/stage/premise`、继续当前阶段同页；短视频镜头看板三列；工作台「11 张卡片」；
  命令面板「项目 · 设定」；资料库多出「大纲 / 章节」；0 console error、0 横向溢出
- 截图：`60-novel-generate-stage` / `61-shorts-shot-board` / `62-workspace-novel-stages` / `63-palette-stage-labels`

## 9.11 v0.12 增量：写作台、手稿导出与看板拖拽（2026-10-26）

### 9.11.1 为什么是「视图」而不是新场景

v0.11 之前，长篇小说的章节只有两种呈现：卡片板（`board`）和关系图。卡片板适合看进度，
但写作本身需要一个安静的单栏编辑器。这不是「小说专有功能」：课程讲义、剧本场次、
播客逐字稿都是「一堆有序长文本」，缺的是同一件事——一个把一个卡片类型投影成手稿的视图。

因此新增第六种视图 `document`，它只声明三件事：哪个卡片类型、正文放在哪个字段
（默认卡片 `body`）、按哪个字段排序。引擎仍然不知道「小说」是什么。

### 9.11.2 组件

| 项 | 做法 |
|---|---|
| 视图 | `STAGE_VIEWS` 增加 `document`；阶段可带 `document: { bodyField?, titleField?, orderField?, fileStem? }` |
| 校验 | 包加载时校验 `document` 指向的卡片类型与字段确实存在，写错字段直接拒绝而不是渲染空编辑器 |
| 写作台 | `/p/:id/write/:entityType`：章节栏 + 单栏编辑器 + 实时字数/段落 + 自动保存（900ms 防抖，切章立即落盘） |
| 手稿投影 | `GET /manuscript` 与 `POST /manuscript/export`；排序依次取 `orderField`、卡片 `order`、创建顺序 |
| Word 导出 | `docx@9.14.0` 生成 OOXML（标题页 + 每章分页 + 段落），与 Markdown 同时落到 `manuscript/` |
| 下载 | `GET /manuscript/download/:name` 只接受 `^[a-z0-9][a-z0-9-]*\.(docx\|md)$`，不做通用静态服务 |
| 看板拖拽 | `@dnd-kit/core` + `@dnd-kit/utilities`；拖动手柄是独立按钮，普通点击仍然打开卡片 |
| 卡片顺序 | `PATCH /entities/:cardId` 接受 `order`（≥0 整数），与字段一起写入 |
| 并发写保护 | 卡片带 `revision`；PATCH 必须回传 `expectedRevision`，服务端用一条 `UPDATE … WHERE revision = ?` 完成校验与写入。落后返回 409 `CARD_STALE` + 当前卡片，缺版本号返回 428。看板拖拽与卡片编辑同样带上版本号 |
| 版本历史 | 每次写入把写入前状态存进 `entity_revisions`（每卡上限 20 条，`reason` 记 save/restore/conflict）。`GET .../revisions` 与 `POST .../revisions/:n/restore` 支撑写作台的版本抽屉；恢复本身也写成新版本 |
| 三方合并 | `apps/desktop/src/features/merge.ts`：以「客户端读到的版本」为公共祖先，两侧 hunk 应用到 base；只有一侧改动的段落只出现一次，同一段落两侧都改写时输出带标记的冲突块 |

### 9.11.3 v0.12 验证

- `pnpm verify`：9 个包 **612 passed + 9 skipped**；security-audit 191 files PASS；对比度 PASS
- `apps/daemon/test/manuscript.test.ts` 6 例：乱序创建按序号导出、docx 内文字顺序、
  空项目拒绝、无写作阶段拒绝、下载名白名单、`order` 持久化
- `apps/desktop/test/writing.test.tsx` 5 例：章节栏与全书字数、自动保存、切章不串稿、导出、字数统计算法
- `apps/desktop/test/kanban.test.tsx`：列与拖动手柄渲染
- 真机 1440×900：输入后 2 秒状态变「已保存」，刷新后文字仍在；拖拽把第一章从「待写」移到
  「定稿」并落库（列计数 0/2/1/6/0）；导出 docx 11,219 B，9 章标题在 OOXML 中单调递增；
  0 console error、0 横向溢出
- 截图：`56-writing-desk` / `57-chapter-board` / `58-workspace-writing` / `59-writing-desk-dark`

### 9.11.4 已知边界

- 正文是纯 Markdown，不支持批注、修订模式、目录域；导出后由 Word 负责排版
- 自动保存以「整段正文覆盖」为单位，没有字符级合并；同一章节多端同时编辑会相互覆盖
- 拖拽只改所在列与顺序，不改章节号；章节号仍是手填字段
- Word 导出按空行切段，刻意不支持复杂版式（封面图、页眉页脚）

## 9.10 v0.11 增量：叙事时间轴与伏笔健康（2026-10-26）

### 9.10.1 为什么不是又一张关系图

关系图的力导向布局回答「谁连谁」，但作者的问题是**顺序与闭合**：章节有没有按序推进、
哪条伏笔埋了没收、哪条收得太晚。所以这一层不复用关系图的布局，而是用分层布局
（dagre）把章节排成一条时间轴，伏笔作为跨越两个章节的边。

### 9.10.2 组件

| 项 | 做法 |
|---|---|
| 布局 | `cytoscape-dagre@4.0.1`，`rankDir: LR`；章节之间补一条「阅读顺序」链作为秩约束 |
| 视口 | 画布宽度跟随内容，外层 `overflow-x: auto`；zoom 固定 1 保证文字可读 |
| 跳转 | 章节序号按钮 → 原生 `scrollTo` + 目标节点居中 |
| 分析 | `GET /v1/projects/:id/foreshadow-health` 计算埋设章/回收章/跨度，输出未回收与超长跨度两类问题 |
| 视觉 | 实线=回收、虚线=埋设、红框虚线=未回收；章节卡为带序号的白色卡片，左侧色条区分类型 |

### 9.10.3 v0.11 验证

- `pnpm verify`：9 个包 **587 passed + 9 skipped**；security-audit 185 files PASS；对比度 PASS
- `apps/desktop/test/timeline.test.tsx` 4 例：统计摘要、未回收清单与原因、跳转控件、工作台入口
- 真机：9 章 / 5 条伏笔 / 3 条未回收；画布 2143px、视口 838px 可滚动；
  跳转第 9 章后完整可见；0 console error、0 横向溢出
- 截图：`54-timeline` / `55-timeline-chapter9`

### 9.10.4 已知边界

- 章节顺序依赖手填的「章节序号」；没填时按创建顺序，可能与阅读顺序不一致
- 跨度为「回收章号 − 埋设章号」，按序号相减；分卷/插叙场景下这个数字意义有限
- 时间轴只画伏笔线，不画角色出场；角色与章节的关系仍看关系图
- 横向滚动在窄屏上依赖触摸板/滚轮，尚未提供缩略图导航

## 9.9 v0.10 增量：关系图（2026-10-26）

### 9.9.1 为什么换掉第一版

第一版用 ECharts `graph`（零新增依赖）。截图暴露的问题：边标签渲染成 `undefined`、
无图例、force 布局把节点挤成两团且标签互相压盖、无法「只看直接关系」、点击无反馈。
这不是调参能解决的——ECharts 的 graph 是图表，不是图编辑器。

改用 **Cytoscape 3.33.1**：专为网络图设计，自带 cose 布局、选择模型、逐元素样式、
缩放平移。动态 `import()` 加载，不进主包。

### 9.9.2 实现要点

| 项 | 做法 |
|---|---|
| 数据 | `GET /v1/projects/:id/graph` 一次返回 `nodes` + `edges` + `entityTypes` + `relationTypes`，避免 N+1 |
| 布局 | `cose` + `nodeDimensionsIncludeLabels: true` + `nodeRepulsion 42000` + `idealEdgeLength 165` |
| 边标签 | 默认隐藏（密集时会互相压盖），只在该边被高亮时显示；文字不旋转 |
| 选中 | 点击节点：其余元素 `dimmed`，直接边高亮并显示标签；点空白恢复 |
| 侧栏 | 选中后显示卡片字段（用场景包的字段标签而非 key）、关系列表（含反向词）、更新时间、跳卡片板 |
| 筛选 | 按卡片类型开关；搜索按标题/标签/字段值过滤 |
| 可测试性 | 把节点屏幕坐标发布到容器元素的 `__nodePositions`，canvas 图也能被自动化点击 |

### 9.9.3 v0.10 验证

- `pnpm verify`：9 个包 **583 passed + 9 skipped**；security-audit 183 files PASS；对比度 PASS
- `apps/desktop/test/graph.test.tsx` 4 例：节点/边计数与图例、关系类型正反向、类型筛选、工作台入口
- 真机 1440×900 DPR2：16 张卡 / 15 条关系；点击「第一章 雾从海上来」→ 其余淡出、
  三条关系高亮、侧栏列出 3 条；0 console error、0 横向溢出
- `52-graph-overview.png` / `53-graph-selected.png`

### 9.9.4 已知边界

- 布局是静态的一次性计算，节点多（>200）时会拥挤；届时需要换增量布局或分层布局
- 不支持手工拖拽后保存位置
- 边标签默认隐藏，只在高亮时显示；没有提供「全部显示」开关
- 图不区分关系方向的两端语义，只用一个箭头表达

## 9.8 v0.9 增量：场景扩展架构（2026-10-26）

### 9.8.1 三层边界

| 层 | 是什么 | 谁能改 |
|---|---|---|
| **引擎** | 阶段推进、生成流水线、检查表、实体/关系存储、预算与审计 | 只能改代码 |
| **视图** | `generate` / `entities` / `publish` / `review` / `board`（v0.12 起加 `document`）六种固定界面 | 只能改代码（闭集） |
| **场景包** | 阶段序列、每阶段用哪个视图、产出哪些产物、卡片字段、关系类型、阶段提示词 | 用户可写，纯 JSON |

扩展一个新场景**不需要写代码**，只需要组合上面这些视图；需要新交互时才先做一个视图，
再让场景包引用它。这条规则保证「装一个包」不会引入可执行代码。

### 9.8.2 能力协商

- 包声明 `formatVersion`（当前 2）与 `requiresViews`。
- 导入时把 `requiresViews` 与实际视图闭集对照；缺视图 → 400 `UNSUPPORTED_VIEW`，
  附 `supportedViews`，**不写任何行**。
- 视图名本身在 zod 里是 enum，未知视图连解析都过不去——双重防线。
- `GET /v1/scenarios` 与 `/export` 都带上 `engine: { packFormat, views }`，
  客户端可以据此判断「这份包我能不能读」。

### 9.8.3 继承与分发

| 能力 | 说明 |
|---|---|
| `inherits` | 读取时合并父包的阶段/卡片类型/关系类型；子包同名阶段覆盖；深度上限 4；循环拒绝 |
| 导出 | `GET /v1/scenarios/:id/export` 导出存储原样 + 引擎元信息 |
| 导入 | `POST /v1/scenarios/import`；校验 → 协商 → 继承解析 → 落盘，任一步失败都不留痕 |

### 9.8.4 内置场景清单（全部为数据）

| id | 场景 | 阶段数 | 卡片类型 | 关系类型 |
|---|---|---:|---:|---:|
| `video` | 中长视频 | 7 | 0 | 0 |
| `novel` | 长篇小说 | 6 | 4 | 4 |
| `podcast` | 播客 | 6 | 2 | 0 |
| `course` | 课程 | 6 | 2 | 0 |
| `copywriting` | 文案 / 图文 | 6 | 2 | 0 |
| `shorts` | 短视频 | 5 | 1 | 0 |

### 9.8.5 看板与关系类型

- `view: board` + `board.groupBy` 指向该卡片类型的一个 select 字段；列顺序取 `board.order`，
  空值进「未分组」。看板阶段在检查表里按卡片计数。
- `relationTypes` 声明 `key / label / inverse / fromTypes / toTypes`。写入时校验端点类型，
  读取反向时用 `inverse` 作为标签，正向存 `label`。未声明类型的包保持自由文本。

### 9.8.6 v0.9 验证

- `pnpm verify`：9 个包 **579 passed + 9 skipped**；security-audit 181 files PASS；对比度 PASS
- `packages/protocol/test/extension.test.ts` 18 例：内置包只用已支持视图、未知视图被 schema 拒绝、
  旧引擎遇新包时协商报缺、`generate` 隐式默认被收集、包格式版本、继承合并/覆盖/缺父/循环/深度、
  关系类型与反向标签、看板 `groupBy` 配置、两个新包的结构
- `apps/daemon/test/extension.test.ts` 11 例：`/v1/scenarios` 广播视图清单、导出导入往返、
  未知视图 400 + `supportedViews`、孤儿继承、循环、类型化关系正反向标签、未声明类型拒绝、
  端点不匹配拒绝、无声明包的自由文本兼容
- 真机：章节看板 5 列（含「未分组」），关系正向「出现在/埋于」、反向「出场于/埋有伏笔」
- 三张新截图：`49-chapter-board` / `50-typed-links` / `51-chapter-board-drawer`

### 9.8.7 已知边界

- 视图是闭集：真正新的交互（时间线、关系图、分屏对照）仍然要先写代码。
- 包没有迁移器：改内置包的字段键会让已有卡片读不到旧值。
- 没有签名与来源校验：导入的包来自谁、是否被改过，目前无法验证。
- 没有远程市场与自动更新：分发靠导出 JSON 手动传递。

## 9.7 v0.8 增量：卡片关联与交互打磨（2026-10-26）

### 9.7.1 卡片关联

| 组件 | 说明 |
|---|---|
| 迁移 010 | `entity_relations`：`from_card_id` / `to_card_id` / `label`，`UNIQUE(from,to,label)`，`CHECK(from <> to)` |
| 存储 | `linkCards` 校验两端同项目、不同卡；反向引用由 `listBacklinks` 派生，不重复存储 |
| API | `GET/POST /v1/projects/:id/entities/:cardId/links`、`DELETE /v1/projects/:id/links/:relationId` |
| 级联 | 删除卡片由外键 `ON DELETE CASCADE` 一并清除相关边 |
| 语义 | 有向边，读取只做一层展开，不做递归遍历——避免未来图视图里出现环 |

### 9.7.2 交互层

| 问题 | 改法 |
|---|---|
| 内联表单把看板顶出视口 | 改为右侧抽屉，`role=dialog` + `aria-modal`，打开聚焦首字段，Tab 在抽屉内循环，Escape 关闭 |
| 删除无确认 | `ConfirmDialog`，默认聚焦「取消」，Escape 等同取消 |
| 结果提示常驻不消失 | `useToasts` + `role=status`，成功 3.2s、错误 6.4s；校验错误同时保留内联面板 |
| 固定定位被 `.shell` 裁剪 | Drawer / ConfirmDialog / Toast 通过 `createPortal` 挂到 `body` |
| 卡片多时找不到 | 看板按标题、标签、任意字段值过滤 |
| 空态只有一句话 | 空态补主操作按钮 |

### 9.7.3 v0.8 验证

- `pnpm verify`：9 个包 **560 passed + 9 skipped**；security-audit 178 files PASS；对比度 PASS
- `apps/daemon/test/relations.test.ts` 5 例：正反向、自指拒绝、跨项目拒绝、解除、级联删除
- `apps/desktop/test/ux.test.tsx` 6 例：抽屉焦点与 Escape、删除取消/确认、toast、内联错误、搜索、关联
- 真机：焦点落在「卡片标题」，连续输入「回收于」完整、Escape 关闭、删除确认可取消，0 console error
- 三张新截图：`45-card-drawer` / `46-delete-confirm` / `48-toast`

### 9.7.4 已知边界

- 关联没有类型系统（label 是自由文本），无法按「出现在」自动生成反向语义
- 没有关系图视图；卡片详情只列一层关联
- 编辑抽屉不记录草稿，误关会丢未保存内容

## 9.6 v0.7 增量：场景包与通用卡片（2026-10-26）

### 9.6.1 为什么要做这一层

v0.6 之前，「一个项目是什么」是写死的：`ProjectStageSchema` 是七个视频阶段的 enum，
检查表是七条固定产物，界面按 `STAGES` 常量渲染。一个小说项目会被要求交分镜表和 SRT。
这不是配置问题，而是**领域假设被编进了 schema**。

v0.7 把这一层抽成数据：**场景包（ScenarioPack）声明阶段、视图、产物与卡片类型**，
引擎只认「阶段 + 视图 + 卡片」，不认「视频」或「小说」。

### 9.6.2 数据模型

| 表 | 作用 |
|---|---|
| `scenario_packs` | 包的 JSON 载荷 + `builtin` 标记；内置四套随启动从代码刷新，用户包不动 |
| `entities` | 所有卡片一张表：`project_id` + `type` + `fields`(JSON) + `body` + `tags` + `sort_order` + `revision` |
| `entity_revisions` | 卡片的历史状态（每卡最近 20 条），写入前快照，`reason` 区分保存/恢复/冲突 |
| `projects.scenario_id` | 项目所属包；缺省 `video`，保证老数据可用 |

卡片字段校验不是数据库约束，而是**按包声明的 schema 校验**（必填、未知字段、select 必须有选项、
单卡载荷上限 8KB）。这样换场景不用改表。

### 9.6.3 视图复用

阶段只允许引用五种已有视图，场景包不能引入新代码：

| view | 落点 | 用途 |
|---|---|---|
| `generate` | 现有阶段页 | 调模型产出结构化内容（含阶段级 `promptHint`） |
| `entities` | 新增卡片板 | 渲染该阶段 `entityType` 的卡片 |
| `publish` | 发布页 | 检查表 + 导出 |
| `review` | 复盘页 | 指标回填与归因 |
| `board` | 保留 | 预留的纯看板形态 |

### 9.6.4 检查表与阶段

- 检查表按包的 `required` 阶段生成，条目 key 为 `<stage>:<artifactKind>`。
- `view=entities` 的阶段数卡片而不是数产物（小说章节、课程课时）。
- 阶段推进取「本项目包里第一个产出该 kind 的阶段」，不再用全局映射表。
- 写入阶段时按包校验，未知阶段返回 400 `UNKNOWN_STAGE` + `available`。

### 9.6.5 v0.7 验证

- `pnpm verify`：9 个包 **518 passed + 9 skipped**；security-audit 172 files PASS；对比度 PASS
- `packages/protocol/test/scenario.test.ts` 15 例：四套内置包结构、video 阶段键与旧版逐字一致、
  包校验（重复键、无 required、titleField 未声明、select 无选项）、卡片字段校验与载荷上限
- `packages/store-sqlite/test/entity-store.test.ts` 11 例：种子幂等、内置包刷新但不覆盖用户包、
  内置只读、卡片顺序/作用域/更新删除、迁移后老项目默认 video
- `apps/daemon/test/scenario.test.ts` 16 例：场景 CRUD、项目按场景创建、阶段校验、
  场景感知检查表、卡片 CRUD、自定义包可用
- `apps/desktop/test/scenario.test.tsx` 4 例：阶段栏随包渲染、卡片板切换、按 schema 生成表单、创建时传场景
- 真机：小说项目阶段栏 6 项且无「分镜」；四类卡片共 9 张；章节检查表在卡片存在后转绿
- Playwright 1440×900 六张新截图：`39-novel-workspace` / `40-novel-characters` / `41-novel-chapters`
  / `42-novel-foreshadow` / `43-scenario-picker` / `44-novel-dark`，0 console error、0 横向溢出

### 9.6.6 已知边界

- 场景包只能组合现有视图，**不能声明新的渲染逻辑**；真正新的交互（例如时间线、关系图）
  仍需先做一个视图，再被包引用。
- 卡片之间没有关系字段（角色→章节、伏笔→章节只是文本引用），关系图与双向链接待做。
- 包没有版本号与迁移机制：改一个内置包的字段键会让已有卡片读不到旧值。

## 9.5 v0.6 增量：Postgres 云端、自动更新与三平台 CI（2026-10-26）

### 9.5.1 CloudStore 抽象与 Postgres 实现

| 组件 | 说明 |
|---|---|
| `apps/cloud/src/store.ts` | `CloudStore` 接口取代具体类；所有方法返回 `Awaitable<T>`，内存实现同步、Postgres 实现异步 |
| `apps/cloud/src/store-postgres.ts` | `pg` 连接池；六张表（devices / pairing_codes / runs / billing / plans / security_events）；首次连接惰性建表 |
| 租户隔离 | 每条查询带 `user_id` 谓词；外租户 id 与不存在等价（null / 空数组），并写 `cloud_security_events` |
| 配对码 | `UPDATE ... WHERE used_at IS NULL AND expires_at >= now RETURNING *` 单语句消费，天然防并发重复兑换 |
| 启动 | `DATABASE_URL` 或 `--database` 存在即用 Postgres，否则内存；`close()` 会 `pool.end()` |

### 9.5.2 自动更新

- `tauri-plugin-updater` 注册进 `lib.rs`；`tauri.conf.json` 配 `plugins.updater.pubkey` 与 endpoint。
- `bundle.createUpdaterArtifacts: true`，构建产出 `.sig`；私钥仅经 `TAURI_SIGNING_PRIVATE_KEY` 注入，不入库。
- 验证方式：Ed25519 公钥对安装包的 BLAKE2b-512 摘要验签（`cryptography` 库），并比对 keyid。

### 9.5.3 CI 三平台矩阵

| job | 矩阵 | 产物 |
|---|---|---|
| verify | ubuntu / windows / macos | —（build + typecheck + test + audits） |
| desktop | ubuntu / windows / macos | `.deb` / `.exe` / `.dmg`，各自上传 artifact |

Linux 段装 `libwebkit2gtk-4.1-dev` 等 Tauri 依赖；签名密钥走 GitHub secrets。

### 9.5.4 v0.6 验证

- `pnpm verify`：9 个包 **501 passed + 9 skipped**；设 `CLOUD_TEST_DATABASE_URL` 后 **510 passed**
- `apps/cloud/test/postgres.test.ts` 9 例：令牌认证、跨租户读/写拒绝、Run 作用域、配对码一次性与过期、令牌轮换、套餐与计费隔离、聚合不含租户 id
- 真实 PostgreSQL 16.4 + HTTP 端到端 6 项：配对 → `/v1/me` → 建 Run → 列表 → usage → health
- Tauri 签名安装包 13.01 MiB + `.sig`，Ed25519 验签 PASS
- `apps/desktop/test/updater-config.test.ts` 7 例：插件依赖/注册/公钥/endpoint、updater artifacts、版本一致性、私钥未入库、CI 矩阵三平台与签名 secret

### 9.5.5 仍然未验证

- CI 工作流**未在 GitHub Actions 真实运行**（本机无法触发远端 runner）；只做了 YAML 解析与内容断言。
- macOS / Linux 原生包**未本机构建**；Linux 交叉编译因缺 `x86_64-linux-musl-gcc` 失败。
- 自动更新的**端到端升级**未验证（需要一次真实发布）。
- Windows 安装包无 EV 代码签名，SmartScreen 仍会提示。

## 9.4 v0.5 增量：信任修复与资料溯源（2026-10-26）

### 9.4.1 界面渲染与发布一致性

| 项 | 变更 |
|---|---|
| 阶段页 Markdown | `apps/desktop/src/pages/StagePage.tsx` 用 `Markdown` 组件替换 `<pre>`，复用 `components/Markdown.tsx` 的 DOMPurify 消毒；选题卡、资料、分镜、包装四页统一 |
| 发布页清单 | `PublishPage.tsx` 白名单补 `subtitle`；计数文案改为「N 个产物 + README + manifest，共 N+2 个文件」，与实际 zip entries 一致 |
| 导出策略 | `POST /v1/projects/:id/publish` 默认每类只导出最新版，`{ includeHistory: true }` 才打包全部版本；响应新增 `includeHistory` 与 `stage` |
| 阶段推进 | 导出成功后 `advanceStageIfBehind(id, 'published')`，七段流水线第 6 段不再永远灰着 |
| manifest 版本 | 移除硬编码 `'0.2.0'`，改为启动时读取 `apps/daemon/package.json` 的 `DAEMON_VERSION` |

### 9.4.2 恢复入口与筛选

- `SqliteProjectStore.listWithDeleted(includeDeleted)`；`GET /v1/projects?includeDeleted=1` 之前解析了参数却没用，现在真的返回软删项目。
- 项目页新增「已删除」开关与恢复按钮，调用 `POST /v1/projects/:id/restore`。
- 资料库类型筛选补 `subtitle`。

### 9.4.3 Agent 与 API 收敛

- 补齐 `scout` / `researcher` / `director` / `packager` 四个 AgentSpec（含工具白名单），创建 Run 时对照已注册 agents 校验，未知 id 直接 400 `UNKNOWN_AGENT`（附 `available` 列表）。
- `/v1/projects/:id/generate` 对 `review-report` 返回 400 `USE_REVIEW_ENDPOINT`：复盘报告只能走 `/review`，确保带指标与阶段推进。

### 9.4.4 资料溯源（`packages/tools/src/http.ts` + `apps/daemon/src/research.ts`）

| 组件 | 说明 |
|---|---|
| `fetchPage` | 只允许 http(s)；拒绝 URL 内嵌凭据、localhost/.local、以及 loopback/RFC1918/link-local/ULA/multicast 字面量与解析结果；每一跳重定向都重新校验；默认 10s 超时、2MB 上限、最多 3 跳；内容类型白名单；`robots.txt` Disallow 即拒绝 |
| `htmlToText` | 去掉 script/style/noscript/注释，按块级标签换行，解码实体，压缩空白 |
| `gatherSources` | 最多 5 个来源，逐个抓取；成功进入 fenced 提示块并记录 `sha256`、字节、抓取时间；失败进入 `failures` 而不是静默忽略 |
| `verifyNotes` | 规范化（NFKC + 去空白/标点 + 小写）后在抓取原文里找 claim/note；找不到的把 confidence 降为 `low` 并写明原因，`quoteVerified=false` |
| 产物 | 事实要点每条带「✓ 原文可核 / ⚠ 未在原文找到」，末尾追加「抓取记录」表（来源、标题、时间、字节、sha256 前 12 位）与失败清单 |
| 新工具 | `fs.list`（单层目录、上限 200/500）、`http.fetch`（走同一套守卫），注册进 ToolHost，沿用 grant/audit/timeout |
| 失败语义 | 所有来源都抓不到时返回 502 `SOURCES_UNREACHABLE` + `failures`，**不调用模型** |

### 9.4.5 v0.5 验证

- `pnpm verify`：9 个包 494 passed；security-audit 160 files PASS；对比度 PASS
- `packages/tools/test/http-fetch.test.ts` 17 例（私网判定、scheme/凭据、重定向重校验、超时预算、截断、robots、HTML 抽取）
- `packages/tools/test/list.test.ts` 4 例（沙箱、根目录、上限）
- `apps/daemon/test/v05.test.ts` 13 例（工具注册、Agent 校验、最新版导出与阶段推进、manifest 版本、真抓取与降级、全失败不调模型）
- `apps/desktop/test/stage-render.test.tsx` 3 例（表格渲染 + XSS 消毒、资料页传参考链接、已删除恢复）
- 真机 daemon + 假模型端点端到端：抓 `https://example.com/` 成功、编造条目降级、字幕入 zip、旧脚本不导出、未知 agent 400、软删可列举
- Playwright 1440×900：资料页/分镜页/发布页/项目页/资料库 5 张新截图，0 console error、0 横向溢出

## 9.3 v0.4 增量：风格、字幕与复盘闭环（2026-10-26）

### 9.3.1 风格档案

| 组件 | 说明 |
|---|---|
| `packages/protocol/src/style.ts` | `StyleProfileSchema`（name ≤60、tone ≤400、audience ≤200、bannedWords ≤40、notes ≤600）与 `lintBannedWords`（大小写不敏感、逐次计数） |
| `packages/store-sqlite/src/style-store.ts` | 用户作用域 CRUD；`delete` 在同一事务里先 `UPDATE projects SET style_profile_id = NULL` 再删行 |
| 迁移 008 | `style_profiles` 表 + `idx_style_profiles_user` + `idx_projects_style` |
| `apps/daemon/src/generate.ts` | `renderStylePrompt` 生成「作者风格偏好」块，硬上限 1800 字，明确写「不得覆盖上面的输出契约」 |
| `apps/daemon/src/pipeline.ts` | `GenerateInput.style` 可选；在有 memory / upstream 之前插入，system 消息仍是第一条 |
| 检查表 | `buildChecklist(artifacts, { style })` 追加 `style` 项（`required: false`）；扫描范围是最新脚本 + 最新发布包，命中禁用词或尚无产物可查时 `ok: false`，但不影响 `ready` |

设计取舍：风格是用户自述，不按不可信内容围栏处理（它不是第三方抓取物），但仍用「偏好 vs 契约」的措辞与长度上限降低提示注入面；测试断言 system 提示仍在首位。

### 9.3.2 SRT 字幕

| 组件 | 说明 |
|---|---|
| `apps/daemon/src/subtitle.ts` | 去掉标题/引用/表格/代码块 → 按 `。！？；` 切句 → 再按 `，、：` 分包到 18 字；时长按 4.5 字/秒，夹在 1–8 秒；`formatTimestamp` 输出 `HH:MM:SS,mmm` |
| `POST /v1/projects/:id/subtitle` | 支持 `scriptArtifactId` 指定历史版本（跨项目/非脚本一律 400）；无脚本 409 `NO_SCRIPT`，无可口播文本 422 `EMPTY_SUBTITLE` |
| 产物 | `subtitle/subtitle.vN.srt`，mime `application/x-subrip`；`isExportableKind` 收录，发布 zip 自动带上；`indexArtifact` 显式跳过（派生内容，避免每句重复入索引） |

### 9.3.3 复盘闭环

| 组件 | 说明 |
|---|---|
| `POST /v1/projects/:id/review` | 取最近 5 条 `project_metrics`，计算播放/点赞/评论环比、互动率、收益，附发布包摘要（≤800 字）；生成 `review-report` 后 `advanceStage(id, 'review')` |
| Run 记账 | agentId 用 `critic`，与生成类接口同样建 Run 行、累计 token 与花费 |
| 界面 | 复盘页「生成复盘报告」按钮（无指标时禁用），生成后渲染 Markdown 并保留最近一份报告 |

### 9.3.4 v0.4 验证

- `pnpm verify`：9 个包 456 passed（本次新增 32 例）全绿
- `packages/store-sqlite/test/style-store.test.ts` 5 例：用户隔离、上限截断、删除时解绑
- `apps/daemon/test/style-subtitle.test.ts` 11 例：风格 CRUD/挂载/注入/lint、字幕导出与跨项目拒绝、复盘生成与阶段推进
- `apps/daemon/test/subtitle.test.ts` 5 例：切条、单调时间戳、SRT 格式、空脚本
- `apps/desktop/test/style.test.tsx` 5 例：风格面板、项目挂载、脚本导出、复盘生成
- Playwright 真浏览器：设置-风格、项目概览、脚本页、复盘页 0 console error、0 横向溢出；新截图 `docs/screenshots/33-settings-styles.png`

## 9.2 v0.3 增量：记忆检索与多租户隔离（2026-10-24）

### 9.2.1 本地记忆索引（`packages/store-sqlite/src/memory-index.ts`）

| 组件 | 说明 |
|---|---|
| `memory_chunks` 表 | 迁移 007。每条产物按 600 字 / 80 字重叠切片；记录 `source_ref`、`source_hash`、`chunk_index`、`model`、`dim`、`embedding` |
| `memory_chunks_fts` | FTS5 虚表，`tokenize='trigram'`（`unicode61` 会把整段中文当一个 token，实际搜不到），三个触发器保持与主表同步 |
| `chunkText()` | 定长重叠切片，`packages/model-gateway/src/embedding.ts` |
| `hashEmbedding()` | 确定性 n-gram 特征哈希，256 维、L2 归一化；CJK 走单字 + 相邻二元组，拉丁走词。**这是词法向量，不是神经语义向量**，代码与 UI 都如实标注 |
| `SqliteMemoryIndex.search()` | 混合检索：FTS5 子串（≥3 字）+ 向量余弦（≥0.15 阈值），用 reciprocal rank fusion 合并；短于 3 字的中文查询走 `LIKE`（trigram 的最小匹配长度限制） |
| 向量空间隔离 | 每行记录 `model`；只比较同一 `model` 的向量。换嵌入模型会触发重建，不会拿两套不同空间的向量算余弦 |

**增量索引**：写入产物后按 `source_hash` 判断，内容与嵌入模型都没变就跳过；变了先删旧切片再写新的（同一事务）。

**离线优先**：默认使用本地哈希嵌入，不需要任何网络与密钥；设置里显式选择支持 `/embeddings` 的模型后才切到模型向量（`remoteEmbeddings` / `settings.embeddingModel`）。探测失败自动回退，不会让检索失效。

**注入点**：`apps/daemon/src/pipeline.ts` 在生成时检索本项目切片（最多 4 条、每条 1200 字），用 `fenceUntrusted` 包起来，与「上游产物」并列但不互相替代——上游保证顺序一致性，检索补偿跨版本/跨阶段的历史信息。

### 9.2.2 多租户隔离（`apps/cloud/src/store.ts`）

v0.2 的隔离靠路由层逐条 `if`；v0.3 把它下沉到存储层，路由只调带 `userId` 的访问器：

| 访问器 | 语义 |
|---|---|
| `devicesOf(userId)` | 只返回本租户设备 |
| `deviceFor(userId, deviceId)` | 跨租户返回 `null` 并记录 `cross-tenant-read` 安全事件 |
| `runsOf(userId)` / `runFor(userId, runId)` | 同上；`runFor` 是读与写的前置检查 |
| `updateRun(userId, runId, patch)` | 只有属主能改；跨租户记录 `cross-tenant-write` |
| `billingOf(userId)` / `usage(userId)` | 计费与用量按租户聚合，不存在跨租户总量接口 |
| `POST /v1/runs` 的 `deviceId` | 目标设备不属于调用者时**静默降级为云端 Run**（`deviceId: null`），不报错、不泄露设备是否存在 |

`GET /v1/security-events` 只返回调用者自己的拒绝记录。`/health` 只暴露聚合计数（在线设备数、租户数），不含任何 id。

Postgres 版本应把这些访问器实现为 `WHERE user_id = $1`，并叠加 RLS 作为第二层；接口不变。

### 9.2.3 验证

- `packages/store-sqlite/test/memory-index.test.ts`：17 例（确定性、归一化、相关>不相关、切片、增量跳过、替换、删除、中文两字/长句检索、向量路径、项目隔离、类型过滤、空查询、limit、注入 provider）
- `apps/daemon/test/features.test.ts` R9/R10：6 例记忆端点 + 3 例嵌入设置 + 1 例记忆注入断言（检查上游收到的 prompt 含检索到的数字）
- `apps/daemon/test/embedding.test.ts`：2 例，用同时提供 `/chat/completions` 与 `/embeddings` 的假供应商验证「神经路径生效」与「无字面子串也能命中」
- `apps/cloud/test/cloud.test.ts` R8：5 例跨租户隔离（列表、读写 404、安全事件、降级、用量）

## 10. 变更日志

| 日期 | 变更摘要 | 影响的章节 | 关联任务/ADR | 验证方式 |
|---|---|---|---|---|
| 2026-11-07 | v0.19.1：内置 MCP 服务端——`POST /mcp`（Streamable HTTP、无状态、官方 SDK），10 个收敛工具回环走自家 API，审批/审计/版本检查原样生效；亮色成为默认主题（跟随系统降为可选项）；首页骨架屏（`prefers-reduced-motion` 兼容）；seed-demo 适配 `expectedRevision` 契约；CI 桌面打包改为仅 tag 触发 | §8 Agent 接入、§7 前端 | 0.20 前置（COMPETITIVE §7 调研结论） | `mcp.test.ts` 5 例 + 官方 SDK Client 外部实测（10 工具、真实建项）/ `pnpm verify` 711 passed + 9 Postgres / 对比度与版本一致性通过 |
| 2026-11-07 | v0.19：多设备写作——卡片写入改为按版本号的条件写（`UPDATE … WHERE revision = ?`），撞版本返回 409 并附当前卡，缺版本号返回 428，`force: true` 显式覆盖；章节版本历史（每卡 20 份，恢复本身也是新版本）；并排合并提示（用他的/留我的/两边都留）；路由级错误边界；打包壳修复——安装包自带 Node 运行时（不再要求用户机器装 Node）、子进程 `CREATE_NO_WINDOW`（不再弹黑色控制台）、daemon 离线恢复后首页自动重载（不再永久挂「无法连接本地 daemon」） | §5、§7.5、§9、§10 | 0.19 | `pnpm verify` 706 passed + 9 Postgres / `tauri build` 36.15 MiB 安装包真机启动 / 延迟 daemon 20s 强制复现竞态：横幅出现→自动消失 / `startup-race.test.tsx` 3 例、`packaged-shell.test.ts` 2 例 |
| 2026-11-02 | v0.17：质量门禁补强——lint 作为 fail-closed 门禁、离线模型冒烟（成功/坏输出/超时/取消/脱敏/预算）、AbortSignal 贯穿到 fetch、Postgres 集成缺 URL 即失败、浏览器点击巡检入 CI、ECharts 与 Cytoscape 按需拆包；修桌面端随机失败测试（异步预算 1s → 5s）；新增版本一致性校验与 STATUS/ROADMAP/RELEASING/VERIFICATION 四份管理文档 | §10 质量门禁 | T70–T72 | `pnpm verify` 642 passed + 9 skipped 连续 5 次 / shoot 26 页 0 error 0 溢出 / click-sweep 583 次点击 0 发现 / API 全链路 7 产物 + 检查表全绿 + 导出 zip |
| 2026-10-28 | v0.16：项目卡进度语义、阶段 chip 单行滚动、模型 chip 省略、深色进度条对比度、时间轴内边距、资料库计数文案；ECharts 改为按需组装（1090 → 547 KB） | §9.15 | T68–T69 | `pnpm verify` 636 passed + 9 skipped / 20 页 × 2 宽度 × 2 主题 0 error 0 溢出 / 打包体积实测 |
| 2026-10-27 | v0.15：交互巡检脚本（728 次点击 + 键盘遍历，按场景包推导路由）、修写作台新建章节 400 与空项目可视化空骨架 | §9.14 | T66–T67 | `pnpm verify` 634 passed + 9 skipped / click-sweep 0 findings / 2 张新截图 |
| 2026-10-27 | v0.14：canvas 主题（`lib/canvasTheme.ts` + MutationObserver）、三个图表/图/时间轴的深色可读性修复、关系图按内容定高与孤立卡开关、缩放控件、写作台进度环/全书进度/章节篇幅柱 | §9.13 | T64–T65 | `pnpm verify` 631 passed + 9 skipped / 浅色深色各 12 页截图 0 error 0 溢出 / 4 组新截图 |
| 2026-10-27 | v0.13：视图驱动路由（`stageHref` + 通用阶段页 `/stage/:stageKey`）、检查表与命令面板改用包标签、按 entityType 解析生成阶段、记忆索引放宽 kind 并重建 FTS 触发器、复盘/导出按包推进、看板分组校验、课程与短视频补看板 | §9.12 | T62–T63 | `pnpm verify` 628 passed + 9 skipped / 真机四个症状全部消除 / 4 张新截图 |
| 2026-10-26 | v0.12：第六种视图 `document`（写作台：单栏编辑器、自动保存、字数统计）、手稿投影与 Word/Markdown 导出（`docx@9.14.0`）、下载名白名单、看板拖拽（`@dnd-kit`）与卡片 `order` 持久化 | §9.11 | T60–T61 | `pnpm verify` 612 passed + 9 skipped / 真机自动保存与拖拽落库 / docx 9 章顺序校验 / 4 张新截图 |
| 2026-10-26 | v0.11：叙事时间轴（cytoscape-dagre 分层布局、横向滚动、章节跳转）、伏笔健康分析接口与右侧问题清单、章节卡新增序号字段；修 fit 压成缩略图与跳转不同步滚动两个视觉缺陷 | §9.10 | T58–T59 | `pnpm verify` 587 passed + 9 skipped / 真机 9 章可滚动可跳转 / 2 张新截图 |
| 2026-10-26 | v0.10：关系图页面（Cytoscape 3.33.1 替换初版 ECharts graph）、`GET /v1/projects/:id/graph`、类型筛选/搜索/选中高亮/侧栏详情；节点坐标发布以支持自动化点击 | §9.9 | T56–T57 | `pnpm verify` 583 passed + 9 skipped / 真机 16 卡 15 边选中态正确 / 2 张新截图 |
| 2026-10-26 | v0.9：场景扩展架构——包格式版本 + 视图能力协商、`inherits` 继承（循环/深度防护）、导出导入闭环、`board` 看板视图、关系类型化（正向/反向标签 + 端点约束）、新增 copywriting 与 shorts 两个纯数据场景 | §9.8 | T52–T55 | `pnpm verify` 579 passed + 9 skipped / 真机看板与类型化关系通过 / 3 张新截图 |
| 2026-10-26 | v0.8：卡片关联（有向边 + 派生反向引用 + 级联删除）；卡片编辑改抽屉（焦点环绕/Escape/焦点归还）；删除确认；toast 反馈；看板搜索；固定层 portal 到 body | §9.7 | T49–T51 | `pnpm verify` 560 passed + 9 skipped / 真机连续输入与键盘路径通过 / 3 张新截图 |
| 2026-10-26 | v0.7：场景包（4 套内置 + 用户自定义）与通用卡片实体；`projects.stage` 从 enum 改为场景内键并按包校验；检查表按包生成且卡片驱动阶段数卡片；新增 `outline`/`chapter` 产物契约与阶段级 `promptHint`；迁移 009 重建 projects/artifacts 表 | §9.6 | T45–T48 | `pnpm verify` 518 passed + 9 skipped / 真机小说项目阶段栏正确 / 6 张新截图 0 console error |
| 2026-10-26 | v0.6：云端 `CloudStore` 抽象 + Postgres 实现（租户谓词、配对码单语句消费、连接池释放）；Tauri `tauri-plugin-updater` + 签名产物；CI verify/desktop 扩到三平台三产物；安全审计排除 `.tmp/` | §9.5 | T42–T44 | `pnpm verify` 510 passed（含 Postgres 集成 9 例）/ 真实 PG 16.4 端到端 6 项 / Ed25519 验签 PASS / 安装包 13.01 MiB |
| 2026-10-26 | v0.5：阶段页 Markdown 渲染、发布页清单与计数对齐、导出默认最新版 + 自动推进 published + manifest 版本取自 package.json；Agent 创建期校验并补齐 4 个 AgentSpec；项目软删恢复入口；资料库字幕筛选；`http.fetch`/`fs.list` 工具与资料抓取溯源（SSRF/robots/体积/超时守卫 + 引文核验 + 抓取记录） | §9.4 | T38–T41 | `pnpm verify` 494 passed（9 包）/ security-audit 160 files PASS / 真机 e2e 全项通过 / 5 张新截图 0 console error 0 溢出 |
| 2026-10-26 | v0.4：风格档案（迁移 008 `style_profiles`、项目挂载、生成时注入「作者风格偏好」块、禁用词 lint 与检查表 `style` 项）；SRT 字幕导出（`apps/daemon/src/subtitle.ts`、`POST /v1/projects/:id/subtitle`、发布包自动收录）；复盘闭环（`POST /v1/projects/:id/review`，指标窗口 5 条 + 发布包摘要 → review-report → 阶段推进）；CLI 4 条新命令 | §6.1 StyleProfile、§7.5、§9.3 | T35–T37 | `pnpm verify` 456 passed（9 包）/ 新增 32 例测试 / Playwright 真浏览器 0 console error 0 溢出 / 真机 daemon 端到端导出含 SRT 的 zip |
| 2026-10-24 | v0.3：本地混合记忆检索（FTS5 trigram + 向量 + RRF，默认离线哈希嵌入，可选模型嵌入）、生成时记忆注入、`/v1/memory/*` 与 `/v1/settings/embedding`；云端多租户隔离下沉到 store（跨租户 404 + 安全事件 + Run 设备降级） | §9.2 | T31–T34 | `pnpm -r test` 421 passed（9 包）/ typecheck / build / security-audit 145 files PASS / contrast PASS / 真实模型验证 |
| 2026-10-24 | v0.2：审批续跑、取消、项目生命周期、分镜/复盘/资料库/自动化四页落地、密钥库、Web 形态、CLI、深色主题与命令面板、生成记账与容错矫正、项目级产物路径 | §6、§7、§9.1 | T22–T30 | `pnpm -r test` 386 passed（9 包）/ typecheck / build / security-audit 139 files PASS / contrast PASS / tauri 11.93 MiB / 真实模型 6 阶段端到端 / 29 张截图 0 console error |
| 2026-10-23 | 云端安全收口：`/v1/tool` 增加属主校验（跨用户/不存在设备统一 404 遮蔽）；新增 `POST /v1/devices/:id/rotate` 手动令牌轮换（旧令牌立即失效，已吊销 409） | §7.5、§7.3 | T12/T16 加固 | `pnpm -r test` 360 passed（cloud 24）/ typecheck / build / security-audit 117 files PASS / AQG 检查 PASSED |
| 2026-10-23 | CLOSEOUT 收尾：`/v1/tunnel` 升级握手校验设备令牌（4001/4003）+ 吊销即断开（4002）；脚本页空编辑器一键带入选题/资料产物；发布页 30s 轮询刷新；tools symlink 测试守卫修复并补 realpath 逃逸单测 | §7.3、CLOSEOUT | T13 加固 | `pnpm -r test` 354 passed（cloud 18、desktop 70、tools 61）/ typecheck / build / security-audit 117 files PASS / AQG 检查 PASSED |
| 2026-10-21 | 初始架构建立 | 全部 | ADR-001~008 | 文档评审 |
| 2026-10-21 | 补充前端结构、路由表、状态分层；新增 `docs/UI-SPEC.md` | §5.1、§9 T7–T10b | - | 文档评审 |
| 2026-10-21 | 新增 `docs/DESIGN-SYSTEM.md`、`docs/COMPONENT-TREE.md`、`scripts/check-contrast.py` | 文档索引 | - | `python scripts/check-contrast.py` 全部通过 |
| 2026-10-21 | T11 完成：`publish.ts`（检查表 + 手写 zip）+ `/v1/projects/:id/{checklist,publish}` + 发布页；端到端导出可解压 | UI-SPEC §5.8 | T11 | `pnpm -r test` 287 passed / build / typecheck / 真机导出 1.3KB zip / Expand-Archive 验证 4 文件 |
| 2026-10-21 | T10 完成：`protocol/artifacts.ts` 三类产物契约 + `daemon/generate.ts` 提示词与渲染 + `POST /v1/projects/:id/generate` + 选题/资料/包装三页 + `/health` 能力探测 | §6.1 Artifact、UI-SPEC §5.3/5.4/5.7 | T10 | `pnpm -r test` 274 passed / build / typecheck / 真机选题生成 3 卡 / 修复陈旧 daemon 端口占用 |
| 2026-10-21 | T9 完成：`ArtifactStore` 版本化产物（迁移 002 允许 run_id 为空）+ 行级 diff/hunk + 脚本页（编辑器/版本列表/改写对照）+ `/v1/artifacts` 与 `/v1/rewrite` | §6.1 Artifact、INV-2 | T9 | `pnpm -r test` 244 passed / build / typecheck / 真机保存与改写对照 / 修复 run_id 外键与替换位置 2 缺陷 |
| 2026-10-21 | T8 完成：SSE 事件总线 + `/v1/runs/:id/stream` + `/v1/runs` 列表 + 任务页，EventSource 实时订阅带轮询兜底 | §7.5、UI-SPEC §5.10 | T8 | `pnpm -r test` 215 passed / build / typecheck / curl 抓流 / WebView2 真机 state=open / 真机修复 3 缺陷 |
| 2026-10-21 | T7 完成：前端拆分为 app/components/pages/styles，15 条路由，P1/P2/P11 实页 + 12 个占位页，28 组件测试 | §5.1、UI-SPEC §4 | T7 | `pnpm -r test` 201 passed / build / typecheck / Tauri 真机构建 + WebView2 路由跳转与布局回归 |
| 2026-10-21 | T6 完成：`apps/daemon`（Fastify HTTP 面 + 项目/运行/审批 API，11 集成测试）+ `apps/desktop`（React UI + Tauri 2 壳，真实 exe 8.28MB）+ `project-store` | §5、§7.5 | T6 | `pnpm -r test` 173 passed / build / typecheck / Tauri release 构建成功 / 真机 WebView2 CDP 驱动验证 |
| 2026-10-21 | T5 完成：`packages/agent-core`（循环、预算、工具回灌、审批暂停、状态落盘）+ `RunStore` 契约与 SQLite 实现，11 集成测试 | §7.2、§6.3 INV-1/6/9 | T5 | `pnpm -r test` 162 passed / build / typecheck / 真实端到端：读→写→完成，事件流 7 条有序 / 变异测试 3 例转红 |
| 2026-10-21 | T4 完成：`packages/tools`（路径沙箱、glob 授权判定、审批门、审计、超时，51 测试） | §6.3 INV-3/INV-8、§7.4 | T4 | `pnpm -r test` 151 passed / build / typecheck / 真实 fs 端到端冒烟 / AQG PASSED |
| 2026-10-21 | T3 完成：`packages/model-gateway`（SSE 解析、OpenAI/Anthropic 适配器、预算预检、重试、脱敏、路由，39 测试） | §7.1、ADR-005 | T3 | `pnpm -r test` 100 passed / build / typecheck / 本地 HTTP 端到端冒烟 |
| 2026-10-21 | T2 完成：`packages/store-sqlite`（迁移 runner + 10 表 + 约束索引、22 测试） | §6.3 INV-1/9/10 | T2 | `pnpm -r test` 61 passed / build / typecheck / 真实 db 冒烟 / AQG PASSED |
| 2026-10-21 | T1 完成：pnpm workspace + `packages/protocol`（10 实体 schema、4 组不变量、6 类 Link 帧、39 测试） | §5、§6、§7 | T1 | `pnpm -r test` 39 passed / `pnpm -r build` / `pnpm -r typecheck` / AQG check PASSED |
| 2026-10-21 | 新增 `prototype/index.html` 可点击原型；修正 token 体系（拆 `field`/`track`/`control`/`on-danger`）、断点（检查器抽屉 1280、阶段栏 1000 转横排）、正文改无衬线 | §5.1 参考 UI-SPEC §9 | - | Playwright 回归：7 页切换、行点击、主题切换、抽屉、Tab 焦点、console 0 error；对比度 122 项全过 |
