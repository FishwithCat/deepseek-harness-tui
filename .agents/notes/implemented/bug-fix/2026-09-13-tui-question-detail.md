# Agent Note: Show a question's detail in the terminal prompt

Status: implemented

English | [中文](2026-09-13-tui-question-detail.zh.md)

## Problem

Plan mode routes the complete plan through `exit_plan_mode`, whose `userQuestions.ask` request carries the plan as the question's `detail`; the [plan policy](../../../../packages/bundle/base/cordis.patch.yml) tells the model not to repeat the plan as a plain reply. The terminal answerer ([`src/interactions.ts`](../../../../packages/bundle/tui-app/src/interactions.ts)) rendered only the question text and the option labels, so a plan review showed `Approve` / `Keep planning` with no plan: the [prompt-rows](2026-09-11-tui-prompt-rows.md) panel had no detail region. Nothing else surfaced the plan either, because a Tool row flattens `exit_plan_mode`'s arguments to one 96-column line. The browser surface already rendered `detail` generically and had a plan-review panel, so the terminal was the outlier.

## Decision

`InteractionHost.choose` and `ask` take an optional `detail`, and `installQuestionAnswerer` passes `question.detail`; the answerer still owns only presentation, and the plan's approve label and answer encoding are unchanged.

`DetailBody` ([`src/views.ts`](../../../../packages/bundle/tui-app/src/views.ts)) wraps the picker or input when a detail is present. It renders the markdown in a viewport sized to the rows the wrapped control leaves, so a two-option review gives the plan nearly the whole panel and a long picker leaves it less. Scrolling the overflowing detail and reaching the control's selection are the [plan-review wait note](2026-09-13-tui-plan-review-wait.md)'s split; a scroll-position line names the visible range once the detail overflows. `showPrompt` accepts any `Component` body, and the panel's body budget and chrome are unchanged.

## Alternatives considered

**A `plan-review` presentation like the browser's `PlanReviewPanel`.** It would mirror the web surface's dedicated card, but it duplicates the generic path and serves one intent. The question type already declares `detail` as supporting context rendered with the question, so honoring it in the generic body fixes every detailed question and the plan review together.

**Write the plan into the transcript when `exit_plan_mode` is called.** It would survive the modal and scroll with the viewport, but it needs a Tool-name special case in the transcript fold, and the blocking review would still show no plan while the overlay owns the keyboard. The modal is where the user reads the plan, so the modal must render it.

**Nest a pi-tui `ScrollView` for the detail.** The primary scroll belongs to the alternate-screen viewport and an overlay installs none, so the nested view would still need its own key routing; `DetailBody` is that routing with no second layout node.

## Consequences

Any question that carries `detail` is now readable in the terminal, and the plan review shows the exact plan the model submitted. A control that spends the whole body budget leaves the detail no rows and no scroll hint, so a very long option list can hide the detail; the plan review's two options leave it nearly the full panel, which is the case this change exists for. The plan review's Keep planning answer and the scrolling keys are owned by the [plan-review wait note](2026-09-13-tui-plan-review-wait.md).

## Testing

`tests/tui-app.spec.ts` mounts the real plan-mode service, `UserQuestionService`, and the TUI answerer, drives `exit_plan_mode` through `ctx.tools.execute`, and asserts the plan text and the approve option reach the composited alternate-screen frame and that approval returns `{ approved: true }`. A second case asks a 40-line detail and asserts PageDown and PageUp move the viewport, that a renderer `invalidate` redraws it, and that Enter still returns the selected label. A third asserts a no-option question shows its detail above the free-text input. This surface has no recorded-session snapshot, so the package tests own acceptance.
