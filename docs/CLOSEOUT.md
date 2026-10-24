# 项目结项报告（v0.3）

日期：2026-10-24

## 本轮定位

v0.1 跑通「一条链路的骨架」，v0.2 把它做成可交付、可展示、可运营的开源项目。
v0.3 补上两项此前被列为「未验证」的能力：**本地记忆检索**与**云端多租户隔离**，
并把五个远端仓库从 fork 换成各自账号下的普通仓库（直接推 main，不再靠服务端同步）。

## 交付范围

| 维度 | 内容 |
|---|---|
| 流水线 | 选题 / 资料 / 脚本 / 分镜 / 包装 / 发布 / 复盘，7 个阶段全部有真实页面与产物 |
| 运行时 | 审批暂停与恢复、转录落盘、取消、崩溃标记、预算记账、审计 |
| 界面 | 卡片/列表双视图、搜索筛选、命令面板、深浅主题、响应式 1100/900、Markdown 渲染 |
| 数据 | 7 个迁移 16 张表（含 `memory_chunks` 与 FTS5 虚表）；项目软删恢复；自动化与复盘指标 |
| 入口 | Tauri 桌面安装包 / 浏览器直连 daemon / CLI 14 条命令 / HTTP API 55 条路由 |
| 记忆 | `memory_chunks` + FTS5 trigram + 向量余弦混合检索；离线 n-gram 嵌入，可选模型 `/embeddings`；生成时注入历史片段 |
| 多租户 | 云端存储层按 `userId` 作用域，跨租户读写 404 + 安全事件，Run 外部设备降级 |
| 物料 | 32 张真机截图、24 秒 MP4 与 GIF、中英 README、对标报告、API/CLI 文档 |

## 验证证据（本机实测）

```
pnpm -r test            9 packages, 421 passed
pnpm -r build           all Done
pnpm -r typecheck       all Done
security-audit.mjs      145 files, 5 checks PASS
check-contrast.py       all passed
tauri build             CreatorStudio_0.3.0_x64-setup.exe (11.94 MiB)
shoot.py                25 screenshots + 7 demo shots, 0 console errors, 0 overflow
```

真实模型（非 mock）：

- 本机自定义 OpenAI 兼容网关，模型 `glm-5.3-flash` / `deepseek-v4.1-flash`
- 6 个阶段全部生成并过 schema：topic-card / research-notes / script / shot-list / publish-pack（+ review 页面数据回填）
- 发布包 `publish-2026-10-24T02-12-19-058Z.zip`，14,621 B，6 个文件，`manifest.json` 逐文件 sha256
- `Apply-Archive`/Python zipfile 均验证可读

## 本轮修掉的真实缺陷

1. 模型把 `risks` 输出成字符串 → schema 失败。加 `coerceByKind` 容错矫正（数字字符串、标量转数组、嵌套解包）。
2. 模型无视「只输出 JSON」返回散文 → 加输出契约并在首次失败后带字面示例重试一次。
3. v0.1 产物路径跨项目冲突 → 改为 `projects/<projectId>/…`。
4. 恢复时转录索引错位 → 保留 system 行占位，按 seq 对齐。
5. Web 形态下前端硬编码 7878 → 改为同源识别，任意端口可用。

## 明确未完成（诚实清单）

1. **云端仍是内存实现**：未接 Postgres/Redis，重启丢云端状态。多租户隔离已在 store 层实现并有 5 例测试，但换 Postgres 时必须把同样的 `WHERE user_id` 谓词与 RLS 搬过去。
2. **自动更新未实现**：v0.3 明确不做（无签名证书），NSIS 只能手动升级。
3. **默认记忆检索是词法向量**：`hashEmbedding` 是 n-gram 特征哈希，不是神经语义模型；界面与文档均如实标注。真正的语义检索需要选择支持 `/embeddings` 的模型（代码路径与测试已就绪，用的是假供应商验证）。
4. **真人效率与质量指标未测**：「8 小时→2 小时」「初稿接受率 ≥60%」仍是假设。
5. **跨平台未实测**：只在 Windows 11 构建与运行；CI 工作流已写好但未在本机验证 GitHub Actions 实际跑通。

## 下一步（按优先级）

1. 用 `Store` 接口换 Postgres 实现，云端补 hello 帧握手、90 天轮换、离线队列。
2. 引入 SQLite FTS5 + embedding 增量索引，替代「上游全文拼接」。
3. 接 Tauri updater（需签名证书）。
4. 找 3–5 位目标创作者做 3 期陪跑，量真实耗时与接受率。
