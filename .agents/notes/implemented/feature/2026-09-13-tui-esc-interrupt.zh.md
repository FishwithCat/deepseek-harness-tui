# Agent Note: TUI Escape 中断

Status: implemented

[English](2026-09-13-tui-esc-interrupt.md) | 中文

## 问题

[fork 终端界面](../architecture/2026-09-11-fork-terminal-surface.zh.md)只绑定了一个取消运行中 turn 的按键，而它同时兼任退出：Ctrl+C 在 Agent 工作时取消，在 Agent 空闲时退出。想在不危及会话的情况下停止一次生成的用户，没有只做中断的手势；而全屏终端应用惯用于取消当前操作的 Escape，此前会到达输入框且毫无作用。transcript 已经会渲染取消的助手行，`TuiSession.cancel()` 也已经拥有 Agent 的 `{ kind: 'user' }` 取消，因此界面缺的只是这个绑定。

## 决策

**Escape 中断正在运行的 turn；Ctrl+C 保留其双重作用。** `registerKeys` 在焦点输入框之前运行的 input listener 中匹配 `Key.escape`，并调用与 Ctrl+C 相同的取消，该取消被提取为 `interrupt()`。Escape 只在 Agent 运行时被消费：Agent 空闲时它把按键交还输入框且绝不退出，因此这一手势本身无法结束会话。Ctrl+C 保持不变——运行时取消，空闲时退出。

**模态提示拥有 Escape。** 只要有模态提示存在，该绑定就交还按键，与 Ctrl+C、Shift+Tab 完全一致（[plan 模式切换](2026-09-13-tui-plan-mode-toggle.zh.md)），因此 Escape 仍然用于关闭选择器或问题，而不会中断提出该问题的 turn。备用屏幕的 viewport 先于应用注册其 input listener，因此打开的对话记录搜索保留 Escape 用于关闭自身；只有搜索关闭后，同一个按键才会中断。

**提示同时展示两个按键。** 空输入框在运行状态下的提示改为 `Esc/Ctrl+C cancel`，无需阅读 README 即可发现中断手势。

## 备选方案

**把 Ctrl+C 改为只中断，并只留 Ctrl+D 作为退出键。** Ctrl+D 已经可以退出，因此 Ctrl+C 的退出分支是冗余的。它没有被采用，因为 Ctrl+C 是用户已经习惯的应急手势：移除其退出作用会让尚未学会 Ctrl+D 的用户陷入困境，而运行时两者的行为并无差别。

**空闲时用 Escape 清空输入框草稿。** 这是终端编辑器常见的绑定。它没有被采用，因为除输入框本身外，界面没有草稿保留模型，而把中断键复用于无关的编辑会让同一个 Escape 在不同情形下含义不同，且没有可见的提示。

**空闲时按 Escape 退出会话。** 它没有被采用，因为它恰好复现了本次改动要从 Ctrl+C 上移除的危险：一个中断键可以结束会话。

## 后果

终端用户可以用惯用按键停止正在运行的 turn，且不会意外结束会话。界面新增一个提取出的辅助方法与一条提示文案。会话事件、提示段落与请求都不变：取消路径正是 Ctrl+C 已经记录的那一条，因此回放会重建同一行 `[cancelled]`。

## 测试

`tests/tui-app.spec.ts` 断言 Escape 取消正在运行的 turn、播报通知且不退出；空闲时按 Escape 既不取消也不退出；焦点模态提示会因 Escape 关闭而不会中断 turn；以及在备用屏幕中，打开的对话记录搜索会先于应用消费 Escape，随后再按 Escape 才中断。该界面没有 recorded-session 快照，因此由包测试承担验收。
