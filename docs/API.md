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
| POST | `/v1/projects` | 建项目：`title`、`platform`、`scenarioId`、可选 `description`、`tags`；未知场景返回 400 `UNKNOWN_SCENARIO` |
| GET | `/v1/projects` | 列表；`?q=` 按标题/简介/标签搜索，返回 `counts` |
| GET | `/v1/projects/:id` | 详情 + `stats`（产物/运行/tokens/花费）+ `checklist` |
| PATCH | `/v1/projects/:id` | 改标题 / 平台 / 简介 / 标签 |
| DELETE | `/v1/projects/:id` | 软删除（可恢复） |
| POST | `/v1/projects/:id/restore` | 恢复软删除 |
| POST | `/v1/projects/:id/stage` | 手动推进阶段；必须是该项目场景包里的阶段，否则 400 `UNKNOWN_STAGE` |
| GET | `/v1/library` | 跨项目产物；`?kind=`、`?q=`、`?limit=` |

## 产物与生成

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/projects/:id/artifacts` | 产物列表（按创建时间倒序） |
| POST | `/v1/projects/:id/artifacts` | 手工保存产物（编辑器保存走这里） |
| GET | `/v1/artifacts/:artifactId` | 内容 + 元数据；sha256 不符返回 409 `ARTIFACT_CORRUPT` |
| POST | `/v1/projects/:id/generate` | `{ kind, context, includeUpstream?, sources? }`；成功 201 返回 `artifact` + `payload` + `runId`（资料阶段带 `sources` 时另返回 `meta`） |
| GET | `/v1/projects/:id/checklist` | 检查表；`ready` 只看 `required` 项；含可选的 `subtitle` 与 `style` 两项 |
| POST | `/v1/projects/:id/publish` | 全绿后导出 zip；`{ includeHistory?: boolean }` 默认只含每类最新版；响应含 `entries`、`includeHistory`、`stage` |
| POST | `/v1/rewrite` | 选区改写，返回 `rewritten`、`durationMs` |
| POST | `/v1/projects/:id/subtitle` | `{ scriptArtifactId? }`；把脚本转 SRT，201 返回 `artifact` + `cues`；无脚本 409 `NO_SCRIPT`，无口播文本 422 `EMPTY_SUBTITLE` |
| POST | `/v1/projects/:id/review` | 用最近 5 条指标生成 `review-report` 并把项目推进到 `review`；无指标 409 `NO_METRICS` |

`kind` 取值：`topic-card`｜`research-notes`｜`script`｜`shot-list`｜`publish-pack`。复盘报告只能走 `POST /v1/projects/:id/review`（带指标与阶段推进），`/generate` 收到 `review-report` 返回 400 `USE_REVIEW_ENDPOINT`。
产物类型另有 `subtitle`（SRT，mime `application/x-subrip`），不参与生成类 `kind`，也不进记忆索引。

生成失败语义：

- `502 MODEL_BAD_OUTPUT`：两次尝试后仍不符合契约，**不落盘**。
- `502 MODEL_AUTH` / `MODEL_RATE_LIMITED` / `MODEL_TIMEOUT` / `MODEL_UNAVAILABLE`：供应商侧错误。
- `400 INVALID_INPUT`：kind 或 context 非法。


## 资料抓取（v0.5）

`POST /v1/projects/:id/generate` 在 `kind=research-notes` 时接受 `sources`：

```json
{ "kind": "research-notes", "context": "主题", "sources": ["https://example.com/a", "https://example.com/b"] }
```

语义：

- 最多 5 个；逐个抓取，成功进入提示（`<untrusted-content>` 围栏），失败进 `failures`。
- 守卫：只允许 http(s)、拒绝 URL 内嵌凭据、拒绝 localhost/.local、拒绝 loopback/RFC1918/link-local/ULA/multicast 字面量与 DNS 解析结果；每一跳重定向重新校验；10s 超时、2MB 上限、最多 3 跳；内容类型白名单；`robots.txt` Disallow 即拒。
- 全部来源都失败 → `502 SOURCES_UNREACHABLE` + `failures`，**不调用模型**。
- 成功时响应带 `meta`：`sources[]`（url / finalUrl / title / status / bytes / truncated / fetchedAt / sha256）、`failures[]`、`unverified`、`downgraded`。
- 引文核验：claim 或 note 在抓取原文中找不到时，`confidence` 降为 `low`，note 追加原因；产物每条标注「✓ 原文可核 / ⚠ 未在原文找到」，末尾附「抓取记录」表。

工具层同一套守卫：`GET /v1/tools` 可见 `fs.list`（low）与 `http.fetch`（medium）。
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

## 场景包

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/scenarios` | 列表 + `defaultId`；内置四套 `video` / `novel` / `podcast` / `course` |
| GET | `/v1/scenarios/:id` | 单个包 |
| POST | `/v1/scenarios` | 新建或更新用户包；`builtin: true` 或缺 `required` 阶段或重复键返回 400 `INVALID_SCENARIO` |
| DELETE | `/v1/scenarios/:id` | 删除用户包；内置包返回 409 `BUILTIN_READONLY` |

包结构（节选）：

```json
{
  "id": "screenplay",
  "name": "剧本",
  "stages": [
    { "key": "logline", "label": "一句话", "view": "generate", "produces": ["topic-card"], "required": true },
    { "key": "scene",   "label": "场次",   "view": "entities", "entityType": "scene", "produces": ["chapter"], "required": true }
  ],
  "entityTypes": [
    { "key": "scene", "label": "场次", "titleField": "slug",
      "fields": [{ "key": "slug", "label": "场次号", "type": "text", "required": true }] }
  ],
  "defaultPlatform": "generic"
}
```

约束：独立包 2–12 个阶段、至少一个 `required`；继承包可以只写增量（≥1 阶段）。
阶段键与实体键各自唯一；`titleField` / `summaryFields` 必须已声明；
`select` 字段必须有 `options`；`view` ∈ `generate | entities | publish | review | board`（缺省 `generate`）。

### 扩展契约（v0.9）

| 字段 | 说明 |
|---|---|
| `formatVersion` | 包格式版本，当前 2；引擎只读 ≤ 自己支持的版本 |
| `requiresViews` | 本包用到的视图；导入时与引擎视图闭集比对，缺失返回 400 `UNSUPPORTED_VIEW` + `supportedViews` |
| `inherits` | 父包 id；读取时合并父包的阶段/卡片类型/关系类型，同名阶段由子包覆盖；深度上限 4，循环拒绝 |
| `relationTypes` | `{ key, label, inverse, fromTypes, toTypes }`；声明后建链必须带 `relationType` |
| `board` | 阶段级 `{ groupBy, order }`；`groupBy` 必须是该卡片类型的 select 字段 |

`GET /v1/scenarios` 与 `GET /v1/scenarios/:id/export` 都会返回
`engine: { packFormat, views }`，客户端据此判断能否读取。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/scenarios/:id/export` | 导出存储原样（包含引擎元信息） |
| POST | `/v1/scenarios/import` | `{ pack }`；校验 → 协商 → 继承解析 → 落盘，失败不留痕 |

## 通用卡片

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/projects/:id/entities` | 全部卡片 + 按 type 的计数；`?type=` 过滤。带 `type` 时额外返回 `entityType`（字段 schema）、`board`（分组配置）与 `document`（写作阶段配置） |
| GET | `/v1/projects/:id` | 项目详情；`stats` 含 `artifacts`、`runs`、`tokens`、`costCny` 以及卡片总数 `cards` |
| POST | `/v1/projects/:id/entities` | `{ type, title, fields, body?, tags? }`；按场景包校验，失败 400 `INVALID_CARD` |
| PATCH | `/v1/projects/:id/entities/:cardId` | 局部更新；**必须**带 `expectedRevision`（读过的那一版），可带 `order`（≥0 整数）用于看板拖拽排序；跨项目 id 视为不存在 |
| GET | `/v1/projects/:id/entities/:cardId/revisions` | 该卡的历史版本，新→旧，最多 20 条；返回 `current` 与 `revisions[]` |
| POST | `/v1/projects/:id/entities/:cardId/revisions/:revision/restore` | 恢复到某一版；恢复本身也是一次新写入，被替换的内容仍留在历史里 |
| DELETE | `/v1/projects/:id/entities/:cardId` | 删除；不存在 404 |

`fields` 是 `Record<string, string>`，单值 ≤2000 字符，整卡载荷 ≤8000 字符；
未知字段键会被拒绝（避免场景包改字段后残留脏数据）。

`board.groupBy` 必须指向该卡片类型上真实存在的 `select` 字段；`document` 的 `bodyField`/`titleField`/`orderField`
同理，包加载时校验，写错的包在导入阶段就会被拒绝。

### 并发写保护（v0.19）

每张卡有 `revision`，每次写入 +1。PATCH 必须回传读取时的 `expectedRevision`；
服务端的检查与写入是同一条 `UPDATE … WHERE revision = ?`，不是先读后写：

| 情况 | 响应 |
|---|---|
| 版本一致 | `200 { card }`，`card.revision` 已 +1 |
| 版本落后（别处先写了） | `409 CARD_STALE`，响应体带 `card`（当前真实内容），供客户端合并而不是猜 |
| 没带 `expectedRevision` | `428 EXPECTED_REVISION_REQUIRED` + 当前 `card`。这种请求过去会静默覆盖别人刚写的字，所以默认拒绝 |
| 确实要「覆盖当前内容」 | 显式 `force: true`（迁移、修复用），不走编辑路径 |

每次写入把**写入前**的状态存进 `entity_revisions`（每卡最多 20 条），
`reason` 区分 `save` / `restore` / `conflict`。恢复不倒退计数器，而是写成一个新版本，
所以恢复本身也能撤销。

## 写作与手稿（v0.12）

场景包声明 `view: "document"` 的阶段时，该卡片类型的正文就是手稿来源。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/projects/:id/manuscript` | 章节清单（按 `document.orderField`、卡片 `order`、创建顺序依次排序），含 `totalChars` |
| POST | `/v1/projects/:id/manuscript/export` | 生成 `manuscript/<fileStem>.docx` 与同名 `.md`；无文字卡片 409 `EMPTY_MANUSCRIPT`，超 200 万字 413 `MANUSCRIPT_TOO_LARGE`，场景无写作阶段 404 `NO_DOCUMENT_STAGE` |
| GET | `/v1/projects/:id/manuscript/download/:name` | 下载上一次导出的文件；`name` 只接受 `^[a-z0-9][a-z0-9-]*\.(docx\|md)$`，其余 400 |

`document` 配置字段：`bodyField`（默认卡片 `body`）、`titleField`（默认卡片标题）、
`orderField`（默认卡片 `order`）、`fileStem`（默认场景包 id）。正文按空行切段，
Word 每章另起一页。

## 项目关系图

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/projects/:id/graph` | 一次返回 `nodes`（全部卡片）、`edges`（全部关系）、`entityTypes`、`relationTypes` |

`edges[]` 形如 `{ id, from, to, label, relationType }`，`label` 是正向词；
渲染反向时前端按 `relationTypes[].inverse` 换算。该接口用于关系图页面，
避免前端逐卡片请求 links 造成 N+1。

## 伏笔健康

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/projects/:id/foreshadow-health` | 计算每条伏笔的埋设章、回收章、跨度；`items` 只含需要处理的（未回收，或跨度 > 12 章） |

返回 `{ total, open, paidOff, items[], relationTypes[] }`；`items[]` 每项含
`title / status / plantedAt / plantedChapter / lastChapter / gapChapters / note`。
章节顺序取章节卡的 `number` 字段，缺失时按创建顺序。

## 卡片关联

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/projects/:id/entities/:cardId/links` | 返回卡片 + `links[]`（`direction` 为 `out` 表示它指向别人，`in` 表示被别人引用） |
| POST | `/v1/projects/:id/entities/:cardId/links` | `{ toCardId, relationType?, label? }`；声明了关系类型的包必须带 `relationType`（400 `UNKNOWN_RELATION_TYPE` / `RELATION_TYPE_MISMATCH`）；自指 400 `SELF_LINK`，跨项目 404 |
| DELETE | `/v1/projects/:id/links/:relationId` | 解除关联；不存在 404 |

关联是有向边，反向引用在读取时派生，不重复存储；删除卡片由外键级联清除相关边。
正向读到的 `label` 是包声明的 `label`，反向读到的是 `inverse`（例如正向「出现在」、反向「出场于」）。
未声明 `relationTypes` 的包保持自由文本行为，`relationType` 为 `null`。

## 风格档案

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/styles` | 当前用户的风格档案列表（按更新时间倒序） |
| POST | `/v1/styles` | 新建或更新：`{ id?, name, tone?, audience?, bannedWords?, notes? }`；名称必填，禁用词上限 40 |
| DELETE | `/v1/styles/:styleId` | 删除档案，并在同一事务里把挂载它的项目置空；返回 `{ deleted, detached: true }` |
| GET | `/v1/projects/:id/style-lint` | 用项目挂载的档案扫描最新脚本与最新发布包（面向观众的两类产物），返回合并计数 `{ lint: { bannedWords, hits } \| null }` |

挂载方式：`PATCH /v1/projects/:id` 带 `styleProfileId`（字符串）或 `null` 解除；未知 id 返回 400。
挂载后 `/generate` 的五类内容产物（topic-card / research-notes / script / shot-list / publish-pack）都会在用户消息中追加「作者风格偏好」块（≤1800 字），system 提示保持在第一条；`/review` 是审片人写的分析报告，按设计不套用作者语气。

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

存储：不设 `DATABASE_URL` 时用内存实现；设置后切到 Postgres（`--database` 亦可）。
表结构首次连接自动创建，无需迁移步骤。集成测试使用真实数据库连接，不伪造通过：

```bash
# 无 URL 时明确返回 NOT_ENABLED / exit 2，不把 9 个 skipped 当作通过
pnpm test:postgres

# 配置真实实例后运行 9 个 PostgresStore 集成用例
CLOUD_TEST_DATABASE_URL=postgres://... pnpm test:postgres
```

CI 的 `postgres-integration` job 提供 Postgres 16.4 service，并通过 `CLOUD_TEST_DATABASE_URL` 执行同一命令。

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
