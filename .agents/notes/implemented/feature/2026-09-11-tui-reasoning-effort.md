# Agent Note: TUI reasoning effort switching

Status: implemented

English | [中文](2026-09-11-tui-reasoning-effort.zh.md)

## Problem

An exact model route declares the reasoning efforts its adapter accepts, and `installModelSelection` applies the one the live selection names to the next step's request config. The [fork terminal surface](../architecture/2026-09-11-fork-terminal-surface.md) had no way to see or change it: `/model` switched the route, the footer printed an effort only once one was explicitly selected, and every request used whatever the deployment default or the `agent-default-model` settings supplied. A user working in the terminal could not raise effort for a hard task or drop it for a latency-sensitive one without leaving the session.

## Decision

**`/effort` is a local app command shaped like `/model`.** With no input it opens the same plain-row picker (`src/views.ts` `PromptPanel`) listing the efforts `ctx.llm.resolveModelInfo(provider, model).reasoning` declares, in adapter order, showing each effort's adapter-owned name and description. With input it matches one declared effort id and applies it directly; an unmatched id reports `expected one of <ids>`, and a route whose adapter declares no reasoning metadata reports that and applies nothing.

**The picker offers a `Provider default` choice only when the adapter declares no default effort.** That choice clears the explicit effort so the request omits the field, which is a different request from naming any declared effort. When the adapter does declare a default, naming that effort is the same request, so no separate clear is offered — the rule the ACP surface's `reasoning_effort` option already follows, which keeps the two surfaces' option sets identical.

**Applying an effort rewrites the live selection, not the settings.** `applyEffort` calls `TuiSession.selectModel({ provider, model, reasoningEffort })` for the route in force, so `installModelSelection` binds the effort to the next assembled request, and the footer's `model • effort` label repaints from the same refresh. Nothing is written to the settings document, so the choice lasts for the session and not for the next Agent.

**`/model` clears the effort when it switches routes.** The new route's own default applies. Carrying the old effort forward could name an effort the new model does not accept, and `resolveCallConfig` rejects an unsupported explicit effort before provider I/O, so the carried value would fail the next turn instead of switching cleanly.

## Alternatives considered

**Fold the effort into `/model`'s picker as a second step.** One command could ask for the route and then the effort. It lost because the two choices change independently: raising effort mid-session is common and switching models is not, so a combined flow would make the frequent change take the long path.

**Name the command `/reasoning` or `/thinking`.** Those names read naturally in prose. They lost because the seam, the ACP option, the settings field, and the footer all call the value reasoning effort, and one vocabulary across surfaces is worth more than a shorter word.

**Always offer a `Provider default` clear.** A clear is only a distinct request when the adapter declares no default; offering it beside a declared default would create two options that produce the same request, which reads as a bug in the picker.

**Accept an effort's display name as well as its id.** `/effort High` would be friendlier than `/effort high`. It lost because ids are the opaque values the adapter accepts and the names are display metadata that may repeat or change; matching both would need a second lookup rule and an ambiguity policy for a five-character saving.

## Consequences

A terminal user can now switch reasoning effort from inside the session and read the result in the footer, and the picker's option set is exactly what the routed adapter declares — a model that supports only `off` offers only that, and a model with no reasoning metadata reports it instead of showing an empty list.

Each invocation resolves the routed model's metadata through `ctx.llm.resolveModelInfo`, which is a synchronous adapter lookup for every shipped adapter, and a model switch clears the effort rather than carrying it, so a user who wants the same effort on a new model selects it again.

## Testing

`tests/tui-app.spec.ts` drives the command through a scripted adapter that declares a DeepSeek-shaped effort set: the picker applies the chosen effort and the footer shows `test-model • off`; a dismissed picker applies nothing and its rows leave the composited alternate-screen frame; the `/effort <id>` form applies directly and rejects an unknown id by naming the accepted ones; a route that declares no reasoning reports that; and a route with no default effort offers `Provider default` and clearing it reports the provider default as the new state. The same file covers the sibling `/model` forms the fixture now reaches: the picker, its dismissal, the `/model provider/model` input, and a malformed route.
