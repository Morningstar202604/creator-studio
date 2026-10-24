# HTTP API

Base：`http://127.0.0.1:7878`（daemon 默认只绑回环）。所有响应为 JSON；错误体统一 `{ error: { code, message } }`。
`/health` 返回 `apiVersion: 3`，`capabilities` 列出该构建支持的增量能力，客户端可据此判定「daemon 是否过旧」。

## 健康与观测

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | ok / apiVersion / capabilities / workspaceRoot / pid / uptimeMs / stats |
| GET | `/v1/usage` | 汇总 runs、tokens、cost，按 agent×status 聚合平均耗时 |
| GET | `/v1/tools` | 已注册工具（name / risk / approvalKind） |
| GET | `/v1/audit` | 工具调用审计记录（判定、目标、耗时、结果） |
| GET | `/v1/dashboard` | 项目数、产物按类型、运行按状态、花费、各项目播放汇总 |

## 项目

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/projects` | 建项目：`title`、`platform`、可选 `description`、`tags` |
| GET | `/v1/projects` | 列表；`?q=` 按标题/简介/标签搜索，返回 `counts` |
| GET | `/v1/projects/:id` | 详情 + `stats`（产物/运行/tokens/花费）+ `checklist` |
| PATCH | `/v1/projects/:id` | 改标题 / 平台 / 简介 / 标签 |
| DELETE | `/v1/projects/:id` | 软删除（可恢复） |
| POST | `/v1/projects/:id/restore` | 恢复软删除 |
| POST | `/v1/projects/:id/stage` | 手动推进阶段 |
| GET | `/v1/library` | 跨项目产物；`?kind=`、`?q=`、`?limit=` |

## 产物与生成

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/projects/:id/artifacts` | 产物列表（按创建时间倒序） |
| POST | `/v1/projects/:id/artifacts` | 手工保存产物（编辑器保存走这里） |
| GET | `/v1/artifacts/:artifactId` | 内容 + 元数据；sha256 不符返回 409 `ARTIFACT_CORRUPT` |
| POST | `/v1/projects/:id/generate` | `{ kind, context, includeUpstream? }`；成功 201 返回 `artifact` + `payload` + `runId` |
| GET | `/v1/projects/:id/checklist` | 检查表；`ready` 只看 `required` 项 |
| POST | `/v1/projects/:id/publish` | 全绿后导出 zip（含 README.md 与 manifest.json） |
| POST | `/v1/rewrite` | 选区改写，返回 `rewritten`、`durationMs` |

`kind` 取值：`topic-card`｜`research-notes`｜`script`｜`shot-list`｜`publish-pack`｜`review-report`。

生成失败语义：

- `502 MODEL_BAD_OUTPUT`：两次尝试后仍不符合契约，**不落盘**。
- `502 MODEL_AUTH` / `MODEL_RATE_LIMITED` / `MODEL_TIMEOUT` / `MODEL_UNAVAILABLE`：供应商侧错误。
- `400 INVALID_INPUT`：kind 或 context 非法。

## 运行与审批

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/projects/:id/runs` | 建 Run（`agentId`、`message`），返回 202 |
| POST | `/v1/runs/:runId/execute` | 同步执行；返回 `outcome` 与最新 `run` |
| POST | `/v1/runs/:runId/resume` | 审批后继续；可带 `approvalId` |
| POST | `/v1/runs/:runId/cancel` | 取消；pending 审批置 expired |
| GET | `/v1/runs` | 列表；`?status=`、`?projectId=`、`?limit=` |
| GET | `/v1/runs/:runId` | run + steps + approvals + messages |
| GET | `/v1/runs/:runId/events` | 事件增量；`?after=seq` |
| GET | `/v1/runs/:runId/stream` | SSE；`?after=seq`；事件名 `run.error` 避免与 EventSource 内置冲突 |
| GET | `/v1/approvals` | `?status=pending`（默认） |
| POST | `/v1/approvals/:id` | `{ decision: "approved" \| "rejected" }`；返回 `resumeHint` |

`execute` / `resume` 的 `outcome.status`：`succeeded`｜`waiting_approval`｜`paused`（`BUDGET_EXCEEDED` / `MAX_STEPS`）｜`failed`｜`cancelled`。

## 设置

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/settings/models` | 模型列表；每项含 `keyConfigured`（只报是否存在，不回传密钥） |
| POST | `/v1/settings/models` | 新增/更新模型；可带 `apiKey`（写入密钥库） |
| POST | `/v1/settings/models/:id/key` | 单独设置密钥 |
| POST | `/v1/settings/models/:id/test` | 发一次最小请求，返回延迟与样例 |
| DELETE | `/v1/settings/models/:id` | 删除模型与密钥 |
| GET/POST | `/v1/settings/grants` | 工具权限；`mode` ∈ `auto/ask/deny` |
| GET/POST | `/v1/settings/budget` | 月度上限、单项目上限、预警阈值 |
| GET | `/v1/onboarding` | 引导状态 |
| POST | `/v1/onboarding/complete` | 标记完成 |
| GET | `/v1/settings/defaults` | 默认预算 |

## 自动化

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/automations` | 列表；`?projectId=`；含最近 5 次执行 |
| POST | `/v1/automations` | 建规则：`projectId`、`name`、`kind`、`prompt`、`intervalMinutes`(15–10080) |
| PATCH | `/v1/automations/:id` | `{ enabled: boolean }` |
| DELETE | `/v1/automations/:id` | 删除 |
| POST | `/v1/automations/:id/run` | 立即执行一次 |

调度器每 30 秒检查到期规则；daemon 关闭期间不执行（本地优先的取舍）。

## 记忆检索

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/memory/search` | `?q=`（必填）、`?projectId=`、`?limit=`（≤20）、`?kind=`；返回 `hits`（含 `via: lexical/vector/hybrid` 与 `score`）、`embedder`、`neural`、`indexed` |
| POST | `/v1/memory/reindex` | `{ projectId? }`；重建指定项目或全部项目的切片 |
| DELETE | `/v1/memory/:sourceRef` | 删除一个来源（`artifact:<id>`，省略前缀会自动补） |
| GET | `/v1/settings/embedding` | 当前嵌入模型、实现 id、是否神经、已索引切片数、`mode: neural \| lexical-local` |
| POST | `/v1/settings/embedding` | `{ modelId: string \| null }`；切换后自动重建索引 |

检索语义：

- 查询 ≥ 3 字符走 FTS5 trigram；< 3 字符走 `LIKE`（trigram 无法匹配更短的串）。
- 向量路径只比较同一 `model` 的行，余弦低于 `0.15` 的候选被丢弃，避免词法哈希噪声。
- 默认 `embedder` 是 `hash-ngram`（离线）；配置了支持 `/embeddings` 的模型后为 `remote`。

## 复盘数据

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/projects/:id/metrics` | 指标列表（倒序） |
| POST | `/v1/projects/:id/metrics` | 回填：`views`、`likes`、`comments`，可选 `shares/retentionPercent/revenueCny/note` |
| DELETE | `/v1/metrics/:id` | 删除一条 |

## 云端控制面（`apps/cloud`，默认 8787）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/pair/start` | 生成 6 位配对码（5 分钟 TTL） |
| POST | `/v1/pair/complete` | 用配对码换设备令牌 |
| GET | `/v1/me` | 当前设备、套餐、用量 |
| GET | `/v1/devices` | 本用户设备与在线状态 |
| POST | `/v1/devices/:id/rotate` | 轮换令牌（旧令牌立即失效） |
| DELETE | `/v1/devices/:id` | 吊销（活隧道 4002 关闭） |
| POST/GET/PATCH | `/v1/runs…` | 云端运行记录与配额 |
| POST | `/v1/tool` | 经隧道下发工具调用（仅限同用户设备） |
| GET | `/v1/usage`、`/v1/plans` | 用量与套餐 |
| GET | `/v1/security-events` | 本租户的跨租户拒绝记录（不含他人数据） |
| GET | `/v1/runs/:id` | 单条运行（跨租户 404） |

WebSocket：`/v1/tunnel?deviceId=…&token=…`，由本地 daemon 主动拨入。
