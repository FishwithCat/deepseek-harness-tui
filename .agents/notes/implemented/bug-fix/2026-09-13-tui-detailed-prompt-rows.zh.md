# Agent Note: 让带详情的终端提示占用固定页脚之上的行

Status: implemented

[English](2026-09-13-tui-detailed-prompt-rows.md) | 中文

## Problem

提示面板对每种主体都把自己的高度限制在 `PROMPT_PANEL_MAX_ROWS = 18`（[提示行](2026-09-11-tui-prompt-rows.zh.md)），而详情主体（[问题详情](2026-09-13-tui-question-detail.zh.md)）继承了这个上限。plan review 的主体预算是 `18 − 2` 行外框 `= 16` 行，再减去两行选项与滚动提示行，计划本身只有 13 行。用 `DetailBody` 实测：24、30、40 与 50 行的终端都只显示 12–13 行计划——计划的阅读区域不随终端增长，因此在大终端上，超过一屏的计划只能透过一个小窗口阅读。该上限本是为长选择器设置的，但 `PROMPT_VISIBLE_ITEMS = 10` 已经把可见列表限制在面板预算之内，所以该上限实际只约束了详情。

## Decision

**带详情的提示占用终端留给它的行；没有详情的选择器保留上限。** `promptPanelRows(rows, detailed)`（[`src/views.ts`](../../../../packages/bundle/tui-app/src/views.ts)）在主体带可滚动详情时返回 `rows − 2`（下限为一行主体），否则返回 18 行上限。`TuiApp.choose` 与 `ask`（[`src/app.ts`](../../../../packages/bundle/tui-app/src/app.ts)）从可选的 `detail` 推导出 `detailed`，经 `promptRows` 传给 `showPrompt`，后者用它设置弹层的 `maxHeight`；同一个标志也决定 `capacity`，因此选择器的可见条数与详情的视口出自同一个数值。滚动按键、控件自身的按键绑定、固定的输入框与页脚，以及 inline／备用屏幕的定位都保持不变。

30 行终端上的计划区域从 12–13 行变为 18 行，40 行终端为 28 行，50 行终端为 38 行。24 行终端不变，因为那里的 `rows − 2` 本就低于上限。

## Alternatives considered

**整屏接管，隐藏输入框与页脚。** 它只多出 `PINNED_FOOTER_ROWS = 5` 行，却会改变已记录的「像转录的下几行」定位，并隐藏用户在「继续规划」交回 turn 后要返回的界面。缺陷是固定上限，而不是固定页脚。

**对所有面板提高上限。** 可见的选择器列表本就被 `PROMPT_VISIBLE_ITEMS` 限制，因此今天在观感上完全相同，但它删掉了未来控件会依赖的已记录上界，也让「哪些主体需要这些空间」变得隐式。

**缩减外框。** 去掉空行或把滚动提示并入控件只能多出一两行；它无法消除对终端尺寸的无关性。

**半页滚动键（`Ctrl+U`/`Ctrl+D`、Home/End）。** 更大的视口已经解决所报告的缺陷；新增按键会扩大被路由的输入面。延后处理。

## Consequences

带详情的提示可以占据固定输入框与页脚之上的几乎整个屏幕，转录在提示关闭前一直隐藏在它后面。面板高度在提示打开时计算，因此在 review 期间调整终端大小不会改变面板——本界面的[已知限制](../../../../packages/bundle/tui-app/README.zh.md#known-limitations-and-deferred-work)记录了这一条。选择器上限作为已记录的面板上界保留下来，尽管 `PROMPT_VISIBLE_ITEMS` 先一步生效。

[提示行](2026-09-11-tui-prompt-rows.zh.md)与[问题详情](2026-09-13-tui-question-detail.zh.md)两个 note 保留各自的决策；其中关于 `promptPanelRows` 的事实现在描述的是无详情的情形。

## Testing

`tests/transcript.spec.ts` 固定两种主体与下限的预算：无详情为 18 与 11 行，有详情为 38 与 11 行。`tests/tui-app.spec.ts` 在 30 行的备用屏幕上通过 `exit_plan_mode` 提交一份 30 行计划，断言滚动提示显示的视口为 `1–18/…`，且面板标题与输入框上边框之间超过 18 行。本界面没有录制会话快照，因此由包测试负责验收。
