# Agent Note: TUI plan 模式切换

Status: implemented

[English](2026-09-13-tui-plan-mode-toggle.md) | 中文

## 问题

[fork 终端界面](../architecture/2026-09-11-fork-terminal-surface.zh.md)可以切换模型路由与推理强度，却没有针对会话协作模式的手势。plan 模式是[按 Agent 记录的协作状态](../simplification/2026-07-22-plan-specific-collaboration-state.zh.md)，它会加入 `plan:policy` 提示段落并约束 `exit_plan_mode`；终端此前只能通过输入 `/plan` 与 `/plan off` 触达它，而浏览器端输入框的 chip 一次点击即可退出。在终端工作的用户没有对应的按键。

## 决策

**`Shift+Tab` 切换本应用自己 Agent 的 plan 模式。** `registerKeys` 在焦点输入框之前运行的 input listener 中匹配 `Key.shift('tab')` 并消费它；当模态提示持有键盘时，该按键仍交还输入框——与 Ctrl+C 遵循同一条规则。

**切换直接驱动 `PlanModeController`。** 应用用 `get(agent)` 读取生效模式——即 `pending ?? active`，排队中的选择也计入——并调用 `set(agent, !effective)`。`set` 会同步更新其排队选择，因此即使 turn 正在运行，页脚与提示也在同一个 tick 内正确；基于 projection 的 `pending` 只有等配对的命令生命周期结算后才会出现。结果以应用通知播报：`plan mode on · Shift+Tab to leave`、`plan mode off`，或排队措辞，由 `set` 返回的结果决定。

**通知滚走之后模式仍然可见。** 有效模式生效期间，页脚首行会在生命周期状态旁追加 `plan` 标记；部署挂载了 plan 模式时，空输入框会列出 `Shift+Tab plan`。该 service 是可选的：`ctx.get('planMode')` 为空时给出通知且不改变状态，提示与标记也都不显示。

**不新增会话事件。** 插件既有的 `plan/mode` 追加与用户切换通知就是全部持久记录，因此该切换与手输 `/plan` 的重建方式完全一致，且本身不新增请求。

## 备选方案

**通过命令注册表执行 `/plan` 或 `/plan off`。** 一条代码路径就能统一切换文案并记录 `command/run`/`command/done`，浏览器 chip 也正是这么做的。它没有被采用，因为终端在进程内运行，而 `PlanModeController.set` 才是公开的选择 API：命令路径会为一个按键引入异步结算与 `commands` 依赖，并且其 projection 状态滞后于页脚必须读取的同 tick 排队值。

**像参考 agent 那样循环权限模式。** 用一个键在普通、自动接受与 plan 之间移动。它没有被采用，因为 plan 模式是一种协作状态，而 sandbox 与 approval 策略是各自独立、各自组合的接缝；一个按键无法在不发明本 harness 并未建模的组合模式的情况下循环它们。

**改读 `plan` 会话 projection，而不是 service。** projection 正是浏览器 chip 消费的界面。它没有被采用，因为其 `pending` 值派生自 `command/run`/`command/done`，所以一个仍在等待 pre-step 的直接 service 选择会被读成未选中。

## 后果

终端用户无需离开输入框即可切换 plan 模式，且通知滚走后页脚仍保持模式可见。应用以自己的界面口吻拥有两条新通知文案，该能力依赖 base 平面目前会挂载的可选 service。

## 测试

`tests/tui-app.spec.ts` 在 turn-boundary projection 之上挂载真实的 plan-mode service，断言 `Shift+Tab` 能开启与关闭模式且页脚显示标记、未挂载该 service 的部署会如实报告、模态提示持有键盘时按键无效、打开的 turn 会把变更排队为 pending，以及 kitty 协议的按下+释放只切换一次。`tests/transcript.spec.ts` 覆盖页脚标记。该界面没有 recorded-session 快照，因此由包测试承担验收。
