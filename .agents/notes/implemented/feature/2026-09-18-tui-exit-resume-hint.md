# Agent Note: TUI exit resume hint

Status: implemented

English | [中文](2026-09-18-tui-exit-resume-hint.zh.md)

## Problem

The terminal surface already accepted `dsh --resume <session-id>` at startup and owned `/resume` and `/sessions` in the composer, but the id reached the user only while the app was open: it appeared in the `/sessions` list, and the alternate-screen restore repainted the transcript after exit. A user who closed the app with Ctrl+C had no printed pointer back, so continuing the conversation later meant having copied the id in advance or finding the stored session from the next invocation.

## Decision

**Exiting the app prints the resume command.** `TuiApp.stop()` writes two lines to stderr once the terminal is restored:

```
To resume this session:
  dsh --resume <session-id>
```

The id is read from the live session at exit, so it names the session in force when the app stopped — the replacement after `/new` or `/resume`, not the session the process booted with.

**The write follows the flush.** `stop()` tears down the surface, flushes the session, disposes it, and only then writes the hint before requesting the bounded exit. Flush is the durability barrier that materializes the session, including a header-only artifact for an explicitly flushed session with no events, so the printed command names something a later process can open.

**The hint requires a persistence backend.** It is written only when `ctx.get('sessionPersistence')` resolves. Without a backend there is nothing for `--resume` to open, and the app already refuses to resume through the same absence; the hint never advertises an operation the deployment cannot perform.

**stderr, not stdout.** The surface's stdout carries the restored transcript, and the launcher already routes boot failures through the same `internals.stderr` sink. The hint is a post-surface message about the process, not part of the transcript it just restored.

## Alternatives considered

**Print from the effect disposer that calls `teardown()`.** That path also runs on live config reloads and on the `stop()` teardown itself, so a hint there would fire on HMR and double-print on an ordinary exit; separating the signal case from the reload case needs a shutdown seam this app does not own. Every user exit gesture — Ctrl+C while idle, Ctrl+D, and `/quit` — already routes through `stop()`.

**Gate the hint on `session.seq > 0`.** It lost because the exit flush materializes even a session with no events, so an untouched session is resumable; the extra condition would suppress a truthful command right after launch, when the printed id is the only way the user learns it.

**Render the hint as a transcript notice before teardown.** It lost because a notice added immediately before teardown is never painted as a live frame: it would surface only in the alternate screen's restore repaint, while the inline screen has no restore step, so the two screen strategies would disagree.

**Spell the command `dsh --profile tui --resume <session-id>`.** It lost because a bare `dsh` boots the tui profile in this fork and `--resume` belongs to the app, so the short form matches how the app is normally launched and how the invocation is documented.

## Consequences

A user can always recover the session they just left, including one that produced no output. The surface owns one helper (`resumeHint`) and one line in the exit path; no session event, prompt section, request, or stored format changes, because the hint reads state the flush already committed. A deployment that removes persistence loses the hint along with `/resume` and `--resume`, which now agree. The hint hardcodes the `dsh` entry point and the short flag form, so a renamed binary or a non-default `DSH_DEFAULT_PROFILE` makes the printed command wrong; neither is knowable to the app from its own context.

## Testing

`tests/tui-app.spec.ts` asserts the exact two-line hint for a persisted session, that the id follows a `/new` replacement, and that no bytes reach the stderr sink when the composition mounts no persistence service. This surface has no recorded-session snapshot, so the package tests own the acceptance.
