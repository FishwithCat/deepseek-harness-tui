# Agent Note: TUI Escape interrupt

Status: implemented

English | [中文](2026-09-13-tui-esc-interrupt.zh.md)

## Problem

The [fork terminal surface](../architecture/2026-09-11-fork-terminal-surface.md) bound one key to cancelling a running turn, and it doubled as the exit gesture: Ctrl+C cancels while the Agent works and exits when it is idle. A user who wants to stop a generation without risking the session had no gesture that only interrupts, and Escape — the key a full-screen terminal application conventionally binds to cancelling the current operation — reached the composer and did nothing. The transcript already renders a cancelled assistant row, and `TuiSession.cancel()` already owns the Agent's `{ kind: 'user' }` cancellation, so the surface was missing only the binding.

## Decision

**Escape interrupts the running turn; Ctrl+C keeps its dual role.** `registerKeys` matches `Key.escape` in the input listener that runs before the focused composer and calls the same cancellation Ctrl+C does, extracted as `interrupt()`. Escape is consumed only while the Agent is running: on an idle Agent it returns the key to the composer and never exits, so the gesture cannot end a session by itself. Ctrl+C is unchanged — cancel while running, exit while idle.

**A focused prompt owns Escape.** The binding returns the key whenever a modal prompt is up, exactly as Ctrl+C and Shift+Tab do ([plan-mode toggle](2026-09-13-tui-plan-mode-toggle.md)), so Escape keeps dismissing a picker or a question instead of interrupting the turn that asked it. The alternate-screen viewport registers its input listener before the app does, so an open transcript search keeps Escape to close itself; only after the search closes does the same key interrupt.

**The hint advertises both keys.** The empty composer's running-state hint becomes `Esc/Ctrl+C cancel`, so the interrupting gesture is discoverable without reading the README.

## Alternatives considered

**Rebind Ctrl+C to interrupt only, and leave Ctrl+D as the single quit key.** Ctrl+D already exits, so Ctrl+C's exit branch is redundant. It lost because Ctrl+C is the panic gesture users already reach for: removing its exit role would strand a user who has not learned Ctrl+D while the running case behaves identically either way.

**Let Escape clear the composer draft while idle.** A common terminal-editor binding. It lost because the surface has no draft-preservation model beyond the composer itself, and reusing the interrupt key for an unrelated edit would make one Escape mean different things with no visible affordance.

**Exit the session on Escape while idle.** It lost because it reproduces exactly the danger this change removes from Ctrl+C: an interrupt key that can end the session.

## Consequences

A terminal user can stop a running turn with the conventional key and cannot end the session by accident. The surface owns one extracted helper and one new hint string. No session event, prompt section, or request changes: the cancellation path is the one Ctrl+C already recorded, so a replay reconstructs the same `[cancelled]` row.

## Testing

`tests/tui-app.spec.ts` asserts that Escape cancels a running turn, reports the notice, and does not exit; that an idle Escape neither cancels nor exits; that a focused modal prompt dismisses on Escape instead of interrupting the turn; and that, in the alternate screen, an open transcript search consumes Escape before the app does and the next Escape then interrupts. This surface has no recorded-session snapshot, so the package tests own the acceptance.
