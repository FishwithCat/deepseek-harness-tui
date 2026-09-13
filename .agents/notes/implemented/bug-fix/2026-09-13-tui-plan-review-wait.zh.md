# Agent Note: 让终端 plan review 等待用户

Status: implemented

[English](2026-09-13-tui-plan-review-wait.md) | 中文

## Problem

[终端详情弹层](2026-09-13-tui-question-detail.zh.md)虽然渲染了 plan review，却只能用 PageUp/PageDown 滚动；方向键移动的是「批准／继续规划」选择器，因此比面板更高的计划在没有这些按键的键盘上很难阅读。选择「继续规划」还会把该标签作为答案返回模型，其工具结果要求模型修改并重新提交，于是 Agent 立即开始下一轮计划修改，而没有给用户说话的机会。

## Decision

**溢出的详情占用 Up/Down，Left/Right 移动选择器。** `DetailBody`（[`src/views.ts`](../../../../packages/bundle/tui-app/src/views.ts)）在详情溢出时，Up/Down 按一行、PageUp/PageDown 按一屏滚动其 markdown，并把 Left/Right 与 Tab/Shift+Tab 交给选择步进器；`choose` 把该步进器接到 `SelectList` 跟踪的索引上。详情放得下时，所有按键都原样交给控件；控件占满整个主体的行数时详情没有行可用，也同样保留按键。只要主体收到滚轮事件就滚动详情，`PromptPanel` 会把鼠标事件越过它的两行外框转发给弹层主体。

**「继续规划」把 turn 交还给用户。** `installQuestionAnswerer`（[`src/interactions.ts`](../../../../packages/bundle/tui-app/src/interactions.ts)）把 plan review 的非批准选择视为用户保留计划、想另行说明：不回答该问题，而以 `ASK_CANCELLED` 让其失败——plan 模式把该码理解为用户收回了 turn，并回答「留在 plan 模式，到此为止，等待用户的消息」。review 关闭，plan 模式保持开启，用户的下一条提示承载调整内容。没有 plan-review 意图的问题被取消时仍以 `ASK_ABORTED` 失败。

## Alternatives considered

**在「继续规划」上收集自由文本反馈。** 把输入文本作为答案的 `custom` 字段返回可以保留该标签的「修改」语义，但字段一提交模型就会修改；用户要的是留住这个 turn，而不是在同一动作里再写一版计划。

**只用 PageUp/PageDown 与滚轮滚动详情。** 这样能保留选择器的方向键，但没有专用 PageUp/PageDown 的笔记本键盘就无法阅读计划，而这正是所报告的缺陷。

**在 plan-mode 工具内部结束 keep-planning 那个 turn。** 结束 turn 的标记只存在于成功的工具结果上，而被拒绝的 review 是一个错误；该接缝自身的取消码正是 plan 包为此结果已经提供的机制。

## Consequences

终端用户可以用键盘上已有的方向键滚动长计划，并用 Left/Right 在两个决定之间切换；提示行会写明这一分工。选择「继续规划」不再返回 review 答案，因此终端无法用一个动作请求自动修改：调整内容就是用户的下一条提示。该行为只作用于终端；浏览器 plan-review 卡片仍保留其 `Refuse` 答案。

## Testing

`tests/transcript.spec.ts` 直接驱动 `DetailBody`：详情溢出时 Up/Down 与滚轮移动视口，PageUp 移动一屏，Left/Right 与 Tab 调用选择步进器，放得下的详情把 Up/Down 转交控件，而控件不给详情留行时也保留按键。`tests/tui-app.spec.ts` 挂载真实的 plan-mode 服务，并通过 `exit_plan_mode` 提交一份长计划：Down 滚动详情，Right 选中「继续规划」，Enter 使工具以「等待消息」错误返回。短详情下 Up/Down 仍用于选择器，普通问题被取消时仍以 `ASK_ABORTED` 失败。
