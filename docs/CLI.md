# 命令行（`cs`）

CLI 与桌面界面共用同一套 HTTP API，因此本地 daemon 和远程 daemon 都能用。

```bash
pnpm -r build
node apps/cli/dist/main.js <command> [args] [--flags]
# 或 npm link 之后直接：cs <command>
```

## 全局参数

| 参数 | 说明 |
|---|---|
| `--url <base>` | 覆盖默认 `http://127.0.0.1:7878`；也可用环境变量 `CREATOR_STUDIO_URL` |
| `--json` | 输出原始 JSON（`projects` / `health` 支持） |

## 命令

| 命令 | 作用 |
|---|---|
| `health` | daemon 是否在线、apiVersion、能力列表 |
| `projects [q]` | 项目列表；带关键词时按标题/简介/标签过滤 |
| `new <title>` | 建项目；`--platform`、`--desc`、`--tag`（可重复） |
| `show <projectId>` | 详情 + 检查表（JSON） |
| `rm <projectId>` | 软删除 |
| `restore <projectId>` | 恢复软删除 |
| `artifacts <projectId>` | 产物列表 |
| `cat <artifactId>` | 打印产物正文 |
| `gen <projectId> <kind> <context>` | 生成一类产物 |
| `run <projectId> <agent> <message>` | 派活给 Agent 并同步执行 |
| `runs [--status failed]` | 最近运行 |
| `checklist <projectId>` | 检查表；未通过时退出码 1 |
| `publish <projectId>` | 导出发布包，打印绝对路径与文件数 |
| `usage` | 用量与花费 |
| `pipeline <projectId> <context>` | 依次跑选题→资料→脚本→分镜→包装 |
| `version` | 打印 CLI 版本 |

`agent` 取值：`producer`｜`scout`｜`researcher`｜`scriptwriter`｜`director`｜`editor`｜`packager`｜`critic`。
`kind` 取值：`topic-card`｜`research-notes`｜`script`｜`shot-list`｜`publish-pack`｜`review-report`。

## 示例：一次完整的脚本化产出

```bash
export CREATOR_STUDIO_URL=http://127.0.0.1:7878
PID=$(node apps/cli/dist/main.js new "AI 与初级岗位" --platform bilibili | cut -d' ' -f1)
node apps/cli/dist/main.js pipeline "$PID" "AI 编程工具对初级程序员就业的影响"
node apps/cli/dist/main.js publish "$PID"
```

退出码：`0` 成功；`1` 运行失败或检查表未通过；`2` 参数错误。错误码与 daemon 一致（如 `MODEL_BAD_OUTPUT`、`DAEMON_UNREACHABLE`）。
