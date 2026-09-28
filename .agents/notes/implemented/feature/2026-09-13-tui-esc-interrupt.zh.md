# Agent Note: TUI Escape 中断

Status: implemented

[English](2026-09-13-tui-esc-interrupt.md) | 中文

## 问题

[fork 终端界面](../architecture/2026-09-11-fork-terminal-surface.zh.md)只绑定了一个取消运行中 turn 的按键，而它同时兼任退出：Ctrl+C 在 Agent 工作时取消，在 Agent 空闲时退出。想在不危及会话的情况下停止一次生成的用户，没有只做中断的手势；而全屏终端应用惯用于取消当前操作的 Escape，此前会到达输入框且毫无作用。transcript 已经会渲染取消的助手行，`TuiSession.cancel()` 也已经拥有 Agent 的 `{ kind: 'user' }` 取消，因此界面缺的只是这个绑定。基础 `subagent` 工具的默认形态是后台可继续子级，它们会比启动它们的父 turn 活得更久，因此只取消该 turn 会让委派工作在一个空闲 Agent 背后继续运行，而终端没有任何控件能停止它。

## 决策

**Escape 中断正在运行的 turn；Ctrl+C 保留其双重作用。** `registerKeys` 在焦点输入框之前运行的 input listener 中匹配 `Key.escape`，并调用与 Ctrl+C 相同的取消，该取消被提取为 `interrupt()`。只有当会话有进行中的工作时 Escape 才被消费：会话空闲时它把按键交还输入框且绝不退出，因此这一手势本身无法结束会话。Ctrl+C 保持不变——工作时取消，空闲时退出。

**会话的存活 subagent 随其 turn 一同停止。** `TuiSession.busy` 取 Agent 自身状态或经 `SubagentRuntime.runningDescendantIds()` 读取到的正在运行 subagent 后代二者之一；`cancel()` 通过 `SubagentRuntime.interruptDescendants()` 停止其中每一个。该停止同时取消驻留的可继续子级与后台一次性运行，因此终端无需单独的任务控制。因此，即使启动它的父 turn 已经结束，只要后台 child 仍在工作，界面就会报告 `running` 并提供取消按键。steering 仍只取决于 Agent 自身的 turn：Agent 空闲但 subagent 运行时，仍接受普通提示。未挂载 subagent 服务的组合只停止 Agent。

**模态提示拥有 Escape。** 只要有模态提示存在，该绑定就交还按键，与 Ctrl+C、Shift+Tab 完全一致（[plan 模式切换](2026-09-13-tui-plan-mode-toggle.zh.md)），因此 Escape 仍然用于关闭选择器或问题，而不会中断提出该问题的 turn。备用屏幕的 viewport 先于应用注册其 input listener，因此打开的对话记录搜索保留 Escape 用于关闭自身；只有搜索关闭后，同一个按键才会中断。

**提示同时展示两个按键。** 空输入框在工作状态下的提示改为 `Esc/Ctrl+C cancel`，无需阅读 README 即可发现中断手势。

## 备选方案

**把 Ctrl+C 改为只中断，并只留 Ctrl+D 作为退出键。** Ctrl+D 已经可以退出，因此 Ctrl+C 的退出分支是冗余的。它没有被采用，因为 Ctrl+C 是用户已经习惯的应急手势：移除其退出作用会让尚未学会 Ctrl+D 的用户陷入困境，而运行时两者的行为并无差别。

**空闲时用 Escape 清空输入框草稿。** 这是终端编辑器常见的绑定。它没有被采用，因为除输入框本身外，界面没有草稿保留模型，而把中断键复用于无关的编辑会让同一个 Escape 在不同情形下含义不同，且没有可见的提示。

**空闲时按 Escape 退出会话。** 它没有被采用，因为它恰好复现了本次改动要从 Ctrl+C 上移除的危险：一个中断键可以结束会话。

**在 Escape 只中断 turn 时让委派 subagent 继续运行。** 延续管理器有意让已接受的后台 child 在调用方取消后继续存活，因此这只是 Agent 原语自身的行为。它没有被采用，因为终端界面没有其他控件来报告或停止这些 child：停止会话的用户会继续为看不见的委派工作付费，而后来的提示还可能与仍在写入同一工作区的 child 竞争。

**通过 drain 释放后代 Activation 来停止它们。** `drainContinuableDescendants()` 会在该 Agent 离开注册表之前关闭其下可继续子级的准入。它没有被采用，因为逐 turn 的中断必须让会话仍能再次委派。

## 后果

终端用户可以用惯用按键停止正在运行的 turn 以及它启动的委派工作，且不会意外结束会话。界面新增一个提取出的辅助方法与一条提示文案，从 subagent 服务读取正在运行的后代，并用一次调用停止它们。subagent seam 新增同步的后代读取与后代停止；其逐 child 的 `interrupt()` 路径保持不变。会话事件、提示段落与请求都不变：取消路径正是 Ctrl+C 已经记录的那一条，因此回放会重建同一行 `[cancelled]`。

## 测试

`tests/tui-app.spec.ts` 断言 Escape 取消正在运行的 turn、播报通知且不退出；空闲时按 Escape 既不取消也不退出；焦点模态提示会因 Escape 关闭而不会中断 turn；以及在备用屏幕中，打开的对话记录搜索会先于应用消费 Escape，随后再按 Escape 才中断。它还断言：在 Agent 自身空闲时，Escape 与 Ctrl+C 会停止正在运行的 subagent（Ctrl+C 不退出）；在只有 subagent 工作时，页脚报告 `running` 并提供取消按键；以及最后一个 subagent 结算后页脚恢复空闲。`packages/subagent/subagent/tests/service.spec.ts` 断言后代读取只返回任意深度的、来源为 subagent 的正在运行后代，跳过空闲子级、fork 与无关联树，并在没有 Agent 注册表时返回空，同时断言后代停止恰好取消这些 child 并返回计数。该界面没有 recorded-session 快照，因此由包测试承担验收。
