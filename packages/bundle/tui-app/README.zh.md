---
description: "dsh 的交互式终端界面：在单个进程内驱动一个 Agent、一个会话，提供全屏终端交互，适合通过 SSH 工作或偏好终端而非浏览器的使用者。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-tui-app

[English](README.md) | 中文

## 概述

`dsh-tui-app` 是 dsh 的交互式终端界面。运行 `dsh` 即在当前目录启动一个 Agent，其模型、工具、沙箱与审批默认值与其他界面完全一致，但以全屏终端应用呈现：可滚动的对话记录、位于固定页脚之上的输入框，以及报告工作区、上下文占用、路由模型、token 吞吐量、token 总量和缓存命中率的状态行。由于 Agent 运行在同一进程内，它不监听端口、也不启动服务。主要边界：每次调用只有一个会话，没有浏览器与文件侧栏。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在应作为工作区的目录中打开终端界面：

```sh
dsh
```

不带 profile 的 `dsh` 即启动本 bundle；`dsh --profile tui` 显式指定它，并接受同一组参数。`DSH_DEFAULT_PROFILE` 可为裸调用选择其他默认 profile（`DSH_DEFAULT_PROFILE=web dsh`），将其设为空字符串则恢复上游「每次启动都必须指定 profile」的要求。没有交互式终端时应用会拒绝启动，因此管道或重定向调用会明确报错，而不是等待无法读取的按键。

### 组合、提问与中断

输入提示并按 Enter 提交。Agent 工作期间，输入框切换为 steer 模式：Enter 提交的文本会在运行的 turn 的下一个 step 被消费，Esc 中断该 turn。PageUp/PageDown、鼠标滚轮与终端搜索可在不退出应用的情况下滚动对话记录；当视图滚离最新一行时，状态栏会给出提示。

按 `Ctrl+V` 可把系统剪贴板中的图片附到草稿上。输入框把每个已持有的图片显示为 `[Image #1]` 标记，其行为与键入文本一致：移动或删除标记即移动或删除对应图片。该粘贴直接读取剪贴板，因此终端自身的文本粘贴仍保留原有按键。读取进行期间页脚会显示 `pasting image…`，因此较慢的平台读取器不会让界面看起来冻结。

按 `Shift+Tab` 可切换当前会话 Agent 的 plan 模式。plan 模式开启时，页脚会在生命周期状态旁显示 `plan` 标记，空输入框也会列出该按键。turn 运行期间的切换从下一个 step 生效，与 `/plan` 完全一致；未挂载 plan 模式的部署会明确报告，而不会改变会话。Agent 完成规划后通过 `exit_plan_mode` 提交计划，review 会把该计划以 markdown 的形式显示在「批准／继续规划」选项之上，并占据固定页脚与输入框之上的全部行，使长计划在任意终端尺寸下都可读，可用方向键、PageUp/PageDown 与滚轮滚动，因为 plan 模式策略要求计划经该工具提交，而不是作为普通回复粘贴。选择「继续规划」会保持 plan 模式开启并把 turn 交还给用户，因此 Agent 会等待你的下一条消息，而不是立即修改计划。

| 按键 | 作用 |
|---|---|
| `Enter` | 提交提示；若 turn 正在运行则作为 steer |
| `Esc` | 中断正在运行的 turn |
| `Shift+Tab` | 切换 plan 模式 |
| `Ctrl+V` | 把系统剪贴板中的图片附到草稿（Windows 与 WSL 上为 `Alt+V`，因为那里的终端占用了 Ctrl+V） |
| `Ctrl+C` | 取消正在运行的 turn；无运行时退出 |
| `Ctrl+D` | 退出 |
| `PageUp` / `PageDown` | 滚动对话记录，或问题详情溢出时的详情 |
| `↑` / `↓` | 问题详情溢出时滚动它；否则移动其选择器 |
| `←` / `→` | 当问题详情占用方向键时移动选择器的选中项 |
| `Ctrl+L` | 全量重绘 |

### 命令

以已知 `/command` 开头的行会执行该命令，而不会到达模型。其他斜杠文本原样传给 Agent：`/ponytail full` 通过共享技能加载器调用已安装且允许用户调用的技能，未知技能名则保留为普通文本。应用命令和已注册命令优先于同名技能。下列会话命令由本应用自己实现；其他已注册命令——`/compact`、`/goal`、`/plan` 以及部署提供的命令——都从命令注册表发现，并针对当前 Agent 派发。

| 命令 | 作用 |
|---|---|
| `/help` | 列出本应用的命令与全部已注册命令 |
| `/new` | 落盘并关闭当前会话，然后新建会话 |
| `/sessions` | 按时间倒序列出已存储会话 |
| `/resume [id]` | 按 id 恢复已存储会话，或从选择器中挑选 |
| `/model [provider/model]` | 从实时目录中选择模型，或直接切换 |
| `/effort [id]` | 选择路由模型声明的推理强度，或直接切换 |
| `/quit` | 退出 |

### 设置

本应用仅有的部署设置决定绘制位置与调色板：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `screen` | `'alternate'` | `'alternate'` 在备用屏幕中绘制对话记录并使用应用自己的滚动窗口；`'inline'` 绘制到普通屏幕，把历史留给终端自身的回滚缓冲。 |
| `colorScheme` | `'auto'` | 调色板选择。`'auto'` 读取终端导出的背景信号，读不到时保持深色；`'dark'` 与 `'light'` 固定调色板。 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tui-app)是全部可接受字段及其 JSDoc 的完整来源。bundle 补丁中的 `DSH_TUI_SCREEN` 与 `DSH_TUI_COLOR_SCHEME` 提供这些默认值。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

应用拥有一个 `TuiSession` 与一个终端界面。它先等待组合完成（`ctx.get('loader')?.await()`），以确保 Agent 的 scoped 工具与适配器已挂载，再通过核心注册表创建或恢复 Agent，然后订阅持久的 `session/event` 日志、实时的 `agent/assistant-stream` 流与 `agent/status`。

### 渲染

[`src/transcript.ts`](src/transcript.ts) 把这些事件折叠为有序行——提示、assistant 消息、实时 reasoning、带最终结果的工具调用与应用通知——并通过修订计数器使其渲染行失效。提示会先渲染其图片标记、再渲染文本，每个标记按内容顺序对应一张已附图片，因为终端没有缩略图，而持久内容块才是所附内容的记录。注入的上下文是模型输入而非对话，因此只有生产者声明了一行式 `notice` 形式时才产生行：工作区指令、技能目录与运行时上下文消息只留在会话日志中，而模型切换、plan 模式变化与 goal 以应用通知呈现。两种屏幕策略下页脚都位于输入框之下，共两行：第一行是工作区与 Agent 状态，其右侧右对齐路由模型名及其推理档位；第二行是 token 计数与「下一次请求相对路由模型容量的占用」，其右下角是整段会话的 token 数字。这些数字分别是解码吞吐量（每秒 token 数）、计费的提示词加输出 token 总量，以及计费提示词 token 中由缓存读取提供的占比；每项在有数据前都不显示，速率是 Web 统计条所报的整段会话平均值而非实时瞬时值，终端宽度不足时这一组会先于 token 计数被丢弃。plan 模式开启时会在 Agent 状态旁显示 `plan` 标记，由 `Shift+Tab` 通过 `ctx.planMode` 切换。快捷键提示是空输入框的 placeholder 而非页脚的一行：应用包装了输入框，使其内容行在用户键入第一个字符前显示这些提示，因为编辑器组件本身不渲染 placeholder。占用与容量取自已挂载 `ctx.tokenMeter` 的 `contextPressure` 投影，总量取自其 `tokenUsage` 投影，吞吐量取自本 bundle 插入的 `sessionStats` 投影；`(auto)` 标记取自 `ctx.compaction.autoCompactionEnabled`；只有当部署注册了多个 provider 时，模型标签才会带上 provider。[`src/views.ts`](src/views.ts) 使用 [`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui) 组件把行转为终端行，并把每一行截断到视口宽度，因为渲染器会把超宽行视为组件缺陷；工具标题还会被压成单行，因为一行只拥有一个终端行：多行参数否则会打印出自身的换行，使该行越出转录区压到固定页脚上。选择器或提示以普通输出而非对话框的形式呈现——一行普通标题、一行空行和主体——在备用屏幕布局中紧贴输入框上方，并把每一行填充到视口宽度，因此转录内容不会从旁边透出。滚动由备用屏幕渲染器负责：对话记录是它的主滚动视图，因此 PageUp/PageDown 与滚轮移动对话记录，而页脚与输入框保持固定。停止渲染器时会把整份对话记录写回普通屏幕，因此退出后输出仍可选择。声明了 Host diff 呈现的工具——`edit`、`write`，以及任何返回 `card: 'diff'` 视图的工具——会渲染为统一 diff 卡片，而不是其面向模型的结果句子：工具自己的标题、`+新增 -删除` 计数，以及上下文／新增／删除行，并在超过限定行数后折叠。本界面在折叠事件时通过 `ctx.tools` 解析该视图；其他所有卡片以及失败的变更都回退为普通的名称加摘要行。工具行的普通结果主体以调色板的工具结果灰渲染，而非 assistant 主体的终端前景色。调色板跟随终端背景：`colorScheme` 固定深色或浅色，`auto` 读取终端的 `COLORFGBG` 背景信号，读不到时默认深色。

### 交互接缝

应用应答 Agent 会暂停等待的两个接缝。`ctx.on('approval/request', …)` 针对本应用自己的 Agent 提供「允许一次／拒绝」并委托其他 Agent 的请求，因此同时挂载子 Agent 的组合仍由自己的应答者负责；被取消的提示解析为 `cancelled`，审批服务本就把它当作 fail-closed。`ctx.on('user-questions/request', …)` 把问题选项渲染为选择器，或在问题未声明选项时渲染自由文本输入；用户取消时以 `ASK_ABORTED` 让提问的工具失败，而 plan review 选择「继续规划」时以 `ASK_CANCELLED` 失败，plan 模式将其理解为用户收回了该 turn。问题的 `detail` 会以 markdown 渲染在该控件之上，视口大小取决于控件未占用的行数；带 detail 的提示会占据固定页脚与输入框之上的全部行，而没有 detail 的提示仍受选择器自身的高度上限约束，短列表因此不会占满高终端。详情溢出时，Up/Down、PageUp/PageDown 与滚轮滚动它，Left/Right 移动选择器，因此 plan review 会显示模型提交的计划，而不只是批准选项。同一时刻只有一个提示占用键盘。

### 剪贴板图片

Ctrl+V 通过平台自带的读取器读取系统剪贴板（[`src/clipboard.ts`](src/clipboard.ts)）：macOS 经 `osascript` 的 JavaScript 自动化运行时直接读取 `NSPasteboard`，Windows 与 WSL 用 PowerShell，Wayland 用 `wl-paste`，X11 用 `xclip`。读取器把字节落到临时文件，读取后即删除；它声明的媒体类型只是声明——附件服务会对照解码后的字节校验。页脚从按下按键到字节就绪期间显示 `pasting image…`，因为平台读取器是子进程，大尺寸剪贴板图片可能要将近一秒才能落地。字节以标记为键留在内存中。提交时若引用了标记，应用先解析精确路由模型声明的输入模态，再通过 `ctx.attachments.admitPromptContent(…)` 准入该批次，并把提示文本与其后已准入的图片块作为一条用户消息交给 Agent。被拒绝时——没有附件存储、模型排除图片输入或准入失败——应用恢复草稿，而不是发送残缺的提示。

### 基于 base 的补丁面

补丁叠加在 `dsh-base` 之上，不添加任何 host、HTTP 或浏览器行。它重述其他界面设置的编码 persona，插入启动 provider 与应用本身，并把 base 的面向模型的行保留在 host 平面：本界面是单会话的，其 Agent 进程级组合这些行，而非按会话组合。启动 provider（[`src/startup.ts`](src/startup.ts)）注入 `ctx.cmdlineArgs`（[`dsh-cmdline`](../../boot/cmdline/README.zh.md)），解析 `--resume`、`--provider` 与 `--model`，并提供 `tuiStartup`；应用行注入该服务，因此 `--help` 与被拒绝的调用完全不会挂载终端界面。补丁还把 `session-log-deepseek` 设为 `enabled: false`，因此本 fork 让 Session 日志留在本机，而不会向官方 DeepSeek 请求附带上游的 `dsh_session_log` 后缀；需要该后缀的部署可通过 `--patch` 覆盖层或 profile 自带的 `cordis.patch.yml` 重新启用该行。

### 源码索引

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `tui-app` 插件：启动器事实、启动与失败退出 |
| [`src/startup.ts`](src/startup.ts) | `tui-startup` provider：参数族与 `--help` |
| [`src/app.ts`](src/app.ts) | 界面构建、事件接线、输入路由与收尾 |
| [`src/session.ts`](src/session.ts) | Agent 创建／恢复、提示提交、路由切换 |
| [`src/transcript.ts`](src/transcript.ts) | 把事件折叠为可渲染行 |
| [`src/diff.ts`](src/diff.ts) | 纯文件 diff 行模型 |
| [`src/tool-view.ts`](src/tool-view.ts) | Host 工具呈现桥接层 |
| [`src/images.ts`](src/images.ts) | 输入框图片标记与提交时的折叠 |
| [`src/clipboard.ts`](src/clipboard.ts) | 各平台剪贴板图片读取器与其暂存文件 |
| [`src/views.ts`](src/views.ts) | 对话记录、状态栏与模态面板组件 |
| [`src/commands.ts`](src/commands.ts) | 斜杠命令目录、派发与模型目录 |
| [`src/interactions.ts`](src/interactions.ts) | 审批与用户提问应答者 |
| [`src/ansi.ts`](src/ansi.ts) | 语义样式与组件主题 |
| [`cordis.patch.yml`](cordis.patch.yml) | 基于 `dsh-base` 的终端补丁 |
| — | 不发布运行时 invariant 伴随模块；应用不注册任何注册表，也不持有树内可变关系，其可观察契约就是终端界面本身。 |
| [`tests/tui-app.spec.ts`](tests/tui-app.spec.ts) | 输入路由、剪贴板粘贴、渲染、模态应答与退出 |
| [`tests/transcript.spec.ts`](tests/transcript.spec.ts) | 事件折叠、页脚、placeholder 输入框与行宽边界 |
| [`tests/clipboard.spec.ts`](tests/clipboard.spec.ts) | 各平台读取器路径与暂存文件适配器 |
| [`tests/images.spec.ts`](tests/images.spec.ts) | 输入框标记解析 |
| [`tests/startup.spec.ts`](tests/startup.spec.ts) | 在真实 Loader 树上的命令行解析 |

### invariant 归属

不发布 invariant 伴随模块：应用不贡献任何注册表，也不持有树内可变关系，其可观察契约是终端界面，而该界面由测试通过替换 Terminal 驱动。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面可深入了解共享核心、同类界面与终端库。

- [Bundle 包地图](../README.zh.md)——构建在同一核心之上的各个界面。
- [dsh-base](../base/README.zh.md)——本界面运行的共享核心。
- [dsh-headless](../headless/README.zh.md)——面向脚本与 CI 的一次性同类界面。
- [dsh-web-app](../web-app/README.zh.md)——面向多轮工作的浏览器同类界面。
- [dsh-cmdline](../../boot/cmdline/README.zh.md)——启动器如何把命令行交给应用。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tui-app)——全部可接受配置字段及其来源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 交互式编码会话

#### 模型看到什么

应用把输入的提示作为普通用户消息提交，并把模型自身的输出渲染回来；`/help`、`/quit`、`/new`、`/sessions`、`/resume` 与 `/model` 永远不会到达模型。切换模型会追加共享的模型选择通知，与其他界面完全一致。`Shift+Tab` 通过与 `/plan` 相同的 service 进入或退出 plan 模式，因此模型看到的是与手输命令相同的 plan 策略段落与用户切换通知。剪贴板粘贴会像其他界面的上传一样，把已准入图片作为持久的图片引用加入同一条消息；输入框中的 `[Image N]` 标记只是输入框文本，永远不会到达模型。

#### Token 影响

提示与回复承担其常规 token 成本。终端渲染的任何内容——页脚、工具行折叠或滚动窗口——都不会增加请求或 token；占用、吞吐量与 token 总量数字读取自本地测量投影，而非额外的 provider 调用。切换 plan 模式本身不新增请求，只改变下一次请求的 plan 策略段落。当路由模型声明了图片计价时，所附图片按该计价计入，因此页脚反映的是模型实际会收到的请求。

#### KV Cache 影响

应用不向请求前缀添加任何内容；它只把用户输入的提示送入已组合的树中。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明终端界面不做什么。它们是本 bundle 的当前约束，而不是浏览器界面的待办列表。

- **每次调用一个 Agent**——应用只拥有一个会话；切换到其他 Agent 意味着先关闭当前会话的 `/new` 或 `/resume`。
- **多选问题会降级**——`multiSelect` 问题每次提示只呈现一个选项，因此多选答案需要多轮。
- **「继续规划」会等待消息**——终端 review 没有自由文本反馈字段，因此选择「继续规划」会关闭 review 并把 turn 交还给用户，同时保持 plan 模式开启；调整内容就是用户的下一条提示，而不是随 review 带回的答案。
- **提示高度在打开时固定**——面板只在打开时按终端尺寸计算一次，因此在 review 期间调整终端大小不会改变它；需要新高度时请关闭并重新打开该提示。
- **图片只来自剪贴板**——输入框只附加从系统剪贴板读到的 PNG、JPEG、WebP 与 GIF 字节：macOS 经 `osascript` 读取 `NSPasteboard`，Windows 与 WSL 用 PowerShell，Wayland 用 `wl-paste`，X11 用 `xclip`。缺少这些读取器的主机会把粘贴报告为空剪贴板；没有文件选择器、拖放或非图片附件。
- **工具输出会被折叠**——工具结果只显示前若干行加剩余行数；完整输出留在会话日志中，而不在屏幕上。
- **diff 卡片只覆盖文件变更**——Host 的 `presentCall`/`presentResult` 词汇还声明了读取、搜索、终端与网页卡片；本界面只采用 `card: 'diff'`，其他卡片都渲染为普通的原始行，因此将来新增的卡片需要在这里补渲染器。
- **占用是估算值**——页脚百分比锚定最近一次 provider 报告的提示规模，并对表层此后的增减做启发式重新计价；它是给用户看的参考，不是计费或准入依据。
- **退出由启动器拥有**——与所有界面一样，应用只能通过 `dsh` profile 启动，因为只有启动器提供有界退出请求。
- **没有录制会话快照**——无密钥快照框架通过 stdio 驱动随附 profile，而本界面拥有一个终端；它的验收是包测试加一次伪终端运行，而不是快照夹具，因此终端布局的回归需要扩展界面测试，而不是重新录制快照。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
