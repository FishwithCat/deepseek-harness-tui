# Agent Note: Render modal prompts as plain rows above the composer

Status: implemented

English | [中文](2026-09-11-tui-prompt-rows.zh.md)

## Problem

`/model`, `/resume`, approvals, and user questions rendered through one `PromptPanel` shown as an overlay: a bold title line, a blank line, then the picker or input body. The panel was borderless and at most 76 columns wide, while the pi-tui renderer composites an overlay only over the columns it declares and leaves the rest of each row as the transcript printed it. Transcript text therefore survived on the same rows as the prompt, on both sides of it, and read as part of it. In the reported `/model` case the `/help` notice had wrapped, so a continuation line (`<objective>|pause|resume]`) sat directly beside the panel's blank row and the first columns of `/goal`, `/permission`, and `/plan` merged with the panel's own text: `SSelect a model`, `S→ deepseek-…`, `E  deepseek-…`. The result neither read as output nor as a dialog.

## Decision

`PromptPanel` renders as ordinary output: one title line, one blank row, then the body, left aligned like a transcript row and given the full viewport width. Every row is padded to the width the overlay covers, so each row the panel occupies belongs to the panel and the transcript cannot show through beside it.

A picker's `SelectList` is built with `minPrimaryColumnWidth: 1` and `maxPrimaryColumnWidth: Number.MAX_SAFE_INTEGER`, which lets the value column grow to its widest label. The component's own default caps that column at 32 columns and shortens the value there, so every fully qualified `provider/model` route was cut mid-id; with the column sized to the content, the label shows in full and the component drops the description before it shortens a value when the panel is too narrow for both.

`showPrompt` gives the overlay the full terminal width and places it with `anchor: 'bottom-center'` plus a bottom margin of the layout's pinned rows (the composer's three and the footer's two). In the alternate-screen layout the panel therefore sits directly above the composer, where the transcript ends, and reads as its next lines. The inline layout has no pinned footer position, so it keeps the centered anchor.

`promptPanelRows(rows, detailed)` owns the height budget — at most 18 rows for a detail-less body and every available row for one that carries scrollable detail ([detailed prompt rows](2026-09-13-tui-detailed-prompt-rows.md)), never more than the rows available minus two, always leaving one body row — and `choose` sizes the visible list from that budget (reserving one body row when the list scrolls for `SelectList`'s indicator), so a picker on a short terminal scrolls inside the panel instead of running into the composer.

## Alternatives considered

**A bordered, centered floating frame.** A box with `┌ title ─┐` / `└─┘` rules separated the dialog from the transcript and was implemented first. It lost on presentation: the surface's other rows are plain text, so a boxed dialog introduced a second visual language, and the block floated over the transcript instead of continuing it.

**Write the list into the transcript.** Printing numbered rows like `/help` and interpreting the next submission as a choice would make the prompt part of the scrollback. It needs a pending-answer state that reroutes `submit`, invalid-input and cancel handling, and a follow-up row recording the answer; the list can also scroll out of view or, in the inline layout, stay in scrollback forever.

**Dim or paint a background behind the prompt.** The overlay renderer has no dim layer or background fill and the theme is attribute-and-foreground only; giving the covered rows to the panel achieves the same separation without a background color every terminal must render.

**Keep the panel centered instead of anchoring it above the composer.** The centering already exists and needs no layout knowledge, but a centered block reads as a floating dialog rather than as the transcript's next lines.

**Shorten the labels instead of growing the value column.** Dropping the provider prefix when the deployment registers one provider — as the footer's model label already does — would fit most ids into the component's default column. It lost because the picker sets the route the label shows, and a deployment with several providers still needs the full `provider/model`; sizing the column to the content keeps the label truthful at every provider count and yields the description first when space runs out.

## Consequences

A prompt now occupies whole rows above the composer: the transcript is hidden behind them and resumes above, and each picker row is a plain padded line. The panel spends two rows on chrome (title and blank row), so the body budget is `promptPanelRows` minus those two, and the app recomputes that budget whenever the chrome or the pinned footer changes. `PROMPT_PANEL_CHROME_ROWS` and the bottom margin are separate constants because the pinned rows belong to the app layout, not to the panel.

`tests/transcript.spec.ts` pins the title, blank row, body placement, the exact width of every row at several viewports, title truncation, and the row budget. `tests/tui-app.spec.ts` reads the composited alternate-screen frame and asserts that the picker's rows carry no transcript text, that they touch the composer's top border, that a long route and its description survive intact, and that a list longer than the budget scrolls inside the panel.
