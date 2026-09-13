# Agent Note: The TUI consumes Host tool presentation views

Status: implemented

[English](2026-09-13-tui-host-tool-presentation.md) | 中文

## Problem

[客户端侧派生的工具呈现](2026-08-23-client-derived-tool-presentation.zh.md)把 `ToolDefinition.presentCall`、`ToolDefinition.presentResult`、`ToolCallView` 与 `ToolResultView` 保留为 Host API，同时 Web 客户端从原始事件与持久化的 `meta` 派生卡片。该决定刻意留下了一件事未决：没有任何生产消费者调用 Host presenter，而终端界面把每个工具都渲染为名称、一行参数摘要与原始结果文本。因此文件变更显示的是确认句——`The file foo.ts has been updated successfully.`——而 `dsh-tool-fs` 早已算出所应用的上下文 hunk、把它持久化在 `tool/result` 的 `meta` 中，并已为同一次调用声明了 `card: 'diff'` 视图。

## Decision

**终端界面就是这些 presenter 被保留下来所要服务的 Host 消费者。** [`src/tool-view.ts`](../../../../packages/bundle/tui-app/src/tool-view.ts) 在对话记录折叠一条 `tool/call` 或 `tool/result` 事件时解析 `ctx.tools.get(name, agent())`，并把声明的视图收窄为 `card: 'diff'`。因此 `edit`、`write` 以及任何声明了 diff 卡片的工具都会渲染为统一 diff；`str_replace_editor` 通过其调用时卡片，对其 `create` 与 `str_replace` 命令获得同样待遇。

**解析发生在折叠时，而不是渲染时。** `Transcript` 接受一个可选的 `ToolPresentationResolver`；`app.ts` 提供基于注册表的实现，测试则传入固定实现或不传。因此折叠对每条事件保持确定性，视图对象既不会进入会话日志，也不会进入请求或渲染路径。

**收窄是显式的，且只涵盖一种卡片。** 桥接层把原始参数 JSON 作为模型边界解析（仅接受对象），在 `try`/`catch` 中调用 presenter，并对其他卡片、未知工具、缺失的注册表、格式错误的参数或 presenter 抛错统一返回 `undefined`。每个 `undefined` 都让该行保持原有的「名称加摘要」渲染，因此未处理的卡片会退化为普通文本，而不会让该 turn 失败。

**结算结果会替换待定卡片，但有两条规则。** 成功结果会装上工具的 result 卡片；工具未声明的 result 卡片会保留调用时卡片，这正是 `str_replace_editor` 的变更在结算后仍然可见的原因。失败的变更会直接清除卡片，因为该改动并未应用（或被回滚），面向模型的错误文本才是用户需要的事实。

**diff 主体是真正的统一 diff。** `src/diff.ts` 用 `diff` 包的 `diffLines` 从 hunk 的两侧重新推导每一行的上下文／新增／删除角色，从而取代 Web `DiffBlock` 所画的「先整段旧侧、再整段新侧」布局：在窄小的滚动界面上，把每侧三行上下文重复一遍只会让主体翻倍而不增加任何含义。单文件卡片省略路径行，因为标题已经指明文件；多文件卡片会为每个文件以路径开头，同一文件的后续 hunk 以 `⋯` 间隔。标题携带工具声明的标题以及 `+新增 -删除`，主体与结果文本在到达屏幕前都经过行数限制。

## Alternatives considered

**像 `ui-tool` 的 `diff-card-model.ts` 那样，在终端侧从原始参数与 `meta` 重新派生 diff。** 它落选是因为终端与工具注册表同进程运行：重新派生会在第二个平面上重复 `write`/`edit`/`str_replace_editor` 的参数知识与卡片形状规则，并且只要某个工具的 presenter 改变就会静默漂移。Host presenter 存在的意义，正是让 Host 消费者完全不必知道工具名称。

**扩展 `FileDiff` 以携带逐行角色，从而省去第二次 diff 计算。** 它因改动面过大而落选：`FileDiff` 是被 Web `DiffBlock`、`ui-tool` 的卡片模型以及两个变更工具测试共同消费的共享呈现词汇，而终端只是为自己的渲染需要这些角色。本地的 `diffLines` 计算把改动限制在本包内。

**一次性采用整套卡片词汇——读取、搜索、终端、网页。** 它落选是因为每种卡片都需要自己的终端几何，每个工具的 `meta` 也需要自己的收窄，而它们都不属于本次要解决的问题。桥接层当前只收窄 `card: 'diff'`，并作为下一张卡片的扩展点。

**让 presenter 抛出的错误直接传入折叠过程。** 它落选是因为 presenter 是在 turn 中途的 `session/event` 监听器里调用的：某个工具的 presenter 缺陷会中断该 turn 余下部分的折叠。桥接层吞掉该错误并退化为原始行，这与缺少 presenter 时的结果相同。

## Consequences

终端界面成为 Host 工具呈现 API 的第一个生产消费者，并拥有「从声明的卡片到终端行」的映射。Web 客户端保持原样，仍从原始事件派生卡片；两个界面现在通过不同路径读取同一批工具声明，而共享的 `presentationMeta` 投影让二者保持一致。没有任何会话事件、prompt 段落、请求头或持久格式发生变化：卡片派生自 `tool/call` 与 `tool/result` 事件本就携带的数据，面向模型的结果文本也不受影响——只是在 diff 行之下不再重复。本界面新增对 `@deepseek-ai/dsh-tools` 的 peer 依赖与对 `diff` 的运行时依赖；`card: 'diff'` 之外的每张卡片仍渲染为原始行，这一点记录在本包 README 的已知限制中。

## Testing

`tests/tool-view.spec.ts` 在真实 `ToolRuntime` 之上固定桥接层：待定与结算 diff 的收窄、其他卡片、未知工具、缺失的注册表、非对象参数、抛错的 presenter，以及透传的结算结果投影。`tests/diff.spec.ts` 固定纯行模型：角色、创建、整体删除、空变更、内部空行、同文件间隔与多文件路径头。`tests/transcript.spec.ts` 固定折叠（待定卡片、应用后替换、调用时保留、出错清除、空 hunk 列表、缺失 resolver，以及传给 resolver 的输入）与渲染（`+a -r`、`-`/`+` 行、多文件主体、折叠与宽度边界）。`tests/tui-app.spec.ts` 通过真实注册表驱动一次变更，并断言合成后的终端显示 diff 而非结果句。本界面没有录制会话快照，因此验收由本包测试承担。
