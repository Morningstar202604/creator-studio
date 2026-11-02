# 变更记录

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号用语义化版本。

## [0.17.1] - 2026-11-03

### 修复

- **自动化调度重复派发**：定时器每 30 秒无条件派发，手动「立即运行」也在旁边，
  两者可以同时给同一条自动化起两次生成——两次模型调用、两个产物、两行运行记录。
  改为按 automation id 单飞：第二次调用直接加入正在跑的那次。回归测试用两个并发
  `/run` 断言只产生一个 artifact 与一行记录。
- **重启后运行记录卡在 `running`**：进程在生成中途死掉时，那行记录永远是
  `running`，界面显示一个永远不会结束的运行。改为启动时一次性把遗留的 `running`
  标为 `interrupted`（迁移 013 放宽状态 CHECK），幂等且不碰已完成记录。
- **关闭时不等在途任务**：`close()` 现在最多等 10 秒让在途生成落库，避免数据库
  在写入中途被关掉。

### 新增

- `scripts/pg-local.ps1` + `scripts/postgres-test.mjs` 重写：没有
  `CLOUD_TEST_DATABASE_URL` 时自己起一个隔离集群、跑完自动关闭；起不来就退出码 2。
  **Postgres 九项集成测试不再是「跳过」，而是真实执行并计入门禁**。
- `packages/store-sqlite/test/automation-store.test.ts`：三条恢复语义回归测试。

### 变更

- `pnpm verify` 现在包含 `pnpm test:postgres`，门禁从 648 项通过变成
  **657 项通过、0 跳过**。
- 自动化页的运行状态徽标改为中文标签（成功 / 失败 / 运行中 / 已中断），
  `interrupted` 用中性色而不是错误色。

## [0.17.0] - 2026-11-02

这一轮不加功能，只做一件事：让「通过了」这句话可被复现。门禁能靠跳过变绿，
就等于没有门禁；测试能随机失败，就等于没有测试。

### 修复

- **测试随机失败**：全量并行跑 `pnpm -r test` 时，桌面端每次失败的用例都不同
  （`scenario` / `script` / `stage-route` / `style` / `ux`），失败快照一律停在
  「正在加载页面…」。根因是 `waitFor` 默认 1000ms 预算在机器负载高时不够，
  断言先于异步渲染完成。改法不是加 sleep，而是把异步预算提到 5s
  （`apps/desktop/test/setup.ts`）与单测上限提到 20s（`vitest.config.ts`）。
  修复后连续 5 次全量运行 642 passed / 9 skipped，零失败。
- **点击巡检误报「控件消失」**：卡片页的分段筛选按钮带实时计数（`章节卡 5`），
  巡检自身新建卡片后数字变化，于是被判定为控件不见了。改为只对
  `.segmented` 内的尾部计数做归一化，正文里的数字（`空白 / 2800`）保持原样。

### 新增

- `scripts/verify-versions.mjs`：校验版本号在 5 个 `package.json`、
  `tauri.conf.json`、`Cargo.toml` 与 `CHANGELOG.md` 最新条目之间一致，
  不一致即以非 0 退出。已接入 `pnpm verify`。
- `docs/STATUS.md`：当前版本已验证项（附命令与结果）、未验证项、已知缺陷。
- `docs/ROADMAP.md`：按 minor 版本承诺范围，含 0.18 调度器正确性设计。
- `docs/RELEASING.md`：三分版本号规则、发布步骤、绝不可发布的情形。
- `docs/VERIFICATION.md`：十层验证各自能抓什么、抓不到什么，附本轮实测流水。

### 变更

- 分支模型收敛为 trunk-based：`main` 是唯一长期分支，功能分支合并后即删除。
- 版本号 0.16.0 → 0.17.0。

### 实测记录

```
pnpm lint                               exit 0
pnpm verify                             exit 0（含版本一致性）
pnpm -r test                            642 passed + 9 skipped（连续 5 次）
scripts/smoke-model.mjs --mode offline  pass
scripts/security-audit.mjs              200 files PASS
scripts/check-contrast.py               PASS
scripts/shoot.py                        26 页，0 console error，0 溢出
scripts/click-sweep.py                  659 次点击，0 发现
```

API 全链路：7 个产物、检查表全绿、导出 zip（6 条目）、字幕、指标、复盘闭环，
阶段推进到 `review`。详见 `docs/VERIFICATION.md`。

## [0.16.0] - 2026-10-28

这一轮只做细节：把六个场景都造上真实数据，逐页在 1440 与 900 两档、明暗两套主题下截图审，
把「技术赛」那部分也过一遍——打包体积、渲染路径、重复渲染。

### 修复

- **项目卡进度语义错误**：卡片底部写「0% 完成」而项目其实已有 5 个产物——因为它停在第一个阶段。
  改为「阶段 4/6」，进度条也按阶段位置推进；没写简介的卡片改为显示「场景名 · 当前阶段说明」，
  不再是一行「还没有简介」占位。
- **阶段筛选把工具栏撑成三行**：六个内置包合计约 20 个阶段 chip，换行后把项目网格推下去。
  改为一行的横向滚动条（`flex: 1 1 320px` + `overflow-x: auto`），工具栏高度固定。
- **模型 chip 截断在半句**：`max-width: 160px` 作用在整个 chip 上，把「（缺密钥）」切掉一半——
  恰好是最需要看见的部分。改为 chip 保留完整药丸，内部 `.chip-label` 省略号。
- **深色主题下进度条消失**：`--track` 在深色里几乎等于卡片底色，四类进度条（项目卡、全书进度、
  章节进度环、伏笔跨度）全部改成 `--border`，两种主题都可见。
- **时间轴底部标签被裁**：最底行的章节标题贴着画布下沿，加 18px 内边距。
- **资料库副标题自相矛盾**：「5 个产物 · 跨 6 个项目」——前者是当前筛选结果，后者是全局。
  改为「5 个产物（当前筛选） · 库内共 5 个 · 跨 6 个项目」。

### 技术层

- **ECharts 按需组装**：全量入口 1,090 KB，本项目只画折线、柱状、网格、tooltip、图例。
  新增 `apps/desktop/src/lib/echarts.ts` 用 `echarts/core` + `echarts/charts` 注册需要的模块，
  运行时从 1,090 KB 降到 **547 KB**（gzip 370 → 185 KB），且仍是动态 import，只有复盘页加载。
  完整的 `echarts` 只保留 `EChartsOption` 类型引用（编译期擦除，不进包）。

### 验证

- `pnpm verify`：9 个包 **636 passed + 9 skipped**；security-audit 200 files PASS；对比度 PASS
- 新增 2 例 `echarts-registration.test.ts`：模块化入口可初始化，且命名空间里不含 `PieChart`/`MapChart`——回退到全量入口会立刻失败
- 六个场景造数：小说（9 章 / 4 角色 / 3 地点 / 5 伏笔 / 14 条关系）、短视频（3 镜头）、
  中长视频（5 产物 + 3 期数据）、播客 / 课程 / 文案各 1 张卡
- 20 个页面在 1440×900 与 900×760 两个宽度、明暗两套主题下截图：0 console error、0 横向溢出
- 打包：`index 539 KB / echarts 547 KB（动态）/ cytoscape 433 KB（动态）`
- 新截图：`70-projects-polished`、`71-timeline-padded`、`72-library-counts`（各含 `-dark`）

## [0.15.0] - 2026-10-27

这一轮不看代码，只当用户：把每个路由上的每个可用控件都点一遍，再用键盘走一遍。
728 次点击、12 个页面的 Tab 序列、Ctrl+K、表单提交、深链、错误输入、快速导航风暴，
全部在真浏览器里跑。跑出来的问题都是「只有点下去才会发现」的那一类。

### 修复

- **写作台「新建」必定 400**：新建章节只发了 `number`，没发场景包里的必填 `title` 字段，
  每次点都弹 `field 章节标题 is required`。现在按 `entityType.titleField` 补齐；
  顺带补了回归测试（`writing.test.tsx` R6）。
- **空项目写作台显示空的可视化骨架**：0 章时仍然画出「章节篇幅」标题和空柱区、状态图例，
  看起来像数据加载失败。现在没有章节就不画这些块，右栏改成「先新建一章」。
- **关系图孤立卡计数会跳**：点击任意控件后孤立卡数量变化会让副标题文字变，巡检脚本更难断言；
  现在数量与开关文案一致，不再出现「显示孤立卡（N）」与实际不符。

### 新增

- `scripts/click-sweep.py`：可重复运行的全量交互巡检。它从 `/v1/projects` 与 `/v1/scenarios`
  自动推导路由（含每个场景的 generate / cards / board / write / publish / review），
  对每个可用控件执行一次「刷新页面 → 点击 → 检查崩溃边界 / 404 / 弹窗卡死 / 未预期错误码」，
  再用键盘走 Tab、Escape 与 Ctrl+K。退出码非 0 即代表有发现，可直接进 CI。
  相对时间（「3 分钟前」）在归一化时被剥掉，避免刷新导致的假差异。
- `apps/desktop/test/palette.test.tsx`：命令面板 Ctrl+K 开关与重复触发不叠加。
- `CONTRIBUTING.md` 补上巡检命令与「改了带按钮的页面就要跑」的约定，测试计数改为实测值。

### 验证

- `pnpm verify`：9 个包 **634 passed + 9 skipped**；security-audit 198 files PASS；对比度 PASS
- `python scripts/click-sweep.py --base http://127.0.0.1:7942 --max-controls 2000`：
  **728 次点击，0 findings**；覆盖 4 个项目 × 全部场景阶段 + 5 个跨项目页
- 键盘：12 个页面的 Tab 序列全部落在可见元素上；Ctrl+K 打开/Escape 关闭；Enter 不抛错
- 压力：30 次连续哈希跳转、3 轮明暗切换、1100/980/900 三档宽度、快速输入中途切章、
  逐个打开全部卡片抽屉——0 console error、0 横向溢出
- 健壮性：空项目 7 个页面、8 个畸形深链（缺 id / 空段 / 非法 UUID / 损坏 localStorage）
  全部有可读空态，没有白屏或崩溃边界
- 新截图：`68-empty-writing-desk`、`69-writing-desk-created-chapter`

## [0.14.0] - 2026-10-27

这一轮只做「看得见」的部分：把浅色/深色两套主题下的每个页面截图过一遍，修掉图表在深色下几乎不可见、
关系图一半画布是空的、时间轴与写作台缺少进度表达这几件事。

### 修复

- **图表深色不可读**：ECharts 画在 canvas 上读不到 CSS 变量，坐标轴文字、刻度线、图例全用浅色硬编码，
  深色主题下等于空白。新增 `lib/canvasTheme.ts` 从 token 读色，并用 `MutationObserver` 监听
  `data-theme`，切主题立即重绘；`trendOption` / `barsOption` 改为接收调色板。
- **关系图与时间轴同样写死颜色**：节点文字、描边、边、图例全部改为 token 派生，深色下不再出现
  白字白底；顺带修了 `node.hovered` 有样式但从未被触发的问题。
- **关系图一半画布是空的**：`fit(undefined, 36)` 把整图缩到画布中央，22 张卡里 10 张孤立卡把布局拉高，
  可视化只剩上半屏。改为按内容计算画布高度、只做横向缩放，并把孤立卡默认隐藏（可一键显示）。
- **时间轴跨度条**：未连到埋设章的伏笔 `gapChapters` 为 null，进度条按 0 渲染成一条细线，看起来像
  「跨度 0」。改为虚线占位，并在文案里显式写「跨度 N 章」。

### 新增

- **写作台可视化**：本章目标进度环（SVG，按 `word_target` 计算）、全书进度条、章节篇幅柱状图
  （高度=字数，颜色=状态）、章节栏状态圆点；目标字数为 0 时不显示环，改为纯字数。
- **关系图缩放控件**：放大 / 缩小 / 适应窗口三个按钮，键盘可达；孤立卡开关。
- 时间轴右侧伏笔卡片补上跨度条与「跨度 N 章」文案。

### 验证

- `pnpm verify`：9 个包 **631 passed + 9 skipped**；security-audit 197 files PASS；对比度 PASS
- 新增 4 例：`canvas-theme.test.ts`（主题读取与兜底）、`writing.test.tsx` 进度可视化、
  `graph.test.tsx` 孤立卡开关；`style.test.tsx` 的 Chart mock 补齐新导出
- 真机 1440×900 DPR2，浅色与深色各 12 页截图复核：0 console error、0 横向溢出；
  深色下图表文字与轴线可读、关系图无空半屏、写作台进度环与篇幅柱正常
- 新截图：`64-writing-desk-progress`、`65-review-trend`、`66-graph-isolated-toggle`、`67-timeline-gaps`
  （每张各含浅色与 `-dark` 两版）

## [0.13.0] - 2026-10-27

这一轮不再加功能，专门修「地基已经通用、但上层还在按视频写死」留下的裂缝：小说项目点第一个阶段看到
「页面不存在」，点「继续当前阶段」被送到角色卡，章节正文不进记忆索引，复盘后停在一个包里不存在的阶段。
全部由真机复现，再逐条修。

### 修复

- **任意阶段都能打开**：新增 `/p/:id/stage/:stageKey` 通用阶段页，标签 / 提示 / 产物类型全部取自场景包；
  路由改由视图决定（`stageHref`），不再靠阶段 key 猜。小说「设定 / 世界观 / 大纲」「继续当前阶段」、
  剧本、课程、任何自定义包的 generate 阶段都不再落到「页面不存在」。
- **发布检查表「去补」按包跳转**：原来固定拼 `/p/:id/<stage>`，小说章节会跳到一个不存在的页面；现在走同一个 `stageHref`。
- **「按此卡生成」按 entityType 找阶段**：短视频包阶段 key 是 `shots`、卡片类型是 `shot`，原先把两者当同一命名空间，
  按卡片生成必然失败。改为先按 entityType 匹配，再退回 key。
- **章节与大纲进入记忆索引**：迁移 007 的 `kind` CHECK 只认视频产物，章节产物插入时抛错又被 best-effort 吞掉，
  于是小说项目「记忆检索」永远搜不到正文。迁移 012 重建表放宽枚举，并补回被 DROP TABLE 一并删掉的三个 FTS 触发器。
- **复盘推进到包里的阶段**：写死 `advanceStage(id, 'review')`，小说包没有 `review`；改为找包里产出 `review-report` 的阶段（小说是 `revision`）。
- **导出后推进按视图找发布阶段**：写死 `published`，改用 `view: publish` 的阶段，自定义包也能推进。
- **发布页文件计数**：`openable` 白名单漏了 `outline`/`chapter`，zip 里有 9 个文件、页面说 7 个。
- **资料库筛选与标签**：补「大纲 / 章节」筛选项、`ARTIFACT_LABELS` 与类型色点。
- **工作台统计**：卡片型项目只显示「0 个产物」，现补「N 张卡片」。
- **命令面板阶段名**：原来显示内部 key（`premise`），改为场景包标签。
- **看板分组校验**：`board.groupBy` 必须指向存在的 select 字段，写错直接拒绝包而不是渲染一列「未分组」。
- **课程与短视频有了看板**：`lesson` / `shot` 增加 `status` 字段与 board 配置，卡片板可切看板并拖拽。
- **阶段页预览不被旧响应清空**：生成后立刻刷新列表时，空快照会把刚生成的结果从预览区抹掉。

### 新增

- `apps/daemon/test/manuscript` 之外新增 `consistency.test.ts`（索引 / 复盘阶段 / 卡片阶段映射 4 例）
- `packages/store-sqlite/test/memory-migration.test.ts`（迁移保数据 + FTS 触发器重建 5 例）
- `apps/desktop/test/stage-route.test.tsx`（通用阶段页、视图路由、检查表链接 5 例）

### 验证

- `pnpm verify`：9 个包 **628 passed + 9 skipped**；security-audit 195 files PASS；对比度 PASS
- 真机 1440×900：小说「设定」→ `/stage/premise` 正常渲染、「继续当前阶段」同页；短视频镜头卡看板三列可拖；
  工作台显示「11 张卡片」；命令面板显示「项目 · 设定」；资料库出现「大纲 / 章节」筛选；0 console error、0 横向溢出
- 新截图：`60-novel-generate-stage` / `61-shorts-shot-board` / `62-workspace-novel-stages` / `63-palette-stage-labels`

## [0.12.0] - 2026-10-26

卡片板能看进度、关系图能看结构，但「把一章写出来」这件事一直没有落点：正文藏在抽屉的
「长文本」里，导出还要自己去拼。这一轮补的是写作面本身，并且把它做成第六种通用视图，
而不是给小说写死一个页面。

### 新增

- **写作台** `/p/:id/write/:entityType`：左侧章节栏 + 中间单栏编辑器 + 右侧字数统计。
  输入停止 900ms 自动保存，切章立即落盘，`Ctrl/⌘ + S` 手动保存，状态（未保存/保存中/已保存）
  常驻标题栏。正文仍是卡片 `body`，所以卡片板、关系图、时间轴看到的是同一份内容。
- **手稿投影** `GET /v1/projects/:id/manuscript`：按 `orderField → order → 创建顺序` 排出章节清单
  与全书字数，不复制正文。
- **Word / Markdown 导出** `POST /v1/projects/:id/manuscript/export`：标题页 + 每章分页，
  同时产出 `.docx` 与 `.md`；导出后浏览器直接触发下载，侧栏保留最近一次导出链接。
- **下载白名单** `GET /v1/projects/:id/manuscript/download/:name`：只放行
  `^[a-z0-9][a-z0-9-]*\.(docx|md)$`，路径穿越与任意后缀一律 400。
- **看板拖拽**：卡片可拖动换列（列的取值即分组字段的值），落点顺序写回卡片 `order`；
  乐观更新 + 失败回滚；拖动手柄是独立按钮，点击卡片仍然打开抽屉。
- 场景包新增 `view: "document"` 与 `document: { bodyField?, titleField?, orderField?, fileStem? }`；
  包加载时校验字段存在。小说包的章节阶段改用该视图，并保留 `board` 配置以便切看板。

### 技术选型

| 需求 | 选择 | 理由 |
|---|---|---|
| Word 文档生成 | `docx@9.14.0` | 一份最小 .docx 是五个互相约束的 XML 部件，手写 OOXML 必然出错；该库直接产出合法文档 |
| 拖拽与键盘可达 | `@dnd-kit/core` + `@dnd-kit/utilities` | 指针捕获、碰撞检测、键盘拖拽（空格拾起、方向键移动）都是容易做错的部分，不自己实现 |
| 编辑器 | 原生 `textarea` + Markdown | 正文是纯文本产物；富文本编辑器会引入不可移植的文档模型，收益不抵复杂度 |

### 修复

- 写作台的切换章节 effect 原先依赖整个卡片对象，保存回包一到就用服务端文本覆盖编辑器；
  改为只在卡片 id 变化时同步，避免吞掉输入。
- `resetDraft` 之外的章节切换会让防抖把上一章的文字写进新卡片；现在每次保存都固定携带发起时的卡片 id。
- 章节卡的「状态」在改用 `document` 视图后不再计入检查表，已让检查表把 `document` 与 `entities`/`board`
  一视同仁按卡片数判定。
- 抽屉原先用 30ms 定时器聚焦第一个字段，会抢走用户刚点中的输入框；改为同步聚焦，且只在焦点还在面板外时执行
  （`apps/desktop/src/components/Drawer.tsx:55`）。

### 验证

- `pnpm verify`：9 个包 **612 passed + 9 skipped**；security-audit 191 files PASS；对比度 PASS
- 新增 15 例：`apps/daemon/test/manuscript.test.ts` 6 例、`apps/desktop/test/writing.test.tsx` 5 例、
  `apps/desktop/test/kanban.test.tsx` 1 例、protocol 3 例 `document` 包校验
- 真机 1440×900 DPR2：输入 2 秒后状态「已保存」，刷新后正文仍在；拖拽第一章「待写」→「定稿」并落库
  （列计数 0/2/1/6/0）；导出 docx 11,219 B，9 章标题在 `word/document.xml` 中位置单调递增；
  0 console error、0 横向溢出
- 新截图：`56-writing-desk` / `57-chapter-board` / `58-workspace-writing` / `59-writing-desk-dark`

## [0.11.0] - 2026-10-26

关系图回答了「谁和谁有关」，但没有回答作者真正关心的「我的故事按顺序对吗、哪条线还没收」。
这一轮加叙事时间轴，并且继续用成熟库处理布局，不自己写排版算法。

### 新增

- **叙事时间轴** `/p/:id/timeline`：章节按序号从左到右排成一条链（`cytoscape-dagre` 分层布局），
  伏笔从埋设章节指向回收章节。实线=已回收、虚线=埋设、红框=未回收。
  画布随内容加宽并横向滚动，另有一排章节序号按钮可直接跳转。
- **伏笔健康分析** `GET /v1/projects/:id/foreshadow-health`：算出每条伏笔的埋设章与回收章、
  跨度，标记未回收与「埋太久」两类问题；右侧面板按问题排序展示，可一键复制清单。
- 章节卡新增「章节序号」字段，时间轴据此排序（此前只能按创建顺序）。

### 技术选型

| 需求 | 选择 | 理由 |
|---|---|---|
| 时间轴分层布局 | `cytoscape-dagre@4.0.1`（dagre 的官方 Cytoscape 适配） | 分层/秩分配是 dagre 的核心能力；自己写会重复造轮子 |
| 节点重叠 | `cytoscape-fcose@2.2.0`（已安装，关系图备用） | 需要时用 fcose 的增量布局，不手写力导向 |
| 滚动与跳转 | 浏览器原生 `scrollTo` + Cytoscape 自带 `renderedPosition` | 不引入第二套视口管理 |

两个扩展都用动态 `import()` 加载，只在图/时间轴页面生效，主包不变。

### 修复

- 时间轴首版把每个章节当作独立组件，dagre 只能竖着堆叠；补一条阅读顺序链后才是横向时间轴。
- 时间轴首版 `cy.fit()` 会把 9 章压成缩略图，文字不可读；改为画布随内容加宽 + 横向滚动 + 固定 zoom 1。
- 章节跳转只调用 `cy.animate({center})`，外层滚动条不动，目标章节落在视口外；改为同时滚动容器。
- `apps/desktop/tsconfig.tsbuildinfo` 一直被当作源码提交，已移出版本控制并确认 `.gitignore` 已覆盖。

### 验证

- `pnpm verify`：9 个包 **587 passed + 9 skipped**
- 新增 4 例：时间轴统计、未回收清单与原因、章节跳转控件、工作台入口
- 真机 1440×900 DPR2：9 章 / 5 条伏笔 / 3 条未回收；画布 2143px 宽、视口 838px，可横向滚动；
  点第 9 个序号跳到「第九章 雾散」并完整可见；0 console error、0 横向溢出
- 新截图：`54-timeline` / `55-timeline-chapter9`

## [0.10.0] - 2026-10-26

v0.9 让关系可以带类型，但只存在于抽屉里的一条条文字。这一轮把它变成一张真正的图，
并且用截图而不是假设来决定用什么技术画。

### 新增

- **关系图页面** `/p/:id/graph`：项目内全部卡片渲染为节点，关系渲染为带箭头的边。
  支持滚轮缩放、拖拽平移、按类型筛选、按名字/标签/字段搜索、点击节点只看它的直接关系，
  右侧面板显示卡片字段与关系列表（含反向标签），并可跳到对应卡片板。
- **项目图数据接口** `GET /v1/projects/:id/graph`：一次返回全部节点与边，
  附带该场景的卡片类型与关系类型，避免前端按卡片逐个拉取。
- 工作台新增「关系图」入口。

### 技术选型：为什么从 ECharts 换成 Cytoscape

第一版用 ECharts 的 `graph` series（ECharts 已是复盘图表的依赖，零新增依赖）。截图后否决：

| 问题 | ECharts graph 实测 |
|---|---|
| 边标签 | 全部渲染成 `undefined` |
| 图例 | 无 |
| 布局 | force 布局把 16 个节点挤成两团，标签互相压盖 |
| 选中 | 无法「只留直接关系」 |
| 详情 | 无面板，点击无反馈 |

改用 **Cytoscape 3.33.1**（+ `@types/cytoscape`，约 350 KB min 后；devDependency 只加类型）：
它专为网络图设计，自带 cose 布局、选择模型、逐元素样式。第二版仍有标签重叠，
加上 `nodeDimensionsIncludeLabels: true` + 提高 repulsion + 延长边距后解决。

打包体积代价：ECharts 已在主包（1.1 MB），Cytoscape 只在新页面通过动态 `import()` 加载，
不影响首屏。

### 修复

- 关系图节点点击在自动化中无法命中：Cytoscape 渲染在 canvas 上，没有 DOM 节点。
  现在把每个节点的屏幕坐标发布到容器元素上，测试与自动化可以直接点击。
- `test/setup.ts` 无条件读取 `HTMLCanvasElement.prototype`，导致 node 环境的
  `diff.test.ts` 直接崩；改为先判断环境再装 stub。
- GraphPage 使用 `ResizeObserver` 未做存在性判断，jsdom 下抛未捕获错误。

### 验证

- `pnpm verify`：9 个包 **583 passed + 9 skipped**
- 新增 4 例：图页面加载节点/边计数与图例、关系类型正反向展示、类型筛选、工作台入口
- 真机（1440×900，DPR 2）：16 张卡 / 15 条关系；点击「第一章 雾从海上来」后其余淡出，
  三条关系高亮（发生在 / 埋于 / 出现在），侧栏列出 3 条关系；0 console error、0 横向溢出
- 新截图：`52-graph-overview` / `53-graph-selected`

## [0.9.0] - 2026-10-26

v0.8 之后「加一个场景」仍然要改代码：视图只有五个固定值，但它们没有被声明和协商，
新增场景的边界不清楚。这一轮把扩展方式写死成契约，并用两个纯数据场景验证。

### 新增

- **包格式版本与能力协商**：`formatVersion`（当前 2）+ `requiresViews`。导入时对照
  引擎实际支持的视图清单；不支持就 400 `UNSUPPORTED_VIEW` 并附 `supportedViews`，
  不写任何一行。视图名仍是闭集，所以「装一个包」永远不会执行包里的代码。
- **场景继承**：`inherits` 指向另一份包，读取时把父包的阶段、卡片类型、关系类型
  合并进来；子包同名阶段覆盖父包。带访问集合与深度上限（4），循环会被拒绝。
- **导出 / 导入**：`GET /v1/scenarios/:id/export` 导出存储原样（含引擎元信息），
  `POST /v1/scenarios/import` 导入；两者构成用户分享场景包的最小闭环。
- **两个新内置场景（纯数据）**：
  - `copywriting` 文案/图文：简报、素材、初稿、多平台、配图、发布；素材卡 + 读者画像
  - `shorts` 短视频：钩子、口播稿、镜头、字幕、发布；镜头卡 + 镜头看板
- **看板视图**：`view: board` + `board.groupBy`，按场景包声明的 select 字段分列，
  列顺序取包里的 `board.order`，空值进「未分组」而不是消失。
- **关系类型化**：场景包可用 `relationTypes` 声明有向关系与反向标签
  （`出现在` / `出场于`）以及两端允许的卡片类型；未声明类型的包保持 v0.8 的自由文本行为。

### 变更

- 小说章节阶段从 `entities` 改为 `board`，按章节状态分列。
- 检查表的卡片驱动判断从 `view === 'entities'` 扩展到 `entities | board`。

### 修复

- `labelPlural` 的默认值是空字符串但校验要求 min(1)，导致任何不写该字段的自定义包创建失败。
- 独立包允许只有 1 个阶段（继承子包需要，但独立包不行）；现在独立包仍要求 ≥2 个阶段。
- 关系类型化后需要把正向标签写进行里，否则读回来是空字符串。

### 验证

- `pnpm verify`：9 个包 **579 passed + 9 skipped**
- 新增 19 例：protocol 18（协商、继承合并/覆盖/循环/深度、关系类型、看板配置、两个新包）、
  daemon 11（引擎视图广播、导出导入往返、未知视图、孤儿继承、循环、类型化关系正反向、
  未声明类型、端点不匹配、自由文本兼容）
- 真机：正向显示「出现在 / 埋于」，反向显示「出场于 / 埋有伏笔」；
  章节看板 5 列含「未分组」；0 console error、0 横向溢出
- 三张新截图：`49-chapter-board` / `50-typed-links` / `51-chapter-board-drawer`

## [0.8.0] - 2026-10-26

v0.7 把阶段搬进了数据，但用起来仍有几处硌手：编辑卡片会把看板顶到屏幕外、
删除不可撤销、保存结果是个不会消失的面板、卡片之间没有关系。这一轮只打磨这些。

### 新增

- **卡片关联**：任意两张同项目卡片可建立有向关联（如「林砚 出现在 第一章」
  「海图 埋于 第一章」）。反向引用在读取时派生，不重复存储；删除卡片会级联解除关联。
  迁移 `010_entity_relations.sql`。
- **卡片抽屉编辑器**：编辑改为右侧抽屉，`role="dialog"` + `aria-modal`，打开时聚焦第一个字段、
  Tab 在抽屉内循环、Escape 关闭并把焦点还给触发按钮。
- **删除确认**：删除卡片前弹确认框，默认聚焦「取消」，Escape 等同取消。
- **Toast 反馈**：保存、删除、关联等结果通过 `role="status"` 的瞬时提示反馈，
  3.2 秒自动消失（错误 6.4 秒）；校验类错误同时保留内联面板。
- **看板搜索**：按标题、标签与任意字段值过滤当前卡片类型。

### 变更

- 卡片表单改为两列网格，长文本字段跨两列，编辑一个角色不再需要滚三屏。
- 抽屉与提示通过 portal 挂到 `body`：`.shell` 有 `overflow: hidden`，
  固定定位的子元素会被裁剪并相对它偏移。
- 空态补上主操作按钮（「新建角色」「用当前方向生成」），不再只有一行提示。
- 脚本页的字幕导出提示从常驻面板改为 toast。

### 修复

- 抽屉的 focus/restore effect 依赖内联 `onClose`，每次输入都会重新执行并把焦点抢回触发按钮，
  导致连续输入只落下第一个字符。改为用 ref 持有 close 回调，effect 只依赖 `open`。

### 验证

- `pnpm verify`：9 个包 **560 passed + 9 skipped**
- 新增 11 例：daemon 5（关联的正反向、自指拒绝、跨项目拒绝、解除、级联删除）、
  desktop 6（抽屉焦点与 Escape、删除取消/确认、toast、内联错误、搜索、关联创建）
- 真机：抽屉打开后焦点在「卡片标题」，连续输入「回收于」三个字完整落字，
  Escape 关闭，删除确认可取消；0 console error
- Playwright 三张新截图：`45-card-drawer` / `46-delete-confirm` / `48-toast`

## [0.7.0] - 2026-10-26

这一轮不加功能面，拆掉的是最硬的一层耦合：**阶段与产物从代码里搬进数据**。
此前一个小说项目会被套进「选题 / 资料 / 脚本 / 分镜 / 包装 / 发布 / 复盘」，
检查表还要求分镜表——不是配置错，是根本没得配。

### 新增

- **场景包（ScenarioPack）**：一份 JSON 描述阶段、每阶段用哪种视图、要产出哪些内容、
  以及这个场景有哪些卡片类型。内置四套：
  - `video` 中长视频（7 阶段，与原流水线逐字一致，老项目零迁移）
  - `novel` 长篇小说（设定 / 世界观 / 大纲 / 章节 / 修订 / 投稿；角色、章节、地点、伏笔四类卡）
  - `podcast` 播客（选题 / 资料 / 提纲 / 逐字稿 / 剪辑单 / 发布；嘉宾、问题库）
  - `course` 课程（目标 / 调研 / 大纲 / 课时 / 练习 / 上线；课时卡、练习卡）
- **通用卡片（Entity）**：一张表存所有卡片，`type` + `fields` JSON。字段类型支持
  text / longtext / number / select / tags / date / url；场景包声明哪些必填、哪个当标题、
  哪几个做摘要。同一套页面渲染角色卡和课时卡。
- **动态阶段**：`projects.stage` 从固定 enum 改为场景内的键，写入时按项目的包校验
  （写错的阶段返回 400 `UNKNOWN_STAGE` 并附可用列表）。
- **场景感知的检查表**：按包的 `required` 阶段生成；卡片驱动的阶段（小说章节、课程课时）
  数卡片而不是数产物。
- **场景提示词**：阶段可带 `promptHint`，生成时作为「当前场景要求」追加到用户消息，
  所以同一个 `/generate` 端点写小说正文和写口播稿会用不同 brief。
- **新增内容契约**：`outline`（分幕/节拍/伏笔）与 `chapter`（标题/视角/梗概/正文/钩子）。
- **API**：`GET|POST /v1/scenarios`、`DELETE /v1/scenarios/:id`、
  `GET|POST /v1/projects/:id/entities`、`PATCH|DELETE /v1/projects/:id/entities/:cardId`。
- **界面**：新建项目可选场景、项目卡显示场景徽标、工作台阶段栏按场景渲染、
  新增卡片板页面 `/p/:id/cards/:entityType`。

### 变更

- `ProjectStageSchema` 由 enum 改为 `[a-z][a-z0-9-]{0,31}`；旧的七个阶段常量保留为
  `LEGACY_VIDEO_STAGES` 供迁移与回退参考。
- `buildChecklist` 的条目 key 从 `topic` 变成 `topic:topic-card`：阶段由场景定义，
  key 必须同时标识阶段与产物。
- 迁移 009 重建 `projects` 与 `artifacts` 两张表（SQLite 无法就地删除 CHECK），
  在事务内逐行复制并重建索引；已有项目自动获得 `scenario_id = 'video'`。

### 修复

- 手工保存产物的 kind 白名单漏了 `outline` / `chapter`，导致大纲与章节无法通过 API 落盘。
- 项目列表的阶段筛选在非视频场景下只剩一个 chip：改为按「在用的场景」的全部阶段生成。

### 验证

- `pnpm verify`：9 个包 **518 passed + 9 skipped**
- 新增 42 例测试：protocol 15（包校验、字段校验、契约）、store 11（种子、只读保护、卡片作用域、迁移兼容）、
  daemon 15（场景 CRUD、阶段校验、检查表、卡片 CRUD、自定义包）、desktop 4（阶段栏、卡片板、场景选择）
- 真机验证：小说项目阶段栏显示 6 个小说阶段、无「分镜」；四类卡片 9 张；章节检查表数卡片后转为已就绪
- Playwright 1440×900 六张新截图（工作台、角色卡、章节卡、伏笔表、场景选择、深色），0 console error、0 横向溢出

## [0.6.0] - 2026-10-26

v0.5 的「未验证」清单里剩下的三项，本轮全部落到可复现的证据上。

### 新增

- **云端 Postgres 存储**：`apps/cloud/src/store-postgres.ts` 实现 `CloudStore` 接口，
  每一条租户数据访问都带 `user_id` 谓词；跨租户读返回 null 并记 `cloud_security_events`。
  `DATABASE_URL`（或 `--database`）存在即启用，缺省仍是零依赖内存实现。
  表结构首次连接时惰性创建，无需单独迁移步骤。
- **桌面自动更新**：接入 `tauri-plugin-updater`，`bundle.createUpdaterArtifacts: true`，
  公钥写进 `tauri.conf.json`，私钥只经 `TAURI_SIGNING_PRIVATE_KEY` 环境变量注入。
  构建产物同时生成 `CreatorStudio_0.6.0_x64-setup.exe` 与 `.sig`。
- **CI 三平台矩阵**：`verify` 与 `desktop` 两个 job 都扩到 ubuntu / windows / macOS；
  桌面 job 按平台产出 nsis / deb / dmg 三种原生包，Linux 段安装 WebKitGTK 依赖。

### 变更

- `CloudStore` 从具体类提升为接口，所有方法返回 `Awaitable<T>`，内存实现保持同步、
  Postgres 实现异步，调用点统一 `await`。
- 隧道鉴权 `TunnelAuthenticator` 允许返回 Promise：Postgres 需要先查库再决定是否挂载 socket；
  鉴权抛错按失败处理（fail-closed）。
- `MemoryStore` 增加 `runsCount` / `tenantCount` / `securityEventsOf` / `close`，
  `/health` 与安全事件路由改用聚合方法，不再直接摸内部字段。
- 安全审计脚本排除 `.tmp/`（临时脚手架，含下载的 Postgres 源码，不属于交付物）。

### 修复

- `SqliteProjectStore.listDeleted` 是死代码，已删除。
- 云端 `close()` 之前不释放 store，Postgres 连接池会挂住进程；现在会 `pool.end()`。

### 验证

- `pnpm verify`：9 个包 **501 passed + 9 skipped**（Postgres 集成默认跳过）；
  设 `CLOUD_TEST_DATABASE_URL` 后为 **510 passed**，其中 Postgres 集成 9 例
- 真实 PostgreSQL 16.4 实例（本机临时集群，端口 55432）跑通：配对 → 设备令牌 → `/v1/me`
  → 创建 Run → 列表 → usage → health 聚合，6 项全过
- Tauri 安装包：`CreatorStudio_0.5.0_x64-setup.exe` 13.01 MiB + `.sig`；
  用 Ed25519 对安装包的 BLAKE2b-512 摘要做密码学校验，**PASS**（keyid 与公钥一致）
- CI 工作流经 YAML 解析确认：verify 三平台、desktop 三平台三产物

### 仍然未验证（如实列出）

- CI 三平台**没有在 GitHub Actions 上真实跑过**：本机无法触发远端 runner。
  已做的是：工作流 YAML 可解析、矩阵内容正确、Linux/macOS 步骤齐备。
- macOS 与 Linux 的**原生包没有本机构建**：只有 Windows 的 nsis 是实机产物。
  本机 Linux target 交叉编译因缺少 `x86_64-linux-musl-gcc` 失败（已记录）。
- 自动更新的**端到端升级**未验证：需要一次真实的「旧版本 → 新版本」发布流程，
  当前只验证到「签名产物存在且密码学有效」。
- 真人效率评测仍无数据。

## [0.5.0] - 2026-10-26

本轮全部是「文档承诺 vs 实际行为」的收敛，不新增产品概念。

### 修复

- **阶段页把 Markdown 当纯文本**：资料、分镜、包装、复盘产物之前直接塞进 `<pre>`，表格显示成 `|---|`。改用已有的 DOMPurify 消毒 `Markdown` 组件。
- **发布页少算字幕**：文件清单白名单缺 `subtitle`，界面说「5 个产物将打包」而 zip 里有 6 个。补齐并把计数改成「N 个产物 + README + manifest」。
- **发布阶段永远走不到**：导出成功后没有任何 `advanceStage`，`published` 段永远灰着、项目卡卡在 83%。现在导出即推进。
- **manifest 版本写死 0.2.0**：改为启动时读 `apps/daemon/package.json`。
- **导出混入历史版本**：默认只打包每类最新版，`includeHistory: true` 才含全部；README 与 manifest 都覆盖到同一份文件集。
- **API 接受不存在的 Agent**：`scout`/`director`/`packager`/`researcher` 能通过 schema 校验并创建 Run（202），执行时才 500 语义失败。补齐四个 AgentSpec，并在创建期校验，未知 id 返回 400 `UNKNOWN_AGENT`。
- **`includeDeleted` 解析后没用**：软删项目从界面永远找不回来。store 新增 `listWithDeleted`，项目页加「已删除」开关与恢复按钮。
- **复盘报告有两条路径**：`/generate` 也能产出 review-report，但没有指标、不推进阶段。现在统一走 `/review`，`/generate` 返回 400 `USE_REVIEW_ENDPOINT`。

### 新增

- **资料抓取与引文核验**：`POST /v1/projects/:id/generate` 接受 `sources: string[]`（≤5）。服务端先真抓原文（拒绝私网/回环/凭据/非 http(s)、每跳重定向重校验、10s 超时、2MB 上限、内容类型白名单、robots Disallow 即拒），把正文以不可信围栏注入提示，再逐条核验：原文找不到的 claim 自动降为 `low` 并写明原因。
- 产物末尾追加「抓取记录」表（来源 / 标题 / 抓取时间 / 字节 / sha256 前 12 位）与失败清单；所有来源都失败时 502 `SOURCES_UNREACHABLE` 且**不调用模型**。
- 工具新增 `fs.list`（单层目录）与 `http.fetch`（同一套守卫），进入 ToolHost 的授权/审计/超时体系。
- 资料页新增「参考链接」输入；资料库类型筛选补「字幕」。
- 能力声明新增 `sources`、`exportPolicy`。

### 变更

- `POST /v1/projects/:id/publish` 响应新增 `includeHistory` 与 `stage`。
- `/generate` 的 `kind` 收敛为五类内容产物；`review-report` 只走 `/review`。
- 版本号 0.4.0 → 0.5.0。

### 验证

- `pnpm verify`：9 个包 494 passed；security-audit 160 files PASS；对比度 PASS
- 新增 38 例测试：tools 21（http-fetch 17 + list 4）、daemon 13（v05）、desktop 3（stage-render）、CLI 1（history 开关）；全量 494 passed
- 真机 daemon + 假模型端点：抓 example.com 成功且编造条目降级、字幕入 zip、旧脚本不导出、未知 agent 400、软删可列举
- Playwright 1440×900 五张新截图：资料（含抓取记录）、分镜（真表格）、发布（计数一致）、项目（已删除面板）、资料库（字幕筛选），0 console error、0 横向溢出
- 删除 4 张 md5 完全重复的 showcase 截图，README 张数改为去重后的 34 张；重录 `demo.mp4`/`demo.gif`（22 秒，含 v0.5 界面）

## [0.4.0] - 2026-10-26

### 新增

- **风格档案**：`style_profiles` 表（迁移 008），语气 / 受众 / 禁用词 / 补充要求四个字段；设置页新增「风格」分区，可增删改；项目概览页可挂载一个档案。
- **生成时注入风格**：挂载后每次生成都会在用户消息里追加「作者风格偏好」块（上限 1800 字，明确标注为偏好、不得覆盖输出契约），system 提示仍是第一条消息。
- **禁用词检查**：`lintBannedWords` 统计最新脚本里的命中次数；`GET /v1/projects/:id/style-lint` 单独查询；检查表新增 `style` 项，命中时标红但**不阻止导出**。
- **SRT 字幕导出**：`POST /v1/projects/:id/subtitle` 把最新（或指定版本的）脚本按中文句读切成字幕条，时间戳单调递增，落盘为 `subtitle/subtitle.vN.srt`；脚本页一键导出并预览；发布包 zip 自动包含字幕。
- **复盘闭环**：`POST /v1/projects/:id/review` 读取最近 5 条回填指标（播放/点赞/评论环比、完播率、互动率、收益 + 发布包摘要）交给模型生成 `review-report`，成功后项目推进到 `review` 阶段；复盘页新增「生成复盘报告」按钮与报告展示。
- **CLI**：新增 `subtitle`、`review`、`styles`、`style-new` 四条命令。
- **能力声明**：`/health` 的 `capabilities` 增加 `styles`、`subtitle`、`review`（apiVersion 仍为 3，新增能力按 capability 探测）。

### 变更

- 检查表从 6 项变 8 项：新增 `subtitle`（可选）与 `style`（可选），`required` 语义不变，已有项目导出不受影响。
- 字幕产物不进入记忆索引（它是脚本的派生渲染，索引会重复每句话）。

### 验证

- `pnpm verify`：全量 456 passed（9 个包），build / typecheck / security-audit（153 files）/ 对比度全部通过。本次新增 32 例：store 6、daemon 17（风格与字幕 12、SRT 5）、desktop 5、CLI 4。
- 真浏览器（Playwright + Chromium）在 1440×900 下检查设置-风格、项目概览挂载、脚本页导出、复盘页生成按钮，0 console error、0 横向溢出；新增截图为 `docs/screenshots/33-settings-styles.png`。

## [0.3.1] - 2026-10-24

### 修复

- **CI 从未通过**：干净 checkout 上 `typecheck` 先于 `build` 运行，而 workspace 包通过已产出的 `dist/*.d.ts` 互相解析（`dist` 不入库），导致 `Cannot find module '@creator-studio/protocol'`。根脚本改为 build → typecheck → test，CI 收敛为单条 `pnpm verify`，顺序不会再漂移。
- **路径沙箱在 Windows 上误拒合法新文件**：目标不存在时，用未展开的短路径（8.3 名）与 realpath 展开后的根比较，被判定为 `parent traversal via realpath`。改为向上找到最近的已存在祖先做 realpath，再拼回尾部。
- **路径沙箱在 POSIX 上放过单反斜杠路径**：原先只拒绝两个反斜杠开头的 UNC，单反斜杠开头的 `\server\share` 能通过绝对路径检查。现在任何平台都以反斜杠开头的输入一律拒绝。
- CI 增加 `actions/setup-python`（Ubuntu runner 上 `python` 不保证存在）。

## [0.3.0] - 2026-10-24

### 新增

- **本地记忆索引**：`memory_chunks` + FTS5 trigram 虚表（迁移 007），产物按 600 字/80 字重叠切片；`source_hash` 增量跳过，变更时同事务替换。
- **混合检索**：FTS5 子串 + 向量余弦（阈值 0.15 + reciprocal rank fusion）；两字中文查询走 `LIKE`（trigram 最小匹配长度限制）。
- **离线嵌入**：`hashEmbedding()`（CJK 单字 + 相邻二元组、拉丁词，256 维 L2 归一化），零网络零成本；行内记录 `model`，不同向量空间不混算。
- **可选模型嵌入**：`ModelGateway.embed()` 调用供应商 `/embeddings`；设置页可指定嵌入模型，切换后自动重建索引，探测失败回退本地。
- **生成时记忆注入**：`pipeline.ts` 检索本项目最多 4 条切片（每条 1200 字），`fenceUntrusted` 包裹后与上游产物并列注入。
- **记忆端点**：`GET /v1/memory/search`、`POST /v1/memory/reindex`、`DELETE /v1/memory/:sourceRef`、`GET|POST /v1/settings/embedding`。
- **云端多租户隔离下沉到存储层**：`devicesOf/deviceFor/runsOf/runFor/updateRun/billingOf`，跨租户读写 404 并记录 `securityEvent`；`GET /v1/security-events` 只返回自己的拒绝记录；Run 指定外部设备时静默降级为云端任务。
- **界面**：工作台内嵌「项目记忆检索」，新增 `/p/:id/memory` 页面与设置里的「记忆」分区（明示当前是模型向量还是本地词法向量）。
- **测试**：记忆索引 17 例、记忆端点 7 例、神经嵌入路径 2 例、跨租户隔离 5 例。

### 变更

- `/health` 增加 `memoryChunks`，能力列表增加 `memory`（apiVersion 仍为 3，新增能力按 capability 探测）。
- 默认嵌入实现是**词法向量**而非神经语义向量；文档、界面与代码注释统一如此表述。

### 修复

- 记忆索引在少于 3 个字符的中文查询上返回空结果（trigram 限制），改为 `LIKE` 回退。

## [0.2.0] - 2026-10-24

### 新增

- **审批后继续执行**：`POST /v1/runs/:runId/resume`，审批一次性消费（`approvals.consumed_at`），从落盘转录继续未完成的工具调用。
- **取消运行**：`POST /v1/runs/:runId/cancel`，过期待办一并置为 expired。
- **项目生命周期**：`PATCH /v1/projects/:id`（标题/平台/简介/标签）、`DELETE`（软删）、`POST /restore`、按关键词搜索。
- **分镜页**：`shot-list` 产物契约 + 生成 + Markdown 表格渲染，检查表中为可选项。
- **复盘页**：`project_metrics` 表、数据回填、ECharts 趋势/完播率、环比。
- **资料库**：`GET /v1/library` 跨项目聚合、类型筛选、内容预览；`GET /v1/dashboard` 汇总。
- **自动化**：`automations` / `automation_runs` 表、daemon 内置 30s 调度器、立即运行、暂停/启用、删除。
- **密钥库**：`SecretVault`（`secrets.json`，0600），模型密钥不再依赖环境变量；`POST /v1/settings/models/:id/key` 与 `POST /test` 连通性测试。
- **真实模型生效**：`ModelGateway.replaceProfiles()`，设置里保存的模型立即用于后续生成。
- **Web 形态**：daemon 通过 `@fastify/static` 托管前端，浏览器直接可用；前端自动识别同源，自定义端口无需重新构建。
- **CLI**：新增 `apps/cli`（`health/projects/new/show/rm/restore/artifacts/cat/gen/run/runs/checklist/publish/usage/pipeline`）。
- **前端**：深色/浅色/跟随系统主题、命令面板（Ctrl+K）、顶栏预算与模型状态、项目卡片视图、Markdown 渲染（DOMPurify 消毒）。
- **产物健壮性**：`coerceByKind` 容错矫正 + 一次带示例的纠正重试；生成失败仍保持 fail-closed。
- **发布包**：内置 `manifest.json`（逐文件 sha256、导出时间、生成器版本）。
- **生成记账**：每次生成都建 Run 行，`/v1/usage` 与顶栏花费可反映真实消耗。

### 变更

- 产物落盘路径改为 `workspace/projects/<projectId>/...`，两个项目同名文件不再互相覆盖。
- 检查表新增 `required` 字段与可选项（分镜）；导出只受必备项约束。
- 生成类接口的 `max_tokens` 提升到 4096，修掉长脚本被截断。
- `/health` 升至 `apiVersion: 3`，新增 `automations/metrics/library/resume` 能力标记。

### 修复

- 修复真实模型把 `risks` 输出为字符串时整次生成失败的问题。
- 修复模型无视「只输出 JSON」返回散文的问题（输出契约 + 纠正重试）。
- 修复多项目共用工作区时产物路径冲突。
- 修复 `run_messages` 转录索引与持久化序号错位导致恢复后丢工具消息。

### 迁移

- 新增迁移 `004_run_messages.sql`、`005_library_automations.sql`、`006_run_resume.sql`，启动时自动执行。

## [0.1.0] - 2026-10-23

### 新增

- 初始发布：protocol / tools / model-gateway / store-sqlite / agent-core 五个包，daemon + desktop + cloud 三个应用。
- T1–T21 任务全部完成：脚手架、SQLite schema、模型网关、工具权限、Agent 循环、Tauri 壳、路由、SSE、脚本页、阶段页、发布包、云端控制面、注入防护、崩溃恢复、可观测、安装包、安全审计。
