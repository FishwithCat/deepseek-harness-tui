# Agent Note: 在终端提示中显示问题详情

Status: implemented

[English](2026-09-13-tui-question-detail.md) | 中文

## 问题

plan 模式通过 `exit_plan_mode` 提交完整计划，其 `userQuestions.ask` 请求把计划作为问题的 `detail` 携带；[plan 策略](../../../../packages/bundle/base/cordis.patch.yml)要求模型不要把计划作为普通回复重复。终端应答器（[`src/interactions.ts`](../../../../packages/bundle/tui-app/src/interactions.ts)）只渲染问题文本与选项标签，因此 plan review 只显示 `Approve` / `Keep planning` 而没有计划：[prompt-rows](2026-09-11-tui-prompt-rows.zh.md) 面板没有详情区域。其他路径也帮不上忙，工具行会把 `exit_plan_mode` 的参数压成一行 96 列。浏览器界面已经通用地渲染 `detail` 并带有 plan-review 面板，因此终端是例外。

## 决策

`InteractionHost.choose` 与 `ask` 接受可选的 `detail`，`installQuestionAnswerer` 传入 `question.detail`；应答器仍只负责呈现，计划的批准标签与答案编码不变。

`DetailBody`（[`src/views.ts`](../../../../packages/bundle/tui-app/src/views.ts)）在存在 detail 时包裹选择器或输入框。它把 markdown 渲染在一个视口中，视口大小取决于被包裹控件剩余的行数，因此两选项的 review 几乎把整个面板让给计划，而很长的选择器会让计划少一些。滚动溢出的详情与到达控件的选择项，其分工由 [plan-review wait 笔记](2026-09-13-tui-plan-review-wait.zh.md)负责；详情溢出时，一行滚动位置会标出可见范围。`showPrompt` 现在接受任意 `Component` 主体，面板的主体预算与 chrome 不变。

## 备选方案

**像浏览器 `PlanReviewPanel` 那样做 `plan-review` 专用呈现。** 它可以对齐 Web 界面的专用卡片，但会与通用路径重复，且只服务一种 intent。问题类型本就把 `detail` 声明为随问题渲染的支撑信息，因此在通用主体中兑现它，能同时修复所有带详情的问题与 plan review。

**在调用 `exit_plan_mode` 时把计划写入对话记录。** 这样计划能在模态关闭后保留，并随视口滚动，但需要在对话记录的折叠中对工具名做特判，而且当浮层持有键盘时，阻塞中的 review 仍然不显示计划。用户正是在模态中阅读计划，因此必须由模态渲染它。

**为详情嵌套一个 pi-tui `ScrollView`。** 主滚动属于备用屏幕视口，而浮层不会安装它，因此嵌套视图仍需自己的按键路由；`DetailBody` 就是那套路由，且不引入第二个布局节点。

## 后果

任何携带 `detail` 的问题现在都能在终端中阅读，plan review 会显示模型提交的原始计划。若某个控件占满整个主体预算，详情就没有行、也没有滚动提示，因此很长的选项列表可能遮住详情；plan review 的两个选项几乎把整个面板留给计划，而这正是本次改动针对的场景。plan review 的「继续规划」答案与滚动按键由 [plan-review wait 笔记](2026-09-13-tui-plan-review-wait.zh.md)负责。

## 测试

`tests/tui-app.spec.ts` 挂载真实的 plan-mode service、`UserQuestionService` 与 TUI 应答器，通过 `ctx.tools.execute` 驱动 `exit_plan_mode`，断言计划文本与批准选项出现在合成的备用屏幕帧中，且批准返回 `{ approved: true }`。第二个用例提出 40 行详情，断言 PageDown 与 PageUp 移动视口、渲染器 `invalidate` 后能重绘，并且 Enter 仍返回所选标签。第三个用例断言无选项问题会在自由文本输入之上显示其详情。该界面没有 recorded-session 快照，因此由包测试承担验收。
