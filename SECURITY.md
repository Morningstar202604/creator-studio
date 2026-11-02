# 安全策略

## 报告漏洞

**不要开公开 issue。** 通过仓库所在平台的私密渠道报告：

- GitCode / Gitee：仓库 → Issues → 新建时把可见性设为「私有」，或直接联系仓库所有者
- GitHub（镜像）：Security → Advisories → Report a vulnerability

请附：影响版本（`node apps/cli/dist/main.js health` 的输出）、复现步骤、
影响面（能否读文件 / 能否外联 / 是否需要用户交互）。

> 维护说明：如果项目建立了专用安全邮箱，请替换本段。在替换之前，
> 不要在文档里写一个收不到信的地址——那会让报告者以为已经上报了。

## 安全模型

稿台是**单用户、本地优先**的桌面应用，威胁模型围绕三件事：

1. **模型输出不可信**：模型可能被网页或用户文件里的指令影响，也可能直接输出恶意内容。
2. **工具能碰真实文件**：能读能写能删，路径必须钉死在允许的根目录内。
3. **密钥必须留在本机**：API Key 是用户的钱，泄露即损失。

对应的默认控制：

| 风险 | 控制 | 位置 |
|---|---|---|
| 路径穿越 / 符号链接逃逸 | `resolveInsideWorkspace` 拒绝绝对路径、`..`、realpath 逃逸 | `packages/tools/src/path.ts` |
| 越权工具调用 | 无 grant 即拒绝；deny > ask > auto；高风险工具强制审批 | `packages/tools/src/grants.ts`、`host.ts` |
| 审批重放 | 审批一次性消费（`approvals.consumed_at`） | `packages/store-sqlite/src/run-store.ts` |
| 提示注入 | 外部内容包在 `<untrusted-content>` 围栏，并扫描常见注入模式 | `packages/tools/src/untrusted.ts` |
| 密钥落库 | 密钥只进 `secrets.json`（0600），DB 只存 `vault:` / `env:` 引用 | `apps/daemon/src/vault.ts` |
| 密钥进日志 | `redact()` 覆盖 `sk-*`、Bearer、长随机串；安全审计脚本静态扫描 | `packages/model-gateway/src/errors.ts`、`scripts/security-audit.mjs` |
| 本机端口暴露 | daemon 默认 `127.0.0.1`；CORS 只放行回环与 Tauri 伪源 | `apps/daemon/src/main.ts`、`server.ts` |
| 前端 XSS | Markdown 经 DOMPurify 消毒后渲染；不使用 `innerHTML` 直插未消毒内容 | `apps/desktop/src/components/Markdown.tsx` |
| 跨用户设备 | 云端 `/v1/tool`、`/rotate`、`DELETE` 统一 404 遮蔽；令牌可轮换可吊销 | `apps/cloud/src/server.ts` |
| 导出文件被当静态目录读 | 手稿下载只接受 `^[a-z0-9][a-z0-9-]*\.(docx\|md)$`，不做通用路径拼接 | `apps/daemon/src/server.ts` |
| 更新包被替换 | `tauri-plugin-updater` 用 Ed25519 校验 `.sig`；公钥内置于 `tauri.conf.json`，私钥只经 `TAURI_SIGNING_PRIVATE_KEY` 注入 | `apps/desktop/src-tauri/tauri.conf.json` |

## 已知取舍

- `secrets.json` 是明文文件，靠文件权限（POSIX 0600 / Windows 用户 ACL）保护。没有接 OS 钥匙串，
  因为跨平台钥匙串需要原生模块，会破坏可移植的桌面构建。建议开启全盘加密（BitLocker / FileVault）。
- 云端设备令牌目前通过 WebSocket 查询参数传递；接入 Postgres/公网部署前应升级为 `hello` 帧握手。
- 自动更新链路（构建 → `.sig` → Ed25519 校验）已接通并有签名验证用例，但**一次真实的旧版本→新版本升级未演练**。
  发布包仍建议从官方仓库下载并核对 sha256；Windows 安装包未做代码签名，SmartScreen 会提示。

## 支持的版本

只对最新 minor 版本提供安全修复。

## 更新签名密钥

- 公钥存放在 `apps/desktop/src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`，可以公开。
- 私钥**不入库**：只在构建时通过 `TAURI_SIGNING_PRIVATE_KEY`（可选 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`）注入；CI 走仓库 secrets。
- 私钥一旦泄露，攻击者可以签发被客户端信任的更新。轮换方式：生成新密钥对 → 同时替换配置里的公钥与 CI secret → 发布一个带新公钥的版本 → 旧私钥作废。
- 生成命令：`pnpm tauri signer generate -w <path>`（私钥写在工作区外）。
