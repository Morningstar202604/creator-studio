# 页面级组件树（Component Tree）

> 配套 `UI-SPEC.md`（布局与交互）与 `DESIGN-SYSTEM.md`（视觉 token）。本文定义每个页面的 DOM 层级、组件边界、数据依赖与状态归属，是前端拆任务与 code review 的依据。
> 约定：组件名用 PascalCase；`▸` 表示可折叠；`⟨slot⟩` 表示由父级传入；`*` 表示 MVP 必须实现。
> v0.2 实际实现：`AppShell` 内含 `TopBar`（预算/模型/待办/主题/命令面板）+ `SideNav`（待办角标）；页面级组件见 `apps/desktop/src/pages/`，与下文的差异以代码为准。

## 1. 分层约定

| 层 | 目录 | 规则 | 允许依赖 |
|---|---|---|---|
| `pages/` | 页面 | 只做数据编排与布局拼装，不写业务规则 | features、components |
| `features/` | 领域模块 | 一个领域一个目录，含 hooks、局部组件、mutation | components、api |
| `components/` | 通用组件 | 无业务语义，只接收 props | 无业务依赖 |
| `lib/` | 工具 | 纯函数 | 无 |

禁止：页面直接 fetch、组件直接读全局 store、feature 之间互相 import（跨领域走 `lib` 或上层注入）。

## 2. 全局骨架

```
App
└─ AppProviders*                    # QueryClient, Theme, I18n, Toast, ErrorBoundary
   └─ Router
      ├─ OnboardingLayout            # /onboarding，无 Shell
      └─ AppShell*                   # 其余全部路由
         ├─ TopBar*
         │  ├─ Breadcrumb             # 项目 › 阶段
         │  ├─ ModeBadge*             # 本地 / 本地+云端 / 云端
         │  ├─ ModelChip*
         │  ├─ BudgetMeter*
         │  ├─ DeviceIndicator*
         │  ├─ GlobalSearch           # Cmd+K 入口
         │  └─ UserMenu
         ├─ SideNav*
         │  ├─ NavSection (项目/任务/待办/资料库/自动化)
         │  ├─ ApprovalCountBadge*
         │  └─ CollapseToggle
         ├─ MainOutlet               # <Outlet />
         └─ Inspector*
            ├─ InspectorTabs         # 任务 / 来源 / 对话
            └─ InspectorContent      # 由页面注册当前上下文
         └─ RunDock*                 # 有运行中 Run 时出现
            ├─ RunProgress
            ├─ StepIndicator
            ├─ CostTicker
            └─ RunControls
```

首个可聚焦元素是全局 `SkipLink`（文案「跳到主内容」），指向 `#main`；所有交互控件使用 `:focus-visible` 2px 强调色环 + 2px 偏移。

数据依赖（`AppShell` 层）：

| Hook | 数据 | 刷新策略 |
|---|---|---|
| `useMe()` | 用户、订阅、额度 | 5 分钟 stale |
| `useDevices()` | 设备在线状态 | WS 推送 + 30s 兜底轮询 |
| `useActiveRun()` | 当前项目运行中 Run | 事件流 |
| `useApprovalCount()` | 待办数量 | 事件流 |
| `useTheme()` | 主题 | 本地持久化 |

## 3. 页面组件树

### P0 首次引导 `/onboarding`

```
OnboardingLayout*
├─ StepIndicator (steps=3, current)
├─ StepEnvironment*
│  ├─ EnvironmentCheckList
│  │  ├─ CheckItem (webview2 | ffmpeg | disk | network)
│  │  └─ FixAction            # 一键下载/打开文档
│  └─ SkipLink
├─ StepModel*
│  ├─ ModelProviderTabs       # OpenAI兼容 / Anthropic / Ollama / 稍后
│  ├─ ApiKeyForm              # 密码框 + 显示后四位
│  ├─ LocalModelDetect        # 扫描 11434
│  ├─ ConnectionTest*         # 延迟 + 计费
│  └─ ModelAssignPreview      # 任务→模型 默认映射
├─ StepWorkspace*
│  ├─ DirectoryPicker         # 系统对话框
│  ├─ WorkspaceSummary        # 可写检测、磁盘剩余
│  └─ ImportExisting          # 可选，Markdown/docx
└─ OnboardingFooter           # 上一步 / 下一步 / 跳过
```

状态：本地 `useReducer`，不写全局；完成时一次 `POST /v1/onboarding/complete`。
边界：模型步骤可跳过，跳过则 `capabilities.generation=false`，相关按钮禁用。

### P1 项目列表 `/`

```
ProjectsPage*
├─ PageHeader
│  ├─ Title ("项目")
│  ├─ SearchInput
│  └─ PrimaryButton ("新建项目")
├─ FilterBar
│  ├─ SegmentedControl (全部/进行中/待审/已完成)
│  ├─ ViewToggle (卡片/表格)
│  └─ SortSelect
├─ ProjectGrid | ProjectTable*
│  └─ ProjectCard*
│     ├─ StageBadge*
│     ├─ ProgressBar (stage 4/8)
│     ├─ ArtifactCount
│     ├─ CostLabel
│     └─ CardMenu (继续/重命名/归档/删除)
├─ EmptyState*
│  ├─ Illustration
│  ├─ PrimaryAction ("从选题开始")
│  └─ SecondaryAction ("导入现有文档")
└─ NewProjectDialog*
   ├─ TitleInput
   ├─ PlatformSelect
   ├─ DirectionInput
   └─ CreateAction
```

数据：`useProjects(filter)` → `['projects', filter]`；`useCreateProject()` 乐观插入。
空/加载/错误：`ProjectGridSkeleton`、`ErrorPanel`（重试）。

### P2 项目工作台 `/p/:id`

```
ProjectPage*
├─ ProjectHeader
│  ├─ BackLink
│  ├─ ProjectTitle (可编辑)
│  ├─ StageBadge
│  └─ ProjectActions (归档/导出/更多)
├─ StageRail*
│  └─ StageItem × 8          # 完成/当前/未开始，点击路由
├─ StageOutlet               # 渲染 P3–P9 子路由
└─ ProjectMetaFooter
   ├─ ArtifactSummary
   ├─ CitationCount
   └─ LastActivity
```

`StageRail` 与 `StageOutlet` 共享 `useProject(id)`，只请求一次（Query cache 去重）。
守卫：`stage` 未达时子路由可访问但显示 `StageLockedNotice`（允许预填，不允许生成）。

### P3 选题 `/p/:id/topic`

```
TopicPage*
├─ TopicToolbar
│  ├─ DirectionInput
│  ├─ GenerateButton
│  └─ UsageHint ("已用 3 次 · 约 ¥0.12")
├─ CandidateGrid
│  └─ TopicCard* × n
│     ├─ ScoreBar (需求/竞争/差异/可讲性)
│     ├─ CompositeScore*
│     ├─ RationaleText
│     ├─ CompetitorList ▸
│     └─ CardActions (选这个 / 看竞品 / 丢弃)
├─ SelectedBanner*           # 已定稿时替换 CandidateGrid
│  ├─ SelectedTitle
│  ├─ DecidedAt
│  └─ ReopenButton
└─ TopicEmptyState
```

交互：`选这个` → `ApproveDialog(kind='stage-advance')` → `useAdvanceStage()`。
数据：`useTopicCandidates(projectId)`、`useGenerateTopics()`（长任务，返回 runId 后订阅事件）。

### P4 资料 `/p/:id/research`

```
ResearchPage*
├─ ResearchToolbar
│  ├─ AddLinkButton
│  ├─ ImportPdfButton
│  ├─ ScanFolderButton
│  └─ StatsLabel ("34 条 · 12 未读")
├─ SplitLayout
│  ├─ SourceList*
│  │  ├─ SourceFilter (全部/已引用/未读/失败)
│  │  └─ SourceListItem* × n
│  │     ├─ TrustDot (高/中/低)
│  │     ├─ Title
│  │     ├─ CitationCount
│  │     └─ StatusIcon
│  └─ SourceDetail*
│     ├─ SourceMeta (域名/抓取时间/可信度)
│     ├─ SummaryText
│     ├─ KeyPassages
│     │  └─ PassageItem + InsertButton
│     ├─ CitationUsages
│     └─ SourceActions (重新抓取/标记不可信/删除)
└─ AddLinkDialog*
```

数据：`useSources(projectId, filter)`、`useSourceDetail(id)`；插入引用调 `useInsertCitation()` 写回脚本产物（版本 +1）。
边界：抓取失败项就地标红，不阻塞列表。

### P5 脚本 `/p/:id/script`

```
ScriptPage*
├─ ScriptToolbar*
│  ├─ VersionSelect*          # v3 ▾
│  ├─ CompareButton           # 对比 v2
│  ├─ FactCheckButton
│  ├─ ReadTimeLabel
│  └─ ExportButton
├─ EditorLayout
│  ├─ ScriptEditor*
│  │  ├─ EditorToolbar (标题/加粗/列表/引用)
│  │  ├─ TipTapEditor
│  │  ├─ CitationMark         # [^1] 上标 + SourcePopover
│  │  ├─ FactCheckMark        # warn 底纹
│  │  └─ SelectionToolbar*    # 改写/缩短/更口语/加例子/查证
│  └─ ScriptInspector*
│     ├─ IssueList*
│     │  └─ IssueItem × n (定位/忽略/采纳)
│     ├─ AgentSuggestionList
│     └─ OutlineMiniMap
└─ DiffDialog*
   ├─ DiffViewer (side-by-side / inline)
   └─ DiffActions (接受全部/逐段接受/拒绝)
```

状态归属：

| 状态 | 位置 | 说明 |
|---|---|---|
| 草稿内容 | TipTap 内部 + 防抖自动保存 | 600ms |
| 版本号 | Query `['script', projectId, version]` | 服务端权威 |
| 选中文本 | 组件本地 | 不持久化 |
| diff 预览 | 组件本地 | 关闭即丢弃 |
| 待确认问题 | Query `['issues', scriptId]` | 采纳后失效重取 |

关键约束：任何 AI 改写必须走 `DiffDialog`，禁止直接替换编辑器内容。

### P6 分镜 `/p/:id/shotlist`

```
ShotListPage*
├─ ShotToolbar (生成/导入素材/导出)
├─ ShotTable*
│  ├─ ShotRow × n
│  │  ├─ OrderHandle (拖拽)
│  │  ├─ SceneNumber
│  │  ├─ DescriptionCell (可编辑)
│  │  ├─ AssetThumb (缺素材显示占位)
│  │  ├─ DurationCell
│  │  └─ RowMenu (插入/删除/上移)
│  └─ ShotFooter (总时长)
└─ AssetPickerDrawer
```

数据：`useShotList(projectId)`；拖拽用 dnd-kit，提交乐观更新，失败回滚。

### P7 包装 `/p/:id/package`

```
PackagePage*
├─ PackageToolbar
│  ├─ PlatformSelect
│  ├─ StyleSelect
│  ├─ GenerateButton
│  └─ BudgetHint
├─ SplitLayout
│  ├─ TitleCandidates*
│  │  ├─ TitleItem × n (rank/score/text/copy)
│  │  ├─ RegenerateButton
│  │  └─ CustomScoreToggle
│  └─ PackagePreview*
│     ├─ CoverPreview (16:9 占位/上传)
│     ├─ PlatformCardPreview   # 按平台渲染
│     ├─ DescriptionBlock
│     ├─ TagEditor
│     ├─ ChapterList
│     └─ ComplianceWarnings*
├─ CoverBriefPanel
└─ ExportBar (复制全部 / 导出发布包)
```

### P8 发布 `/p/:id/publish`

```
PublishPage*
├─ ChecklistPanel*
│  └─ CheckItem × n (脚本/字幕/封面/标题/合规/引用)
├─ FileManifest*
│  └─ FileRow (名称/大小/路径/复制)
├─ ExportPanel
│  ├─ FormatSelect (md/zip/json)
│  └─ ExportButton
└─ PublishTips (平台注意事项，静态)
```

规则：检查表未全绿时导出按钮禁用，并说明缺哪项。

### P9 复盘 `/p/:id/review`

```
ReviewPage*
├─ MetricsOverview*
│  └─ MetricCard × 4 (播放/完播/互动/涨粉)
├─ TrendChart (ECharts)
├─ ComparisonTable (vs 近 5 期)
├─ AgentReviewPanel*
│  ├─ FindingsList
│  └─ NextTopicSuggestions
└─ ImportMetricsDialog (CSV/截图)
```

图表用 ECharts，不自绘；数据不足时显示 `InsufficientDataNotice`。

### P10 任务 `/runs`

```
RunsPage*
├─ RunFilters (状态/项目/时间/Agent)
├─ RunTable*
│  ├─ RunRow × n
│  │  ├─ StatusBadge
│  │  ├─ AgentAvatar
│  │  ├─ ProjectLink
│  │  ├─ Duration
│  │  ├─ Cost
│  │  └─ RowActions (查看/取消/重跑)
│  └─ Pagination
└─ RunDetailDrawer*
   ├─ RunSummary
   ├─ StepTimeline*
   ├─ EventLog ▸
   └─ ErrorPanel
```

### P11 待办 `/approvals`

```
ApprovalsPage*
├─ ApprovalTabs (全部/发布/删除/付费/其他)
├─ ApprovalList*
│  └─ ApprovalCard* × n
│     ├─ RiskBadge (高/中/低)
│     ├─ KindIcon
│     ├─ ContextPreview (文件/金额/目标)
│     ├─ ReasonText
│     └─ Actions (查看详情/拒绝/批准)
├─ ApprovalDetailDialog*
│  ├─ FullContext
│  ├─ DiffPreview (如涉及写入)
│  └─ ConfirmDangerInput      # 危险项需输入"删除"/金额
└─ EmptyState
```

规则：风险=高时 `ConfirmDangerInput` 必填；批量操作只对低风险开放。

### P12 资料库 `/library`

```
LibraryPage*
├─ LibraryToolbar (搜索/标签/类型/视图)
├─ AssetGrid | AssetTable
│  └─ AssetCard* × n (缩略图/名称/大小/引用项目)
└─ AssetDetailDrawer
```

### P13 自动化 `/automations`

```
AutomationsPage*
├─ AutomationToolbar (新建)
├─ AutomationList*
│  └─ AutomationRow × n
│     ├─ ScheduleLabel (cron 人话)
│     ├─ NextRunAt
│     ├─ TargetAgent
│     ├─ ToggleSwitch*
│     └─ LastRunStatus
├─ CloudRequiredNotice     # 未订阅时提示
└─ AutomationEditor*
   ├─ TriggerForm
   ├─ ActionForm
   └─ BudgetForm
```

### P14 设置-模型 `/settings/models`

```
SettingsLayout
├─ SettingsNav
└─ ModelsPage*
   ├─ ProviderList*
   │  └─ ProviderCard × n
   │     ├─ StatusDot
   │     ├─ ModelName
   │     ├─ PriceLabel
   │     ├─ TestButton*
   │     └─ EditButton
   ├─ AddProviderDialog*
   │  ├─ PresetSelect
   │  ├─ BaseUrlInput
   │  ├─ ApiKeyInput*        # 只显示后四位
   │  ├─ ModelInput
   │  └─ TestResult
   ├─ TaskModelMatrix*       # 任务 → 模型
   └─ BudgetSection*
```

### P15 设置-设备 `/settings/devices`

```
DevicesPage*
├─ CurrentDeviceCard
├─ DeviceList*
│  └─ DeviceRow (名称/系统/在线/最后活跃/吊销)
├─ PairingPanel*
│  ├─ PairingCode (5 分钟倒计时)
│  └─ CopyButton
└─ ConnectionLog ▸
```

### P16 设置-权限 `/settings/permissions`

```
PermissionsPage*
├─ ToolGrantTable*
│  └─ GrantRow × n
│     ├─ ToolName
│     ├─ ScopeInput (glob)
│     ├─ ModeSelect (auto/ask/deny)
│     └─ ResetButton
├─ DangerZone (恢复默认/全部拒绝)
└─ GrantHint (解释三种模式)
```

### P17 设置-预算 `/settings/budget`

```
BudgetPage*
├─ MonthlyBudgetForm*
├─ PerProjectBudgetForm*
├─ AlertThresholds (80%/100%)
├─ UsageChart (ECharts)
└─ CostBreakdownTable
```

## 4. 组件清单与归属

| 组件 | 层 | 使用页面 | Props 关键字段 | 状态 |
|---|---|---|---|---|
| `AppShell` | layout | 全部 | - | 全局 |
| `SkipLink` | layout | 全部 | - | 本地 |
| `TopBar` | layout | 全部 | project?, run? | 全局 |
| `SideNav` | layout | 全部 | collapsed | 全局 |
| `Inspector` | layout | P2–P9 | context | 全局 |
| `RunDock` | layout | 全部 | runId? | 全局 |
| `StageRail` | feature | P2–P9 | project, stage | 服务端 |
| `RunCard` | feature | P2, P10 | run | 服务端 |
| `ApprovalCard` | feature | P11, Inspector | approval | 服务端 |
| `ArtifactList` | feature | P2, P8 | projectId | 服务端 |
| `DiffViewer` | component | P5, P11 | left, right, mode | 本地 |
| `SourcePopover` | component | P5 | sourceId | 服务端 |
| `BudgetMeter` | component | TopBar, P17 | used, max | 服务端 |
| `ModelPicker` | component | P14, TopBar | profiles | 服务端 |
| `EmptyState` | component | 全部列表页 | icon, title, action | 本地 |
| `ErrorPanel` | component | 全部 | error, retry | 本地 |
| `CommandPalette` | component | 全局 | open | 本地 |
| `ConfirmDangerInput` | component | P11 | word, onConfirm | 本地 |
| `ToggleSwitch` | component | P13, P16 | checked | 受控 |
| `TagEditor` | component | P7 | tags | 受控 |

## 5. 数据依赖矩阵

| 页面 | Query keys | Mutation | 实时 |
|---|---|---|---|
| P0 | `['env']` | `onboarding.complete` | 无 |
| P1 | `['projects', filter]` | `project.create/rename/archive` | 无 |
| P2 | `['project', id]` | `project.update` | `run.*` |
| P3 | `['topics', id]` | `topics.generate`, `project.advance` | `run.*` |
| P4 | `['sources', id, filter]`, `['source', sid]` | `source.add/refetch/insertCitation` | `run.*` |
| P5 | `['script', id, v]`, `['issues', sid]` | `script.save`, `script.revise`, `issue.resolve` | `run.*` |
| P6 | `['shotlist', id]` | `shotlist.reorder/update` | `run.*` |
| P7 | `['package', id]` | `package.generate/export` | `run.*` |
| P8 | `['manifest', id]` | `publish.export` | 无 |
| P9 | `['metrics', id]` | `metrics.import` | 无 |
| P10 | `['runs', filter]`, `['run', rid]` | `run.cancel/retry` | `run.*` |
| P11 | `['approvals', status]` | `approval.decide` | `approval.*` |
| P12 | `['library', filter]` | `asset.tag/delete` | 无 |
| P13 | `['automations']` | `automation.save/toggle` | 无 |
| P14 | `['models']` | `model.create/test/update` | 无 |
| P15 | `['devices']` | `device.pair/revoke` | `device.status` |
| P16 | `['grants']` | `grant.update` | 无 |
| P17 | `['budget']`, `['usage']` | `budget.update` | 无 |

实时事件统一走 `useRunEvents(runId)`，按 `seq` 合并进 `['run', rid]` 与 `['events', rid]`，不新建 store。

## 6. 与实施计划的对应

| 任务 | 组件树范围 | 完成判据 |
|---|---|---|
| T7 | AppShell、TopBar、SideNav、Inspector、P1、P2 骨架 | 三栏在 1100/900px 正确降级；新建项目进入 P3 |
| T8 | P10、P11、RunDock、RunCard、ApprovalCard | 事件实时、断线续传、审批生效 |
| T9 | P5（编辑器、DiffDialog、IssueList） | 改写必经 diff；逐段接受 |
| T10 | P3、P4、P7 + 产物契约 | 四阶段串通，产物过 schema |
| T10b | P0、P14、P16、P17 | 新环境 3 分钟可用；权限/预算即时生效 |
| T11 | P8 + 全链路 | 导出 zip 完整，检查表拦截缺项 |
| P1 阶段 | P6、P9、P12、P13、P15 | 各自验收 |

## 7. 待定

1. 编辑器最终选 TipTap（建议）还是 ProseMirror 原生。
2. 拖拽库用 dnd-kit（建议）还是 react-dnd。
3. 图表统一 ECharts，是否引入轻量封装 `@echarts-for-react` 待评估包体。
4. 是否做组件 Storybook；建议 T7 后补，避免前期拖慢。
