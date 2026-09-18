# Agent Note: TUI 退出时打印 resume 提示

Status: implemented

[English](2026-09-18-tui-exit-resume-hint.md) | 中文

## Problem

终端界面已支持启动时的 `dsh --resume <session-id>`，输入框也实现了 `/resume` 与 `/sessions`，但 id 只在应用打开期间才能到达用户：它出现在 `/sessions` 列表里，退出时备用屏幕的恢复重绘也只把对话记录写回。用 Ctrl+C 关闭应用的用户得不到任何指回会话的打印信息，因此之后要继续这段对话，只能事先复制好 id，或在下一次调用中查找已存储的会话。

## Decision

**退出应用时打印 resume 命令。** `TuiApp.stop()` 在终端恢复后向 stderr 写入两行：

```
To resume this session:
  dsh --resume <session-id>
```

id 在退出时从当前会话读取，因此它指向应用停止时生效的那个会话——`/new` 或 `/resume` 之后的替代会话，而不是进程启动时的会话。

**写入发生在落盘之后。** `stop()` 先拆除界面、落盘会话、将其 dispose，然后才在请求有界退出之前写入提示。落盘是使会话物化的持久化屏障，对显式落盘、不含任何事件的会话也会物化出仅含 header 的产物，因此打印的命令指向的是之后某个进程能打开的对象。

**提示要求存在持久化后端。** 仅当 `ctx.get('sessionPersistence')` 解析成功时才写入。没有后端时 `--resume` 无可打开的对象，应用本来也会因同一缺失而拒绝 resume；提示绝不宣传该部署无法执行的操作。

**用 stderr，而非 stdout。** 界面的 stdout 承载着恢复后的对话记录，而启动器已把启动失败经由同一个 `internals.stderr` sink 输出。该提示是关于进程的事后消息，而不是它刚刚恢复的那段对话记录的一部分。

## Alternatives considered

**在调用 `teardown()` 的 effect disposer 中打印。** 该路径也会在配置热重载和 `stop()` 自身的拆除时运行，因此把提示放在那里会在 HMR 时触发、并在普通退出时重复打印；要把信号场景与重载场景分开，需要本应用并不拥有的 shutdown seam。而所有用户退出手势——空闲时 Ctrl+C、Ctrl+D 与 `/quit`——都已经由 `stop()`。

**以 `session.seq > 0` 作为打印条件。** 它落选，是因为退出时的落盘即使对不含任何事件的会话也会物化，未动过的会话同样可以 resume；这个额外条件会在刚启动时抑制一条真实成立的命令，而那时打印出的 id 正是用户得知它的唯一途径。

**在拆除前把提示渲染为对话记录中的通知。** 它落选，是因为紧挨拆除前加入的通知永远不会作为实时帧被绘制：它只会出现在备用屏幕的恢复重绘里，而 inline 屏幕没有对应的恢复步骤，两种屏幕策略因此会不一致。

**把命令写成 `dsh --profile tui --resume <session-id>`。** 它落选，是因为在本 fork 中裸 `dsh` 即启动 tui profile，且 `--resume` 属于应用，短形式与应用通常的启动方式以及调用文档一致。

## Consequences

用户总能找回刚刚离开的会话，包括没有产生任何输出的会话。本界面新增一个辅助函数（`resumeHint`）和退出路径中的一行；不改变任何会话事件、提示词 section、请求或存储格式，因为提示读取的正是落盘已经提交的状态。移除持久化的部署会同时失去该提示与 `/resume`、`--resume`，三者现在保持一致。提示硬编码了 `dsh` 入口与短参数形式，因此重命名二进制或使用非默认 `DSH_DEFAULT_PROFILE` 会让打印出的命令不正确；这两者都无法从应用自身的上下文中得知。

## Testing

`tests/tui-app.spec.ts` 断言：已持久化会话下精确的两行提示、`/new` 之后 id 跟随替代会话，以及组合中未挂载持久化服务时 stderr sink 收不到任何字节。本界面没有录制会话快照，因此验收由包内测试负责。
