# 贡献指南

## 开发环境

- Node ≥ 22（实测 24.14）、pnpm 12、Rust 1.99（仅桌面壳需要）、Python 3.11+（截图与对比度脚本）；浏览器巡检使用 uv 与固定版本 Playwright 1.55.0
- Windows / macOS / Linux 均可开发；桌面安装包目前只在 Windows 实测

```bash
pnpm install
pnpm -r test
pnpm -r typecheck
pnpm -r build
```

## 提交前必须通过

```bash
pnpm verify                      # lint → build → typecheck → test → 离线冒烟 → 安全 → 对比度 → 版本一致
pnpm -r test                     # 9 packages, 657 passed, 0 skipped
```

`pnpm verify` 一条命令跑完全部门禁，CI 用的就是它；单独跑其中几项只在定位问题时才有意义。

改了界面，还要跑真浏览器回归（会顺带产出截图与布局断言）：

```bash
node apps/daemon/dist/main.js --port 7878 --dataDir .tmp/db --workspace .tmp/ws &
python scripts/shoot.py --base http://127.0.0.1:7878
```

改了任何带按钮的页面，再跑一遍交互巡检：它按项目与场景包推导路由，把每个可用控件点一遍，
再走一遍 Tab / Escape / Ctrl+K，有发现就以非 0 退出。

```bash
uv venv .tmp/click-sweep-venv
uv pip install --python .tmp/click-sweep-venv/Scripts/python.exe -r scripts/requirements-click-sweep.txt
.tmp/click-sweep-venv/Scripts/python.exe -m playwright install chromium
.tmp/click-sweep-venv/Scripts/python.exe scripts/click-sweep.py --base http://127.0.0.1:7878
```

Linux/macOS 将 `Scripts/python.exe` 替换为 `bin/python`。若未安装 Playwright，脚本会返回退出码 2 并打印安装命令；浏览器下载失败也保持非零，不会被标记为通过。CI 在 `browser-sweep` job 中安装 Chromium、启动隔离 daemon 数据目录并执行同一命令。

Postgres 集成测试必须连接真实数据库。`pnpm test:postgres` 会自己起一个隔离集群
（Windows 用 `scripts/pg-local.ps1`），跑完自动关闭；起不来就退出码 2，绝不把 skipped 当通过。
已有现成库时可以直接指定：

```bash
pnpm test:postgres                                          # 自动起停
CLOUD_TEST_DATABASE_URL=postgres://... pnpm test:postgres   # 用现成的
```

CI 的 `postgres-integration` job 使用 Postgres 16.4 service 执行 9 个集成用例。

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
- 分支模型是 trunk-based：`main` 是唯一长期分支，改动合并后功能分支即删除。
  版本规则与发布步骤见 [`docs/RELEASING.md`](docs/RELEASING.md)。

## 测试不能靠运气

桌面端的异步断言曾经随机失败：`waitFor` 默认 1000ms 预算在机器负载高时不够。
现在的预算是 5s（`apps/desktop/test/setup.ts`）与单测上限 20s
（`apps/desktop/vitest.config.ts`）。加测试时：

- 用 `waitFor` / `findBy*` 等条件，不要用固定 `sleep`。
- 新测试跑完至少再跑一次全量 `pnpm -r test`，确认不是靠时序偶然通过的。
- 一个能随机失败的测试比没有测试更糟，它会让人习惯忽略红灯。
