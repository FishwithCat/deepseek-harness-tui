# Agent Note: Keep global TUI key bindings across a session replacement

Status: implemented

English | [中文](2026-09-13-tui-new-session-keys.zh.md)

## Problem

`/new` and `/resume` swap the live session through `replaceSession` ([`src/app.ts`](../../../../packages/bundle/tui-app/src/app.ts)). That method disposed every entry of one `disposers` array, but `registerKeys` had pushed the global input listener into the same array that `mount` seeded with the session subscriptions from `attach`. Replacing the session therefore removed the key listener, and `attach` re-registered only the session subscriptions. Every binding the listener owns — Shift+Tab ([plan-mode toggle](../feature/2026-09-13-tui-plan-mode-toggle.md)), Ctrl+D quit, Ctrl+C, Escape ([interrupt](../feature/2026-09-13-tui-esc-interrupt.md)), Ctrl+V, and Ctrl+L — went dead until the app restarted, while the composer hint kept advertising them.

## Decision

**Split the two disposer lifetimes.** `disposers` holds app-lifetime registrations, which today is the single input listener `registerKeys` installs; a new `sessionDisposers` array holds the five subscriptions `attach` adds for the current session. `replaceSession` retires only `sessionDisposers` before opening the replacement, and `teardown` drains both arrays. The binding code itself is unchanged.

## Alternatives considered

**Call `registerKeys` again from `replaceSession`.** It would restore the listener, but it keeps app-lifetime and session-lifetime registrations in one array, so the next app-lifetime subscription would be silently dropped by `/new` in the same way. The shared lifetime is the defect, so the fix separates it.

**Make the listener registration idempotent and re-add it in `replaceSession`.** A guard against duplicate listeners adds state without fixing the ownership mistake, and it still cannot distinguish a key binding from a session subscription.

## Consequences

Key bindings survive `/new` and `/resume`. The invariant is: `sessionDisposers` may only hold subscriptions that name the current session, and every app-lifetime registration belongs in `disposers`; `teardown` must drain both. The composer hint and footer are repainted by `refresh` after a replacement, so a stale hint was never hiding a live binding.

## Testing

`tests/tui-app.spec.ts` adds two cases. One runs `/new`, waits for `started a new session`, then feeds Shift+Tab and asserts the plan-mode notice; the other runs `/new` and feeds Ctrl+D to assert the app exits. Both fail when `replaceSession` disposes the key listener. This surface has no recorded-session snapshot, so the package tests own acceptance.
