# Agent Note: TUI restores the stored conversation on resume

Status: implemented

English | [中文](2026-09-18-tui-resume-history.zh.md)

## Problem

The terminal surface created or resumed the Agent and then subscribed to the live `session/event` log, but a resumed Session's earlier events are seeded into the Session rather than re-published. A user who ran `dsh --resume <session-id>`, or `/resume` in the composer, landed on an empty transcript: the model still held the conversation, but the screen showed only what happened after resume. The exit hint from the sibling note made the id easy to print and then handed the user a transcript that looked like a fresh session.

## Decision

**A resumed Session's stored events are folded into the transcript before the app accepts input.** `TuiApp.attach()` detects a seeded Session (`session.firstLiveSeq > 0`), reads the stored prefix through a new `TuiSession.history()`, and applies each event to the `Transcript` exactly as a live event would be applied.

**The read is the persistence backend's, not the deprecated in-memory snapshot.** `TuiSession.history()` opens the session with `ctx.sessionPersistence.open(id, 'read')` and reads `[0, firstLiveSeq)`. This keeps the change on the explicit asynchronous read path the [synchronous-read deprecation](../architecture/2026-09-09-deprecate-synchronous-session-event-reads.md) requires; the transcript is historical content presented on demand, and it needs the stored records rather than projected state.

**The read stops at `firstLiveSeq`.** Events appended after resume have a sequence at or above that boundary and reach the app through the live `session/event` subscription, so they are never folded twice.

**Events that land during the read are buffered.** The subscriptions are installed before the read starts; while it is in flight, the `session/event` listener appends to a buffer instead of the transcript. The buffer is applied after the stored rows, so log order survives a turn that starts while the history is still loading.

**`mount()` awaits the replay.** `TuiApp.boot()` awaits `mount()`, and `/resume`'s `replaceSession()` awaits `attach()` before reporting the switch, so a notice that follows a resume is appended after the restored rows rather than before them.

## Alternatives considered

**Call `session.snapshotEvents()` from production.** It is one synchronous call and needs no backend read, but it is the exact call the synchronous-read deprecation prohibits for new production code; the transcript also reads history rather than projected state, which is the documented asynchronous-read case.

**Attach after the replay instead of buffering.** A turn that starts during the read would then lose its events with no live subscription installed yet, and `/resume` can resume a goal or an overdue schedule that acts immediately. Buffering costs one array and one flag.

**Fold only on demand as the user scrolls.** Progressive loading would bound each read, but this surface's transcript is a single in-memory list with no scroll-triggered loader, and the acceptance the user asked for is the restored conversation on entry.

## Consequences

A resumed session now looks like the conversation it is: prompts, replies, Tool rows, and notices all return. The replay reads the stored log a second time (the resume path already read it) and folds it once the read resolves, so a very long session pays one extra backend read before the composer appears. History cannot be restored where the deployment mounts no persistence backend; that deployment cannot resume at all, and `history()` returns no rows.

## Testing

`tests/tui-app.spec.ts` boots `--resume` and `/resume` over a stub persistence backend and asserts the stored prompt and reply reach the transcript, that a live event landing inside the history read is applied after the stored rows, and that a backend refusing the read produces a transcript notice. The package tests own acceptance because this surface has no recorded-session snapshot.
