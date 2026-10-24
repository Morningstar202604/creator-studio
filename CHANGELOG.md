# 变更记录

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号用语义化版本。

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
