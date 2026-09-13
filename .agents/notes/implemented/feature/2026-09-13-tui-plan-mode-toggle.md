# Agent Note: TUI plan-mode toggle

Status: implemented

English | [中文](2026-09-13-tui-plan-mode-toggle.zh.md)

## Problem

The [fork terminal surface](../architecture/2026-09-11-fork-terminal-surface.md) could switch the model route and the reasoning effort, but had no gesture for the session's collaboration mode. Plan mode is [logged per-agent collaboration state](../simplification/2026-07-22-plan-specific-collaboration-state.md) that adds the `plan:policy` prompt section and gates `exit_plan_mode`; the terminal could only reach it by typing `/plan` and `/plan off`, while the browser composer chip leaves it with one press. A user working in the terminal had no equivalent key.

## Decision

**`Shift+Tab` toggles plan mode for the app's own Agent.** `registerKeys` matches `Key.shift('tab')` in the input listener that runs before the focused composer, consumes it, and returns the key to the composer whenever a modal prompt owns the keyboard — the rule Ctrl+C already follows.

**The toggle drives `PlanModeController` directly.** The app reads the effective mode with `get(agent)` — `pending ?? active`, so a queued selection counts — and calls `set(agent, !effective)`. `set` updates its queued selection synchronously, so the footer and hint are correct in the same tick even while a turn is open; the projection-based `pending` would only appear after the paired command lifecycle settles. The result is reported as an app notice: `plan mode on · Shift+Tab to leave`, `plan mode off`, or the queued wording, chosen from `set`'s returned outcome.

**The mode stays visible after the notice scrolls.** The footer's head line appends a `plan` mark beside the lifecycle state while the effective mode is active, and the empty composer lists `Shift+Tab plan` when the deployment mounts plan mode. The service is optional: `ctx.get('planMode')` returning nothing produces a notice and no state change, and the hint and marker stay absent.

**No new session event.** The plugin's existing `plan/mode` append and user-switch notice are the whole durable record, so the toggle reconstructs exactly as a typed `/plan` does and adds no request of its own.

## Alternatives considered

**Execute `/plan` or `/plan off` through the command registry.** One code path would own the transition copy and record `command/run`/`command/done`, and it is what the browser chip does. It lost because the terminal runs in-process and `PlanModeController.set` is the public selection API: the command path adds an async settlement and a `commands` dependency for a key gesture, and its projection state lags the in-tick queue that the footer must read.

**Cycle permission modes like the reference agent.** A single key could move through normal, auto-accept, and plan. It lost because plan mode is a collaboration state while the sandbox and approval policies are independent seams with their own composition; one key cannot cycle them without inventing a combined mode this harness does not model.

**Read the `plan` session projection instead of the service.** The projection is the surface the browser chip consumes. It lost because its `pending` value is derived from `command/run`/`command/done`, so a direct service selection still awaiting its pre-step would read as unselected.

## Consequences

A terminal user can switch plan mode without leaving the composer, and the footer keeps the mode visible after the transcript notice scrolls away. The app owns two new notice strings in its own surface voice, and the feature depends on an optional service that the base plane mounts today.

## Testing

`tests/tui-app.spec.ts` mounts the real plan-mode service over the turn-boundary projection and asserts that `Shift+Tab` turns the mode on and off with the footer marker, that a deployment without the service reports it, that a modal prompt keeps the keyboard, that an open turn queues the change as pending, and that a kitty press+release toggles exactly once. `tests/transcript.spec.ts` covers the footer marker. This surface has no recorded-session snapshot, so the package tests own the acceptance.
