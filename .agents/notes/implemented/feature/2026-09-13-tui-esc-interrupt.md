# Agent Note: TUI Escape interrupt

Status: implemented

English | [中文](2026-09-13-tui-esc-interrupt.zh.md)

## Problem

The [fork terminal surface](../architecture/2026-09-11-fork-terminal-surface.md) bound one key to cancelling a running turn, and it doubled as the exit gesture: Ctrl+C cancels while the Agent works and exits when it is idle. A user who wants to stop a generation without risking the session had no gesture that only interrupts, and Escape — the key a full-screen terminal application conventionally binds to cancelling the current operation — reached the composer and did nothing. The transcript already renders a cancelled assistant row, and `TuiSession.cancel()` already owns the Agent's `{ kind: 'user' }` cancellation, so the surface was missing only the binding. Background continuable children, the default shape of the base `subagent` tool, outlive the parent turn that started them, so cancelling only that turn left delegated work running behind an idle Agent with no terminal control that could stop it.

## Decision

**Escape interrupts the running turn; Ctrl+C keeps its dual role.** `registerKeys` matches `Key.escape` in the input listener that runs before the focused composer and calls the same cancellation Ctrl+C does, extracted as `interrupt()`. Escape is consumed only while the session has work in flight: on an idle session it returns the key to the composer and never exits, so the gesture cannot end a session by itself. Ctrl+C is unchanged — cancel while working, exit while idle.

**The session's live subagents stop with its turn.** `TuiSession` tracks the local activations in flight from the `subagent/start` / `subagent/end` lifecycle pair, so `busy` reports `running` while a resident continuable child or an in-flight one-shot still works, even after the parent turn that started it ended. `cancel()` aborts the Agent and then interrupts every tracked child through `SubagentRuntime.interrupt(id, { kind: 'ancestor', agent })`, the same authority the `interrupt_agent` tool uses. An external execution owns no local child and is not this surface's to stop, and a composition without the subagent service stops only the Agent. Steering stays keyed to the Agent's own turn: an idle Agent whose subagent is running still accepts an ordinary prompt.

**A focused prompt owns Escape.** The binding returns the key whenever a modal prompt is up, exactly as Ctrl+C and Shift+Tab do ([plan-mode toggle](2026-09-13-tui-plan-mode-toggle.md)), so Escape keeps dismissing a picker or a question instead of interrupting the turn that asked it. The alternate-screen viewport registers its input listener before the app does, so an open transcript search keeps Escape to close itself; only after the search closes does the same key interrupt.

**The hint advertises both keys.** The empty composer's busy-state hint becomes `Esc/Ctrl+C cancel`, so the interrupting gesture is discoverable without reading the README.

## Alternatives considered

**Rebind Ctrl+C to interrupt only, and leave Ctrl+D as the single quit key.** Ctrl+D already exits, so Ctrl+C's exit branch is redundant. It lost because Ctrl+C is the panic gesture users already reach for: removing its exit role would strand a user who has not learned Ctrl+D while the running case behaves identically either way.

**Let Escape clear the composer draft while idle.** A common terminal-editor binding. It lost because the surface has no draft-preservation model beyond the composer itself, and reusing the interrupt key for an unrelated edit would make one Escape mean different things with no visible affordance.

**Exit the session on Escape while idle.** It lost because it reproduces exactly the danger this change removes from Ctrl+C: an interrupt key that can end the session.

**Leave delegated subagents running while Escape interrupts only the turn.** The continuation manager deliberately keeps an accepted background child alive across caller cancellation, so this is the behavior of the Agent primitive alone. It lost because the terminal surface owns no other control that reports or stops those children: a user who stops the session would keep paying for delegated work they cannot see, and a later prompt could race a child still writing to the same workspace.

**Stop descendants by draining their Activations.** `drainDescendants()` closes subagent admission below the parent until that Agent leaves the registry. It lost because a per-turn interrupt must leave the session able to delegate again.

**Read the running descendants back from the service.** The removed `runningDescendantIds()` walked the live Agent registry synchronously, and `listDescendants()` now answers the same question asynchronously from durable catalogs. It lost because `busy` is read on every repaint: a catalog read per frame would couple the footer to Session query, and the lifecycle pair already reports exactly the activations that started and have not settled.

## Consequences

A terminal user can stop a running turn and the delegated work it started with the conventional key, and cannot end the session by accident. The surface owns one extracted helper and one new hint string, tracks the lifecycle pair, and stops each child through the public `interrupt()`. The subagent seam keeps its per-child `interrupt()` path; the terminal reads no package-private descendant state and adds no service API. No session event, prompt section, or request changes: the cancellation path is the one Ctrl+C already recorded, so a replay reconstructs the same `[cancelled]` row.

## Testing

`tests/tui-app.spec.ts` asserts that Escape cancels a running turn, reports the notice, and does not exit; that an idle Escape neither cancels nor exits; that a focused modal prompt dismisses on Escape instead of interrupting the turn; and that, in the alternate screen, an open transcript search consumes Escape before the app does and the next Escape then interrupts. It also asserts that Escape and Ctrl+C interrupt a subagent whose `subagent/start` has no `subagent/end` while the Agent itself is idle — Ctrl+C does not exit — that the footer reports `running` and offers the cancel keys while only a subagent works, and that the footer returns to idle when the subagent settles. The scripted subagent service records the interrupted child ids, so the tests cover the ancestor-authority stop without the removed service read. This surface has no recorded-session snapshot, so the package tests own the acceptance.
