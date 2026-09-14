# Agent Note: Restore the transcript when the alternate-screen TUI exits

Status: implemented

English | [中文](2026-09-14-tui-alternate-exit-restore.zh.md)

## Problem

The alternate screen owns the transcript while the app runs, and the terminal's own scrollback holds nothing. pi-tui's `TuiAltScreen` therefore promises that stopping it restores the main buffer and prints the complete final document, which is the only copy a user can select after the app exits. With [`src/app.ts`](../../../../packages/bundle/tui-app/src/app.ts)'s layout root, that restore wrote back only the composer and the footer. The transcript entry declared `basis: 0`, and pi-tui's `VStack.render` renders an unbounded document by allocating every child its basis, so the scroll view's slot became `rendered.slice(0, 0)`. A user who quit an alternate-screen run — the default `screen` — found the large output gone and could not select or copy it.

## Decision

The alternate-screen layout root in `mount()` pins the composer and footer with `shrink: 0` and gives the transcript `grow: 1` with no `basis`. With a bounded terminal height the stack still yields the transcript every row the composer and footer leave, so the viewport and the pinned chrome are unchanged; with the unbounded height the exit restore uses, each entry falls back to its intrinsic height, so `render(width)` contains the whole transcript. The exit path itself stays pi-tui's.

## Alternatives considered

**Patch pi-tui's `VStack.render` to treat a zero-basis, growing child as intrinsic when the height is unbounded.** That is the upstream defect — pi-tui's README documents `render(width)` as producing the unbounded document the restore relies on — but the [fork terminal surface](../architecture/2026-09-11-fork-terminal-surface.md) deliberately carries no patched pi-tui artifact, and a fork-local patch would have to be re-applied on every bump.

**Give the transcript `basis: 'auto'` while leaving the composer and footer shrinking.** It restores the transcript, but the shrink pass then divides the overflow across all three entries in proportion to their heights, so the composer and footer lose rows and unpin. `shrink: 0` keeps the transcript the only entry that yields.

**Write the document from the app before stopping the renderer.** The app would have to reproduce pi-tui's line resets, truncation, and synchronized output for the restore, duplicating library behavior the renderer already owns.

## Consequences

An alternate-screen run now leaves its transcript in the normal screen after exit, so the output can be selected and copied. `screen: 'inline'` was never affected because the terminal's scrollback owns that history. The layout declaration is less obvious than pi-tui's documented `basis: 0, grow: 1` example, so the declaration carries a comment naming the unbounded exit render as the reason.

## Testing

`tests/tui-app.spec.ts` boots the real app in alternate mode, appends an answered turn, clears the captured terminal output, and stops the app; it asserts the exit sequence and both the prompt and the reply text in the restored bytes. The test fails on the previous `basis: 0` declaration, where the restore held only the composer and footer.
