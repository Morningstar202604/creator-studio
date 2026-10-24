# 对标调研：创作者 AI 工作台

> 采集时间：2026-10-24（UTC）。数据来自 GitHub REST API（`gh api`，仓库元数据 + README），
> 未做任何估算或四舍五入以外的加工。星标会漂移，引用时请以仓库实时数据为准。

## 1. 为什么选这些对标对象

本项目不是「又一个 AI 写作工具」，也不是「又一个工作流画布」。它落在三个圈的交集：
**项目制内容生产** × **本地执行能力** × **可监督的 Agent 流水线**。因此对标分四类取样：

| 类别 | 取样 | 看什么 |
|---|---|---|
| Agent 平台 / 工作流引擎 | Dify、n8n、Flowise、langflow、activepieces | 凭据抽象、执行日志、断点续跑、人审等待点 |
| 通用 Agent 控制台 | OpenHands、AutoGPT、LibreChat、open-webui、cline | 事件流、轨迹回放、权限与审批、检查点 |
| 内容生产流水线 | MoneyPrinterTurbo、khoj、OpenCut | 多供应商、任务队列、检索索引、编辑器交互 |
| 协议 / 工具生态 | modelcontextprotocol/servers | 工具声明、根目录限制、最小工具范式 |

## 2. 数据快照（2026-10-24）

| 项目 | stars | forks | 许可证 | 语言 | 最后 push | 一句话定位 |
|---|---:|---:|---|---|---|---|
| langgenius/dify | 159,366 | 25,177 | 修改版 Apache-2.0（禁多租户 SaaS） | Python | 2026-10-23 | LLM 应用 / 工作流 + RAG |
| n8n-io/n8n | 208,397 | 61,214 | Sustainable Use（fair-code） | TypeScript | 2026-10-23 | 可视化自动化 + 原生 AI |
| OpenHands/OpenHands | 91,663 | 12,160 | MIT | TypeScript | 2026-10-23 | 自托管编码 Agent 控制台 |
| LibreChat-AI/LibreChat | 46,216 | 9,499 | MIT | TypeScript | 2026-10-23 | 多模型 Chat / Agent 平台 |
| open-webui/open-webui | 156,573 | 22,783 | Open WebUI License（品牌条款 + 50 用户） | Python | 2026-10-23 | 离线优先 AI 界面 |
| FlowiseAI/Flowise | 55,521 | 25,077 | Apache-2.0 + 企业目录商业许可 | TypeScript | 2026-08-13 | 可视化 Agent 编排（仓库已归档） |
| langflow-ai/langflow | 155,971 | 10,241 | MIT | Python | 2026-10-23 | 可视化 Flow → API / MCP |
| Significant-Gravitas/AutoGPT | 187,717 | 45,903 | MIT + Polyform Shield（platform 目录） | Python | 2026-10-23 | 多专家 Agent 团队 |
| harry0703/MoneyPrinterTurbo | 134,536 | 21,281 | MIT | Python | 2026-10-23 | 一键短视频生成流水线 |
| OpenCut-app/OpenCut | 95,893 | 9,482 | MIT | TypeScript | 2026-09-24 | CapCut 开源替代（重写期） |
| continuedev/continue | 36,300 | 5,512 | Apache-2.0 | TypeScript | 2026-10-22 | 编码 Agent（README 称已只读） |
| cline/cline | 70,777 | 7,727 | Apache-2.0 | TypeScript | 2026-10-23 | IDE / CLI / 桌面编码 Agent |
| khoj-ai/khoj | 37,799 | 2,527 | AGPL-3.0 | Python | 2026-08-02 | 自托管个人第二大脑 |
| activepieces/activepieces | 25,186 | 4,383 | MIT + ee 目录商业许可 | TypeScript | 2026-10-23 | 开源 Zapier + MCP |
| modelcontextprotocol/servers | 91,520 | 11,848 | MIT → Apache-2.0 过渡 | TypeScript | 2026-10-22 | MCP 参考服务器集 |

## 3. 值得迁移的机制（按来源）

- **Dify**：把「供应商—模型—凭据」收敛为三元组；凭据只落密文，展示用掩码；审批按 API 面限定可批准对象并下发一次性 resume token；统一 trace 树。
- **n8n**：节点级 `retryOnFail / maxTries / waitBetweenTries`；每节点落执行进度，终态用守卫防止被覆盖；崩溃恢复重放未完成执行；Wait 节点实现人审等待。
- **OpenHands**：事件服务严格分页（`limit / pageId / timestampGte`），显式 `has_more`，不允许把不完整历史当结束；轨迹可导出。
- **LibreChat**：按 owner 命名空间隔离的会话检查点，支持中断续跑；Trace Viewer 展示轮次与成本；上下文用量分类统计。
- **open-webui**：插件四类（Filter / Action / Pipe / Tool）；访问授权与工具调用历史留痕；本地混合检索（BM25 + 向量 + rerank）。
- **cline**：按用户消息时间戳建检查点，可恢复、可看最新 diff 与变更计数；自动批准按工具粒度开关。
- **MoneyPrinterTurbo**：统一十余家供应商 + 网关；用原子操作更新任务状态并校验归属；固定线程池 + 信号量限制积压；产物与素材缓存分离。
- **activepieces**：等待点与释放策略显式化；审批链接强制 POST 二次确认；审批四类审计事件。
- **khoj**：按内容类型分 entry 的本地索引，跨 Markdown / PDF / Notion / GitHub 检索；定时研究推送。
- **MCP filesystem**：以可配置访问控制限定根目录；把「最小工具 + 明确边界」当作参考实现的标准。

## 4. 本项目已落地的对标项

| 能力 | 对标来源 | 本仓库落点 | 证据 |
|---|---|---|---|
| 凭据不进数据库、掩码显示 | Dify | `apps/daemon/src/vault.ts`（0600 文件 + `vault:` / `env:` 引用） | `apps/daemon/test/features.test.ts` R7；设置页只显示「已配置 / 缺密钥」 |
| 审批 → 恢复执行（一次性消费） | activepieces / n8n | `approvals.consumed_at` + `POST /v1/runs/:id/resume` | R3 两条测试：批准后可续跑、未批准 409 |
| 每步落盘 + 断点续跑 | n8n | `run_messages` 转录 + `pendingToolCalls()` 回放 | `packages/agent-core/src/runner.ts`；R3 断言 tool 消息入库 |
| 事件流增量拉取 | OpenHands | `RunEvent.seq` 唯一递增 + `?after=seq` | `apps/daemon/test/stream.test.ts`（含断线续传） |
| 工具权限矩阵 | cline / open-webui | `ToolGrant(device, tool, scope, mode)`，deny > ask > auto | `packages/tools/test/grants.test.ts`（61 例） |
| 预算封顶与用量账本 | LibreChat / Dify | 生成也建 Run 行记账，`addBudgetUsage` 原子更新 | `/v1/usage` + 顶栏「本月花费 / 上限」 |
| 可复现发布包 | MoneyPrinterTurbo | zip 内含 `manifest.json`（每文件 sha256 + 导出时间） | `apps/daemon/test/publish.test.ts` |
| 定时自动化 | khoj | `automations` 表 + daemon 内置调度器（30s 检查）+ 手动「立即运行」 | `apps/daemon/test/features.test.ts` R5 |
| 跨项目资料库 | khoj / open-webui | `/v1/library` 聚合 + 类型筛选 + 预览 | R6 测试 |
| 本地混合检索 | khoj / open-webui | `memory_chunks` + FTS5 trigram + 向量余弦 + RRF；离线 n-gram 嵌入，可选模型 `/embeddings` | `packages/store-sqlite/test/memory-index.test.ts` 17 例；`apps/daemon/test/embedding.test.ts` 2 例 |
| 生成时记忆注入 | khoj | 检索本项目切片，`fenceUntrusted` 包裹后与上游产物并列 | R9 注入断言（检查上游收到的 prompt） |
| 多租户隔离 | Dify / open-webui | 云端 store 作用域访问器 + 跨租户 404 + 安全事件 + Run 降级 | `apps/cloud/test/cloud.test.ts` R8 五例 |
| 结构化输出失败自愈 | — | 容错矫正（字符串数字 / 单值转数组 / 嵌套包装）+ 一次带示例的纠正重试 | `packages/protocol/src/artifacts.ts` `coerceByKind`；真实模型验证 |

## 5. 明确不做（与对标产品划清边界）

1. 多租户 / RBAC / SSO 全家桶：单用户本地产品收益为零。
2. 通用节点画布与数百节点库：固定七段流水线更可控，画布是无底洞。
3. 集成市场与云端计费：长尾维护成本高，按需接 MCP / OpenAPI 即可。
4. 多向量库、多执行后端矩阵：SQLite 一档足够，抽象过度只会拖慢迭代。
5. 默认全权限的 Agent：本项目默认最小权限，危险操作逐次审批。

## 6. 仍未对齐的差距（诚实清单）

| 差距 | 现状 | 后续路径 |
|---|---|---|
| 云端多租户与 Postgres | `apps/cloud` 为单机内存实现 | 换 `Store` 实现；`/v1/tool` 与轮换语义已按多租户预留 |
| 神经语义检索 | 已实现检索管线（FTS5 + 向量 + RRF）；默认嵌入是离线 n-gram 哈希，属词法匹配 | 在设置里选择支持 `/embeddings` 的模型即可切到神经向量，切换后自动重建 |
| 真实模型嵌入验证 | 用假供应商（同时提供 chat 与 embeddings）验证了代码路径 | 用真实 embedding 模型跑一次 `scripts/smoke-e2e.mjs` 的可选分支 |
| 崩溃后自动续跑 | 重启把 running 标记为 `INTERRUPTED`，可人工 resume | 调度器自动挑选可重放 Run |
| 跨平台产物构建 | 只在本机 Windows 验证 | GitHub Actions 三平台矩阵（工作流见 `.github/workflows/ci.yml`） |
| 真人效率评测 | 「8 小时 → 2 小时」未实测 | 5 人 × 3 期陪跑计时 |
