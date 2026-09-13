# Agent Note: Keep a terminal plan review waiting

Status: implemented

English | [中文](2026-09-13-tui-plan-review-wait.zh.md)

## Problem

The [terminal detail modal](2026-09-13-tui-question-detail.md) rendered a plan review but scrolled it only with PageUp/PageDown; the arrow keys moved the Approve / Keep planning picker instead, so a plan taller than the panel was hard to read on a keyboard without those keys. Choosing Keep planning also answered the model with the label, whose tool result tells the model to revise and present again, so the agent started another plan revision immediately instead of giving the user a turn to say what to change.

## Decision

**The overflowing detail owns Up/Down; Left/Right moves the picker.** `DetailBody` ([`src/views.ts`](../../../../packages/bundle/tui-app/src/views.ts)) scrolls its markdown by one row on Up/Down and by a viewport on PageUp/PageDown while the detail overflows, and hands Left/Right and Tab/Shift+Tab to a selection stepper that `choose` wires to the `SelectList`'s tracked index. While the detail fits, every key reaches the control unchanged; a control that spends the whole body budget leaves the detail no rows and also keeps the keys. The wheel scrolls the detail whenever the body sees one, and `PromptPanel` forwards mouse events past its two chrome rows so the overlay body receives them.

**Keep planning hands the turn back.** `installQuestionAnswerer` ([`src/interactions.ts`](../../../../packages/bundle/tui-app/src/interactions.ts)) treats a plan review's non-approve choice as the user keeping the plan to speak instead: it leaves the question unanswered and fails it with `ASK_CANCELLED`, the code plan mode reads as the user taking the turn back and answers with "stay in plan mode, stop here, and wait for their message". The review closes, plan mode stays active, and the user's next prompt carries the adjustment. A question with no plan-review intent still fails with `ASK_ABORTED` when dismissed.

## Alternatives considered

**Collect free-text feedback on Keep planning.** Sending typed text as the answer's `custom` field would keep the label's revise semantics, but the model revises as soon as the field is submitted; the user asked to keep the turn, not to author another revision in the same gesture.

**Scroll the detail only with PageUp/PageDown and the wheel.** It keeps the picker's arrow keys, but a laptop keyboard without dedicated PageUp/PageDown leaves the plan unreadable, which is the reported defect.

**End the turn from inside the plan-mode tool on a keep-planning answer.** The turn-ending marker exists only on a successful tool result, and a rejected review is an error, so the seam's own cancelled code is the mechanism the plan package already provides for this outcome.

## Consequences

A terminal user scrolls a long plan with the arrows the keyboard has and reaches both decisions with Left/Right; the hint line names the split. Choosing Keep planning no longer sends a review answer, so the terminal cannot request an automatic revision in one gesture: the adjustment is the user's next prompt. The behavior is terminal-local; the browser plan-review card keeps its `Refuse` answer.

## Testing

`tests/transcript.spec.ts` drives `DetailBody` directly: Up/Down and the wheel move the viewport while the detail overflows, PageUp moves it by a viewport, Left/Right and Tab call the selection stepper, a fitting detail forwards Up/Down to the control, and a control that leaves the detail no rows keeps the keys. `tests/tui-app.spec.ts` mounts the real plan-mode service and asks a long plan through `exit_plan_mode`: Down scrolls the detail, Right selects Keep planning, and Enter resolves the tool with the wait-for-message error. A short detail keeps Up/Down on the picker, and a plain question still fails with `ASK_ABORTED` when dismissed.
