# 稿台 Creator Studio

**面向个人创作者的本地优先 AI Agent 制片台。**
把「选题 → 资料 → 脚本 → 分镜 → 包装 → 发布包 → 复盘」串成一条可监督、可恢复、可追责的流水线；素材留在本机，模型随便换。

[快速开始](#快速开始) · [界面一览](#界面一览) · [核心能力](#核心能力) · [命令行](#命令行) · [架构](#架构) · [对标](#对标与差异) · [English](README.en.md)

![项目列表](docs/screenshots/01-projects-light.png)

## 它解决什么问题

创作者的日常工具是碎的：选题靠刷榜，资料散在几十个标签页，脚本在文档里，封面标题另开一个窗口，复盘靠记忆。
通用 AI 助手帮不上忙——它没有项目上下文、碰不到你的文件、每次都要从头讲一遍。

稿台把「一期视频」当成一个**项目**，用一个能真正读写文件、调用工具、按预算花钱的 Agent 流水线推进它，
并在每个关键节点停下来等你拍板。它不替你发布，也不替你删素材。

## 界面一览

| 工作台：阶段、产物、检查表、派活 | 脚本：写完即改，diff 对照 |
|---|---|
| ![工作台](docs/screenshots/02-workspace-light.png) | ![脚本](docs/screenshots/05-script-light.png) |

| 选题：3 张卡、四项评分 | 复盘：趋势与完播率 |
|---|---|
| ![选题](docs/screenshots/03-topic-light.png) | ![复盘](docs/screenshots/09-review-light.png) |

| 发布：检查表 + 一键导出 | 深色主题 |
|---|---|
| ![发布](docs/screenshots/08-publish-light.png) | ![深色](docs/screenshots/15-projects-dark.png) |

更多截图见 [`docs/screenshots/`](docs/screenshots/)（32 张，含 1100 / 900 宽度响应式、命令面板、记忆检索与深色主题）。
演示录屏：[`docs/media/demo.mp4`](docs/media/demo.mp4)（24 秒）· [`docs/media/demo.gif`](docs/media/demo.gif)。

## 快速开始

三种跑法，任选其一。

### 1. 桌面端（推荐给最终用户）

```bash
pnpm install
pnpm -r build
cd apps/desktop && pnpm tauri build
```

产物：`apps/desktop/src-tauri/target/release/bundle/nsis/CreatorStudio_0.2.0_x64-setup.exe`（11.9 MB，内置 daemon 运行时，装完即用）。

### 2. 浏览器 + 本地 daemon（推荐给开发与演示）

```bash
pnpm install && pnpm -r build
pnpm --filter @creator-studio/daemon start -- --port 7878
# 打开 http://127.0.0.1:7878/
```

daemon 会直接托管构建好的前端；没有单独的前端服务，也不需要配 CORS。

### 3. 只要 API / 脚本化

```bash
node apps/daemon/dist/main.js --port 7878
node apps/cli/dist/main.js health
```

## 配置模型

两种方式，选一种：

**界面里配（密钥进本机密钥库）**：设置 → 模型 → 填 Base URL / 模型名 / API Key → 保存密钥 → 测试连接。

**环境变量（适合 CI 或临时试用）**：

```bash
export MODEL_BASE_URL="https://api.openai.com/v1"
export MODEL_API_KEY="sk-..."
export MODEL_NAME="gpt-4o-mini"
node apps/daemon/dist/main.js --port 7878
```

支持任何 OpenAI 兼容端点（OpenAI、DeepSeek、通义、Kimi、GLM、Ollama、vLLM…）以及 Anthropic 原生协议。
密钥只写入 `<dataDir>/secrets.json`（0600），**不会进 SQLite、不会进日志、不会进事件流**。

> 本项目已在真实模型上跑通全链路：本机自定义端点 + `glm-5.3-flash` / `deepseek-v4.1-flash`，
> 选题 → 资料 → 脚本 → 分镜 → 包装 → 发布包 6 个阶段全部产出并通过 schema 校验（见「验证记录」）。

## 核心能力

| 能力 | 说明 |
|---|---|
| 七段流水线 | 选题 / 资料 / 脚本 / 分镜 / 包装 / 发布 / 复盘，每段独立页面与版本历史 |
| 结构化产物 | 每类产物有 zod 契约；模型输出先矫正（字符串数字、单值转数组、嵌套包装）再校验，失败自动带示例重试一次 |
| 审批门 | 删除、写工作区外、执行命令等高风险动作必须人工批准；批准后可「继续执行」，一次批准只用一次 |
| 可恢复 | 每步转录落盘；崩溃把在途 Run 标为 `INTERRUPTED`；批准后可从中断处续跑 |
| 预算与花费 | 每次生成/运行都建 Run 行记账；月度与单项目双上限；顶栏常驻「花费 / 上限」 |
| 工具权限 | `auto / ask / deny` 三档，deny > ask > auto，按工具 × 路径 glob 判定；无 grant 直接拒绝 |
| 审计 | 每次工具调用记录目标、判定、耗时、结果；`GET /v1/audit` 可导出 |
| 发布包 | 检查表全绿才允许导出；zip 内含全部产物 + `README.md` + `manifest.json`（逐文件 sha256） |
| 自动化 | 按间隔（每小时…每周）为指定项目重新生成某类产物；daemon 内置调度，也可「立即运行」 |
| 资料库 | 跨项目产物检索、类型筛选、内容预览 |
| 项目记忆 | 所有产物切片化索引，混合检索（FTS5 子串 + 向量），生成时自动注入相关历史片段；默认离线哈希嵌入，可切到模型的 `/embeddings` |
| 复盘 | 手工回填播放/点赞/评论/完播/收益，ECharts 趋势与环比 |
| 多租户隔离 | 云端存储层按 `userId` 作用域，跨租户读写一律 404 并记安全事件；Run 指定外部设备时静默降级为云端任务 |
| 主题 | 浅色 / 深色 / 跟随系统，全部 token 化并做过 WCAG 对比度核算 |
| 命令面板 | `Ctrl/Cmd + K` 搜项目、跳页面；`Ctrl+Shift+A` 直达待办 |

## 命令行

```bash
node apps/cli/dist/main.js health
node apps/cli/dist/main.js new "为什么 AI 编程正在杀死初级开发者" --platform bilibili --tag AI
node apps/cli/dist/main.js pipeline <projectId> "AI 与初级岗位"
node apps/cli/dist/main.js publish <projectId>
```

完整命令见 [`docs/CLI.md`](docs/CLI.md)。CLI 与界面走同一套 HTTP API，也可以指向远程 daemon（`--url`）。

## 架构

```
apps/
  desktop/   React 19 + Vite + Tauri 2（HashRouter，兼顾 tauri:// 与 http://）
  daemon/    Fastify 5：55 条路由、SSE、静态托管、调度器、密钥库
  cloud/     云端控制面（配对 / 隧道 / 配额 / 计费，内存实现）
  cli/       cs 命令：与界面同一套 API
packages/
  protocol/       实体 schema、不变量、Agent Link 帧、产物契约与容错矫正
  tools/          路径沙箱（realpath 防符号链接）、授权判定、审批门、审计、注入围栏
  model-gateway/  OpenAI / Anthropic 适配器、SSE 解析、预算预检、退避重试、脱敏
  store-sqlite/   7 个迁移、16 张表、仓储（Run/Project/Artifact/Settings/Automation/Metrics/Memory）
  agent-core/     Agent 循环、工具回灌、审批暂停与恢复、转录落盘
```

详细设计见 [`ARCHITECTURE.md`](ARCHITECTURE.md)（唯一真理源）、接口清单见 [`docs/API.md`](docs/API.md)。

### 安全边界（默认值）

- daemon 只绑 `127.0.0.1`；CORS 白名单只放行回环与 Tauri 伪源。
- 所有文件路径经 `resolveInsideWorkspace`：拒绝绝对路径、`..`、符号链接逃逸。
- 前端渲染 Markdown 一律经 DOMPurify 消毒，模型输出视为不可信输入。
- 云端不直连本机：本地 daemon 主动出站建立 WSS 隧道，设备令牌可吊销、可轮换。

## 验证记录

在本机（Windows 11 / Node 24 / Rust 1.99）实测，命令与结果：

```
pnpm -r test            9 个包，421 passed
pnpm -r build           all Done
pnpm -r typecheck       all Done
node scripts/security-audit.mjs   145 files, 5 checks PASS
python scripts/check-contrast.py  全部通过
npx tauri build         CreatorStudio_0.2.0_x64-setup.exe (11.93 MiB)
python scripts/shoot.py 25 张截图（+7 张演示截图，共 32），0 console error，0 横向溢出
node scripts/smoke-e2e.mjs       真实模型端到端：5 阶段生成 + 检查表 + 导出 zip
```

真实模型端到端（非 mock）：

- 端点：本机自定义 OpenAI 兼容网关，模型 `glm-5.3-flash` / `deepseek-v4.1-flash`
- 结果：6 个阶段产物全部生成、schema 校验通过；发布包 14.6 KB、含 6 个文件、`manifest.json` sha256 可复核
- 期间修掉两个真实缺陷：模型把 `risks` 输出成字符串导致 schema 失败（已加容错矫正）、
  模型无视「只输出 JSON」返回散文（已加输出契约 + 一次带示例的纠正重试）

## 对标与差异

同类开源项目里，Dify / n8n / langflow 强在通用编排，OpenHands / cline 强在 Agent 执行，MoneyPrinterTurbo 强在一键成片。
稿台的差异是**项目制的七段流水线 + 本地优先 + 审批与预算的默认约束**。

已迁移的机制与仍存差距，见 [`docs/COMPETITIVE.md`](docs/COMPETITIVE.md)（含 15 个项目的真实 star / license / 机制拆解）。

## 开发

```bash
pnpm install
pnpm -r test           # 421 tests
pnpm -r typecheck
pnpm -r build
python scripts/shoot.py --base http://127.0.0.1:7878   # 真浏览器截图 + 布局断言
```

- 贡献指南：[`CONTRIBUTING.md`](CONTRIBUTING.md)
- 安全策略：[`SECURITY.md`](SECURITY.md)
- 变更记录：[`CHANGELOG.md`](CHANGELOG.md)
- 产品思考：[`docs/PRODUCT-BRAINSTORM.md`](docs/PRODUCT-BRAINSTORM.md)
- 界面规格：[`docs/UI-SPEC.md`](docs/UI-SPEC.md) · 设计系统：[`docs/DESIGN-SYSTEM.md`](docs/DESIGN-SYSTEM.md)

## 已知边界

1. 云端为单机内存实现，未接 Postgres/Redis；重启丢云端状态（本地数据不受影响）。多租户隔离已在存储层实现并有测试，但换 Postgres 时需把同样的 `WHERE user_id` 谓词与 RLS 搬过去。
2. 自动更新未实现（无代码签名证书），NSIS 包需手动升级。
3. 默认记忆检索是**词法向量 + 子串匹配**（离线、零成本），不是神经语义模型；只有在设置里指定支持 `/embeddings` 的模型后才做真正的语义检索。这一点在界面与代码里都明确标注，不把词法匹配说成语义理解。
4. 「8 小时降到 2 小时」是产品假设，尚未做真人计时。

## 许可证

[MIT](LICENSE)
