# 贡献指南

## 开发环境

- Node ≥ 22（实测 24.14）、pnpm 12、Rust 1.99（仅桌面壳需要）、Python 3.11+（截图与对比度脚本）
- Windows / macOS / Linux 均可开发；桌面安装包目前只在 Windows 实测

```bash
pnpm install
pnpm -r test
pnpm -r typecheck
pnpm -r build
```

## 提交前必须通过

```bash
pnpm -r test                     # 386 tests
pnpm -r typecheck
pnpm -r build
node scripts/security-audit.mjs  # 密钥 / shell 模板 / 未沙箱 fs / 密钥日志 / 回环绑定
python scripts/check-contrast.py # 语义色对比度
```

改了界面，还要跑真浏览器回归（会顺带产出截图与布局断言）：

```bash
node apps/daemon/dist/main.js --port 7878 &
python scripts/shoot.py --base http://127.0.0.1:7878
```

## 代码约定

- TypeScript 严格模式；不引新依赖除非说明包体与构建代价。
- 业务逻辑放 `packages/*`，应用层只做编排；页面不直接访问 SQLite。
- 所有模型输出视为不可信：先格式化/矫正，再 zod 校验，失败 fail-closed。
- 所有文件路径必须经 `resolveInsideWorkspace`，不要自己拼 `join()`。
- 不写无关注释；提交信息用「动词 + 对象」一句话说明改了什么。

## 数据库迁移

新增迁移文件放到 `packages/store-sqlite/src/migrations/`，命名 `NNN_slug.sql`，只增不改。
启动时 `migrate()` 会按版本号顺序应用，已应用的不会重复执行。

## 新增一个产物类型

1. `packages/protocol/src/artifacts.ts`：加 schema、`coerceByKind` 分支、`GenerateKind`、`GENERATE_KINDS`。
2. `apps/daemon/src/generate.ts`：加提示词、示例、路径、`renderMarkdown`、`UPSTREAM`。
3. `apps/daemon/src/publish.ts`：确认是否进检查表 / 是否可导出。
4. 前端：`StagePage` 配置、类型筛选、文档与截图。
5. 测试：契约测试 + 生成端点测试 + 至少一条失败路径。

## 提交 PR

- 一个 PR 只做一件事；附带「改了什么 / 没动什么 / 未验证什么」。
- 涉及鉴权、权限、密钥、数据模型、CI 的改动请在描述里单列风险与回滚方式。
