# Agent Note: The TUI consumes Host tool presentation views

Status: implemented

English | [中文](2026-09-13-tui-host-tool-presentation.zh.md)

## Problem

[Client-derived tool presentation](2026-08-23-client-derived-tool-presentation.md) kept `ToolDefinition.presentCall`, `ToolDefinition.presentResult`, `ToolCallView`, and `ToolResultView` as Host APIs while the Web Client derived its cards from raw events and persisted `meta`. That decision deliberately left one thing unresolved: no production consumer called the Host presenters, and the terminal surface rendered every Tool as a name, a one-line argument summary, and the raw result text. A file mutation therefore showed its confirmation sentence — `The file foo.ts has been updated successfully.` — while `dsh-tool-fs` had already computed the applied contextual hunks and persisted them in `tool/result` `meta`, and had already declared a `card: 'diff'` view for the same call.

## Decision

**The terminal surface is the Host consumer those presenters were kept for.** [`src/tool-view.ts`](../../../../packages/bundle/tui-app/src/tool-view.ts) resolves `ctx.tools.get(name, agent())` while the transcript folds one `tool/call` or `tool/result` event and hands the declared call or result view to the transcript unchanged. The renderer switches on the card tag: `generic` draws the Tool's title and salient raw input, `terminal` its command, description, working directory, output, and exit-status pill, `diff` a unified diff, `read` a numbered line window with its extent, `search` its grouped matches or path list with the cap signal, and `web` its cited sources or fetch summary.

**Resolution happens in the fold, not the render.** `Transcript` takes an optional `ToolPresentationResolver`; `app.ts` supplies the registry-backed one, and tests pass a fixed one or none. The fold therefore stays deterministic per event, and no view object reaches the session log, a request, or the render path.

**Resolution is explicit and degrades safely.** The bridge parses the raw arguments JSON as a model boundary (object only), calls the presenter inside `try`/`catch`, and returns `undefined` for an unknown Tool, a missing registry, malformed arguments, or a presenter throw. Every `undefined` leaves the row in its name-and-summary rendering, so a Tool that declares no view degrades to ordinary text instead of failing the turn.

**A settled result view replaces the pending view, with two rules.** A successful result installs the Tool's result view; a result view the Tool did not declare leaves the call-time view in place, which is what keeps a `str_replace_editor` mutation visible after it settles. A failed mutation clears the views outright, because the change was not applied (or was rolled back) and the model-facing error text is the fact the user needs.

**One renderer switches on the card tag.** `src/views.ts` resolves the row's card from the call and result views, preferring the result and keeping the call's title, working directory, and description where the result omits them. Every card draws as terminal rows, so a read window carries no syntax highlighting and a generic card's `kind` icon and `locations` follow-along are not drawn.

**The diff body is a real unified diff.** `src/diff.ts` re-derives each line's context/added/removed role from the hunk's two sides with `diffLines` from the `diff` package, which replaces the whole-old-side-then-whole-new-side layout the Web `DiffBlock` draws: on a narrow scrolling surface, repeating three context lines per side doubles the body for no added meaning. A single-file card omits the path row because its heading already names the file; a multi-file card opens each file with its path, and a later hunk of one file opens with a `⋯` gap. The heading carries the Tool's declared title plus `+added -removed`, and every card body is bounded before it reaches the screen.

## Alternatives considered

**Re-derive diffs from raw arguments and `meta` in the terminal, as `ui-tool`'s `diff-card-model.ts` does.** It lost because the terminal runs in-process beside the Tool registry: re-deriving would duplicate the `write`/`edit`/`str_replace_editor` argument knowledge and the card-shape rules on a second plane, and would drift silently whenever a Tool's presenter changed. The Host presenters exist so a Host consumer need not know Tool names at all.

**Extend `FileDiff` to carry per-line roles, so no second diff pass is needed.** It lost on blast radius: `FileDiff` is the shared presentation vocabulary consumed by the Web `DiffBlock`, `ui-tool`'s card models, and both mutation Tools' tests, while the terminal only needed the roles for its own rendering. The local `diffLines` pass keeps the change inside this package.

**Port `ui-tool`'s card models into the terminal.** It lost because those models re-derive every card from raw event blocks and persisted `meta` for a wire boundary the terminal does not have: the terminal runs in-process beside the Tool registry, so a presenter already returns the typed view. Copying the Web narrowing would duplicate its validation and drift from the presenter.

**Let a presenter throw reach the fold.** It lost because the presenter is called from a `session/event` listener mid-turn: a defect in one Tool's presenter would abort the fold for the rest of the turn. The bridge swallows the throw and degrades to the raw row, which is the same outcome a missing presenter produces.

## Consequences

The terminal surface is the first production consumer of the Host tool-presentation APIs, and it owns the mapping from a declared card to terminal rows. The Web Client is unchanged and still derives its cards from raw events; the two surfaces now read the same Tool declarations through different paths, which the shared `presentationMeta` projection keeps aligned. No session event, prompt section, request header, or durable format changes: a card is derived from data the `tool/call` and `tool/result` events already carry, and the model-visible result text is untouched — it is only not repeated under a card body. The surface gains a peer dependency on `@deepseek-ai/dsh-tools` and a runtime dependency on `diff`. The terminal draws every card as plain text, and the package README records what that leaves out — read syntax highlighting, the generic `kind` icon, and `locations` follow-along.

## Testing

`tests/tool-view.spec.ts` pins the bridge over the real `ToolRuntime`: pending and settled views passed through unchanged, a generic card, an unknown Tool, a missing registry, non-object arguments, a throwing presenter, and the settled result projection handed through. `tests/diff.spec.ts` pins the pure row model: roles, a create, a full deletion, an empty change, an interior blank line, the same-file gap, and multi-file path headers. `tests/transcript.spec.ts` pins the fold (pending view, settled replacement, call-time retention, error clearing, an empty hunk list, a missing resolver, and the resolver's inputs) and the rendering of every card — generic title and raw input, a fenced generic body, terminal description, cwd, output, and exit pill, read extents and folding, grouped and capped search results, web sources and fetch summaries, diff totals, folding, and the width bound. `tests/tui-app.spec.ts` drives one mutation through the real registry and asserts the composited terminal shows the diff instead of the result sentence. This surface has no recorded-session snapshot, so the package tests own the acceptance.
