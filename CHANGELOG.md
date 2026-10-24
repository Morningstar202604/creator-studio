# 变更记录

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号用语义化版本。

## [0.3.1] - 2026-10-24

### 修复

- **CI 从未通过**：干净 checkout 上 `typecheck` 先于 `build` 运行，而 workspace 包通过已产出的 `dist/*.d.ts` 互相解析（`dist` 不入库），导致 `Cannot find module '@creator-studio/protocol'`。根脚本改为 build → typecheck → test，CI 收敛为单条 `pnpm verify`，顺序不会再漂移。
- **路径沙箱在 Windows 上误拒合法新文件**：目标不存在时，用未展开的短路径（8.3 名）与 realpath 展开后的根比较，被判定为 `parent traversal via realpath`。改为向上找到最近的已存在祖先做 realpath，再拼回尾部。
- **路径沙箱在 POSIX 上放过单反斜杠路径**：原先只拒绝 `\\server`，`\server\share` 可通过绝对路径检查。现在任何平台都以反斜杠开头的输入一律拒绝。
- CI 增加 `actions/setup-python`（Ubuntu runner 上 `python` 不保证存在）。

## [0.3.0] - 2026-10-24

### 新增

- **本地记忆索引**：`memory_chunks` + FTS5 trigram 虚表（迁移 007），产物按 600 字/80 字重叠切片；`source_hash` 增量跳过，变更时同事务替换。
- **混合检索**：FTS5 子串 + 向量余弦（阈值 0.15 + reciprocal rank fusion）；两字中文查询走 `LIKE`（trigram 最小匹配长度限制）。
- **离线嵌入**：`hashEmbedding()`（CJK 单字 + 相邻二元组、拉丁词，256 维 L2 归一化），零网络零成本；行内记录 `model`，不同向量空间不混算。
- **可选模型嵌入**：`ModelGateway.embed()` 调用供应商 `/embeddings`；设置页可指定嵌入模型，切换后自动重建索引，探测失败回退本地。
- **生成时记忆注入**：`pipeline.ts` 检索本项目最多 4 条切片（每条 1200 字），`fenceUntrusted` 包裹后与上游产物并列注入。
- **记忆端点**：`GET /v1/memory/search`、`POST /v1/memory/reindex`、`DELETE /v1/memory/:sourceRef`、`GET|POST /v1/settings/embedding`。
- **云端多租户隔离下沉到存储层**：`devicesOf/deviceFor/runsOf/runFor/updateRun/billingOf`，跨租户读写 404 并记录 `securityEvent`；`GET /v1/security-events` 只返回自己的拒绝记录；Run 指定外部设备时静默降级为云端任务。
- **界面**：工作台内嵌「项目记忆检索」，新增 `/p/:id/memory` 页面与设置里的「记忆」分区（明示当前是模型向量还是本地词法向量）。
- **测试**：记忆索引 17 例、记忆端点 7 例、神经嵌入路径 2 例、跨租户隔离 5 例。

### 变更

- `/health` 增加 `memoryChunks`，能力列表增加 `memory`（apiVersion 仍为 3，新增能力按 capability 探测）。
- 默认嵌入实现是**词法向量**而非神经语义向量；文档、界面与代码注释统一如此表述。

### 修复

- 记忆索引在少于 3 个字符的中文查询上返回空结果（trigram 限制），改为 `LIKE` 回退。

## [0.2.0] - 2026-10-24

### 新增

- **审批后继续执行**：`POST /v1/runs/:runId/resume`，审批一次性消费（`approvals.consumed_at`），从落盘转录继续未完成的工具调用。
- **取消运行**：`POST /v1/runs/:runId/cancel`，过期待办一并置为 expired。
- **项目生命周期**：`PATCH /v1/projects/:id`（标题/平台/简介/标签）、`DELETE`（软删）、`POST /restore`、按关键词搜索。
- **分镜页**：`shot-list` 产物契约 + 生成 + Markdown 表格渲染，检查表中为可选项。
- **复盘页**：`project_metrics` 表、数据回填、ECharts 趋势/完播率、环比。
- **资料库**：`GET /v1/library` 跨项目聚合、类型筛选、内容预览；`GET /v1/dashboard` 汇总。
- **自动化**：`automations` / `automation_runs` 表、daemon 内置 30s 调度器、立即运行、暂停/启用、删除。
- **密钥库**：`SecretVault`（`secrets.json`，0600），模型密钥不再依赖环境变量；`POST /v1/settings/models/:id/key` 与 `POST /test` 连通性测试。
- **真实模型生效**：`ModelGateway.replaceProfiles()`，设置里保存的模型立即用于后续生成。
- **Web 形态**：daemon 通过 `@fastify/static` 托管前端，浏览器直接可用；前端自动识别同源，自定义端口无需重新构建。
- **CLI**：新增 `apps/cli`（`health/projects/new/show/rm/restore/artifacts/cat/gen/run/runs/checklist/publish/usage/pipeline`）。
- **前端**：深色/浅色/跟随系统主题、命令面板（Ctrl+K）、顶栏预算与模型状态、项目卡片视图、Markdown 渲染（DOMPurify 消毒）。
- **产物健壮性**：`coerceByKind` 容错矫正 + 一次带示例的纠正重试；生成失败仍保持 fail-closed。
- **发布包**：内置 `manifest.json`（逐文件 sha256、导出时间、生成器版本）。
- **生成记账**：每次生成都建 Run 行，`/v1/usage` 与顶栏花费可反映真实消耗。

### 变更

- 产物落盘路径改为 `workspace/projects/<projectId>/...`，两个项目同名文件不再互相覆盖。
- 检查表新增 `required` 字段与可选项（分镜）；导出只受必备项约束。
- 生成类接口的 `max_tokens` 提升到 4096，修掉长脚本被截断。
- `/health` 升至 `apiVersion: 3`，新增 `automations/metrics/library/resume` 能力标记。

### 修复

- 修复真实模型把 `risks` 输出为字符串时整次生成失败的问题。
- 修复模型无视「只输出 JSON」返回散文的问题（输出契约 + 纠正重试）。
- 修复多项目共用工作区时产物路径冲突。
- 修复 `run_messages` 转录索引与持久化序号错位导致恢复后丢工具消息。

### 迁移

- 新增迁移 `004_run_messages.sql`、`005_library_automations.sql`、`006_run_resume.sql`，启动时自动执行。

## [0.1.0] - 2026-10-23

### 新增

- 初始发布：protocol / tools / model-gateway / store-sqlite / agent-core 五个包，daemon + desktop + cloud 三个应用。
- T1–T21 任务全部完成：脚手架、SQLite schema、模型网关、工具权限、Agent 循环、Tauri 壳、路由、SSE、脚本页、阶段页、发布包、云端控制面、注入防护、崩溃恢复、可观测、安装包、安全审计。
