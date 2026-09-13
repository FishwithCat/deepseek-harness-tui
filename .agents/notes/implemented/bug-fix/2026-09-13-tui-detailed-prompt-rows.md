# Agent Note: Give a detailed terminal prompt the rows above the pinned footer

Status: implemented

English | [中文](2026-09-13-tui-detailed-prompt-rows.zh.md)

## Problem

The prompt panel capped its height at `PROMPT_PANEL_MAX_ROWS = 18` for every body ([prompt rows](2026-09-11-tui-prompt-rows.md)), and the detail body ([question detail](2026-09-13-tui-question-detail.md)) inherited that cap. A plan review's body budget was `18 − 2` chrome `= 16` rows, and after the two option rows and the scroll hint the plan itself had 13 rows. Measured through `DetailBody`, terminals of 24, 30, 40, and 50 rows all showed 12–13 plan rows: the plan's reading area did not grow with the terminal, so a plan longer than a screenful read through a small window on a large terminal. The cap existed for long pickers, but `PROMPT_VISIBLE_ITEMS = 10` already bounds the visible list below the panel budget, so the cap only ever bound the detail.

## Decision

**A detailed prompt takes the rows the terminal leaves it; a detail-less picker keeps the cap.** `promptPanelRows(rows, detailed)` ([`src/views.ts`](../../../../packages/bundle/tui-app/src/views.ts)) returns `rows − 2`, floored at one body row, when the body carries scrollable detail, and the 18-row cap otherwise. `TuiApp.choose` and `ask` ([`src/app.ts`](../../../../packages/bundle/tui-app/src/app.ts)) derive `detailed` from their optional `detail` and pass it through `promptRows` to `showPrompt`, which uses it for the overlay's `maxHeight`; the same flag sizes `capacity`, so the picker's visible count and the detail's viewport come from one number. Scrolling keys, the control's own bindings, the pinned composer and footer, and the inline/alternate placement are unchanged.

A 30-row terminal now gives the plan 18 rows, a 40-row terminal 28, and a 50-row terminal 38, against 12–13 before. A 24-row terminal is unchanged, because `rows − 2` was already below the cap there.

## Alternatives considered

**A full-screen takeover that hides the composer and footer.** It gains only `PINNED_FOOTER_ROWS = 5` rows, changes the documented "reads as the transcript's next lines" placement, and hides the surface the user returns to after Keep planning hands the turn back. The fixed cap, not the pinned footer, is the defect.

**Raise the cap for every panel.** The visible picker list is already bounded by `PROMPT_VISIBLE_ITEMS`, so this is observationally identical today, but it deletes the documented bound a future control would rely on and leaves which bodies need the room implicit.

**Shrink the chrome.** Dropping the blank row or folding the scroll hint into the control gains one or two rows; it does not remove the terminal-size independence.

**Half-page scroll keys (`Ctrl+U`/`Ctrl+D`, Home/End).** A larger viewport addresses the reported defect; extra keys widen the routed input surface. Deferred.

## Consequences

A detailed prompt can occupy nearly the whole screen above the pinned composer and footer, and the transcript stays hidden behind it until the prompt closes. The panel's height is computed when the prompt opens, so resizing the terminal during a review does not resize the panel — recorded as a [known limitation](../../../../packages/bundle/tui-app/README.md#known-limitations-and-deferred-work) of the surface. The picker cap survives as the documented panel bound even though `PROMPT_VISIBLE_ITEMS` binds first.

The [prompt-rows](2026-09-11-tui-prompt-rows.md) and [question-detail](2026-09-13-tui-question-detail.md) notes keep their decisions; their `promptPanelRows` facts now describe the detail-less case.

## Testing

`tests/transcript.spec.ts` pins the budget for both bodies and the floor: 18 and 11 rows without a detail, 38 and 11 with one. `tests/tui-app.spec.ts` drives a 30-line plan through `exit_plan_mode` on a 30-row alternate screen and asserts the scroll hint's `1–18/…` viewport plus more than 18 rows between the panel's title and the composer's top border. This surface has no recorded-session snapshot, so the package tests own acceptance.
