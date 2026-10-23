# Creator Studio（稿台）

面向个人创作者的本地优先 AI Agent 工作台。把「选题 → 资料 → 脚本 → 包装 → 发布包」做成一条可监督、可恢复的流水线，素材留在本机。

## 快速开始

```bash
pnpm install
pnpm -r build
pnpm -r test

# 桌面端（开发）
cd apps/desktop && pnpm tauri dev

# 只跑本地 daemon
pnpm --filter @creator-studio/daemon start -- --port 7878
```

模型通过环境变量配置，密钥不落盘：

```bash
export MODEL_BASE_URL="https://api.openai.com/v1"
export MODEL_API_KEY="sk-..."
export MODEL_NAME="gpt-4o-mini"
```

## 交付形态

| 产物 | 位置 |
|---|---|
| NSIS 安装包 | `apps/desktop/src-tauri/target/release/bundle/nsis/CreatorStudio_0.1.0_x64-setup.exe`（11.1 MB） |
| 免安装 exe | `apps/desktop/src-tauri/target/release/creator-studio.exe` |
| 云端控制面 | `apps/cloud`（内存存储，`pnpm --filter @creator-studio/cloud start`） |

安装包已内置 daemon runtime 与依赖，装完即可独立运行，无需 Node 环境之外的额外配置。

## 结构

```
packages/
  protocol/        实体 schema、不变量、Agent Link 帧、产物契约
  tools/           路径沙箱、授权判定、审批门、审计、untrusted 围栏
  model-gateway/   OpenAI/Anthropic 适配器、SSE 解析、预算、重试
  store-sqlite/    迁移、Run/Project/Artifact/Settings 仓储
  agent-core/      Agent 循环、工具回灌、审批暂停、崩溃恢复
apps/
  daemon/          本地 Fastify 服务（22 路由）
  desktop/         React UI + Tauri 2 壳
  cloud/           云端控制面（配对、隧道、配额、计费）
docs/              产品、UI、设计系统、组件树、截图
prototype/         单文件可点击原型
scripts/           对比度校验、模型冒烟、安装包依赖、安全审计
```

## 文档

- [产品头脑风暴](docs/PRODUCT-BRAINSTORM.md)
- [界面与使用逻辑](docs/UI-SPEC.md)
- [视觉与设计系统](docs/DESIGN-SYSTEM.md)
- [页面组件树](docs/COMPONENT-TREE.md)
- [技术架构](ARCHITECTURE.md)（唯一真理源）
- [交互原型](prototype/index.html)

## 验证

```bash
pnpm -r test            # 8 个包，共 360 个测试
pnpm -r typecheck
node scripts/security-audit.mjs   # 密钥/子进程/沙箱/日志/绑定 5 类检查
python scripts/check-contrast.py  # 122 项对比度
```

## 已知边界

- 未接入真实模型供应商做端到端验证，生成与改写只对本地 fake upstream 跑过。
- 云端为单机内存实现，未接 Postgres/Redis，也未做多租户隔离。
- 自动更新未实现（无代码签名证书）。
- 「8 小时降到 2 小时」这一 MVP 目标未做真人计时。
