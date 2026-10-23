# 项目结项报告

日期：2026-10-23

## 交付范围

按 `ARCHITECTURE.md` §9 的 21 项任务（含 T10b）全部完成。

| 阶段 | 任务 | 状态 |
|---|---|---|
| 地基 | T1 protocol / T2 store-sqlite / T3 model-gateway / T4 tools / T5 agent-core | 完成 |
| 本地可用 | T6 Tauri 壳 / T7 AppShell+路由 / T8 SSE+任务页 / T9 脚本站 / T10 三阶段页 / T10b 引导+设置 / T11 端到端+发布包 | 完成 |
| 云端 | T12 API+配对 / T13 隧道 / T14 worker+配额 / T15 同步边界 / T16 计费 | 完成（内存实现，见边界） |
| 加固 | T17 注入防护 / T18 崩溃恢复 / T19 可观测 / T20 安装包 / T21 安全审计 | 完成 |

## 验证证据

```
pnpm -r test            360 passed / 8 packages
pnpm -r build           all Done
pnpm -r typecheck       all Done
security-audit.mjs      117 files, 5 checks PASS
check-contrast.py       122 checks PASS
tauri build             CreatorStudio_0.1.0_x64-setup.exe (11.12 MiB)
```

真机验证（WebView2 + CDP）：安装版启动 → 自动拉起 daemon → 建项目 → 选题生成 3 卡 → SSE 事件按序 → 发布包导出 zip → `Expand-Archive` 解出 4 文件。

2026-10-23 补验（本机，无签名环境）：隧道鉴权 6 例（缺参/错 token/跨设备 token/吊销/合法/吊销即断）、脚本页带入 3 例、发布页轮询 1 例均过；`/v1/tunnel` 升级握手令牌校验生效。

## 明确未完成 / 未验证

1. **真实模型未接入**。所有生成与改写只对本地 fake upstream 验证，未用任何供应商密钥跑过。`scripts/smoke-model.mjs` 可在有 key 的机器上补测。
2. **云端是单机内存实现**。未接 Postgres/Redis，重启丢状态。`/v1/tunnel` 已补设备令牌校验（缺参 4001 / 无效 4003）并支持吊销即断开（4002）；`/v1/tool` 已补属主校验（跨用户/不存在设备统一 404）；设备令牌已支持手动轮换（`POST /v1/devices/:id/rotate`，旧令牌立即失效）。剩余：90 天定时轮换与离线队列重放需调度器，随 Postgres 时代落地；令牌经查询参数传递，升级 hello 帧握手后再暴露公网。
3. **自动更新未实现**。无代码签名证书，NSIS 包只能手动升级。
4. **MVP 效率目标未测**。「8 小时降到 2 小时」「初稿接受率 ≥60%」「事实核查 ≥80%」都是产品假设，需要真人实测。

已于 2026-10-23 闭环的原缺口：

- ~~页面间联动仍是手动的~~ → 脚本页在编辑器为空且存在选题/资料产物时提供「带入选题与资料」一键带入；资料/包装生成的提示词此前已自动携带上游产物。
- ~~发布页数据不会自动刷新~~ → 在手动按钮与 window focus 重载之外增加 30s 轮询。

## 建议的下一步

1. 用真实 API key 跑 `scripts/smoke-model.mjs`，再做一次完整 15 分钟视频的真人计时。
2. 把 `apps/cloud/src/store.ts` 的 `MemoryStore` 换成 Postgres 实现（接口不变）；届时同步落地 hello 帧握手、90 天定时轮换与离线队列重放。
3. 自动更新需代码签名证书后接 Tauri updater。
