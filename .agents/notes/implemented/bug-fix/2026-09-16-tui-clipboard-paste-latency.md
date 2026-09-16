# Agent Note: TUI clipboard paste latency

Status: implemented

English | [中文](2026-09-16-tui-clipboard-paste-latency.zh.md)

## Problem

The [clipboard image paste](../feature/2026-09-11-tui-clipboard-image-paste.md) read the macOS pasteboard through AppleScript's `the clipboard as «class PNGf»` coercion inside `osascript`, and the app requested no repaint while that child process ran. Wall-clock measurements of the reader alone, on a 904 KB PNG and a 5.76 MB PNG loaded onto the pasteboard, three runs each:

| Payload | `the clipboard as «class PNGf»` | `NSPasteboard.dataForType('public.png')` |
|---|---|---|
| 904 KB | 0.27–0.28 s | 0.04–0.06 s |
| 5.76 MB | 0.45–0.46 s | 0.04 s |

A read-only AppleScript variant that returned the data length instead of writing it still spent 0.47 s of child CPU, so the coercion — not the staged write — carried the cost. For that whole window the composer showed nothing, so Ctrl+V read as a freeze followed by a marker appearing.

## Decision

**The macOS reader asks `NSPasteboard` through `osascript`'s JavaScript runtime.** `readDarwin` runs `osascript -l JavaScript -e …` with a script that reads `$.NSPasteboard.generalPasteboard.dataForType('public.png')` and calls `writeToFileAtomically(stagePath, true)`; it answers `ok`, `empty` (no PNG on the pasteboard), or `failed` (the write did not land), and only `ok` reaches the staged-file read. The staging path is embedded as a JavaScript literal through `JSON.stringify`. AppleScript is gone rather than kept as a fallback: on the pasteboards that matter here the two readers agree, and the fallback would have no case to serve (see Alternatives).

**The footer reports the wait.** `TuiApp` counts clipboard reads in flight, `TuiStatus` carries `pasting`, and `StatusBar.headText` appends `pasting image…` beside the lifecycle state while the count is non-zero. The count is decremented in a `finally`, so the notice path, an early return after teardown, and overlapping pastes all settle truthfully. This covers the readers this change does not touch — the Windows and WSL PowerShell readers still start a PowerShell, an `Add-Type`, and an image encode — and any macOS read that stays slow under load.

## Alternatives considered

**Try JavaScript first, then the AppleScript coercion.** The fallback would run only when the pasteboard offers an image type but no PNG. It lost on measurement: a TIFF-only pasteboard returns `nil` for `public.png` *and* errors for `«class PNGf»`, and a JPEG-only pasteboard behaves the same, so the fallback would add a second child process to a path that already reports no image. A fallback with no observable case is speculative code.

**Reveal `pasting image…` only after a delay.** A delayed reveal avoids a brief flash when the read is fast. It lost because the flash is at most a couple of frames at pi-tui's 16 ms render interval while the delayed version needs a timer, its settle path, and its teardown path; a slow reader must show the wait immediately anyway.

**Prefer `pngpaste` when it is installed.** The Homebrew tool writes a pasteboard PNG in tens of milliseconds. It lost because it is not a program macOS ships, so it would add an install step and a second reader for a speed already reached with the system runtime.

**A native clipboard addon.** `@mariozechner/clipboard` was rejected when the paste landed, for the same reasons recorded there: it does not remove the per-platform readers.

## Consequences

A macOS Ctrl+V now spends about 40 ms in the child process — about 50 ms end to end through the reader — instead of 270–460 ms, so the marker lands within one render interval of the key press for a clipboard screenshot. The surface keeps one fewer script language, since the AppleScript quoting helper and script are deleted. The Windows and WSL readers are unchanged and still take most of a second on a cold PowerShell; the footer wait is what keeps those visible. The parity limits of the old reader carry over unchanged: only a pasteboard that offers `public.png` yields an image, and one that offers only TIFF or JPEG reports an empty clipboard. The paste remains invisible to the session log and the model until submission.

## Testing

`tests/clipboard.spec.ts` asserts the darwin reader's command, its `-l JavaScript` arguments, the `dataForType('public.png')` request, and the JSON-quoted staging path in `writeToFileAtomically`, and it covers `ok`, `empty`, `failed`, an absent reader, and a reader that reports success but writes nothing. `tests/transcript.spec.ts` pins the footer text with `pasting` true, false, and absent. `tests/tui-app.spec.ts` holds a clipboard read open with a deferred promise, asserts `pasting image…` in the composited alternate-screen frame, then resolves it and asserts the marker arrives and the wait text is gone. A pseudo-terminal run of `dsh --profile tui` with a 5.76 MB PNG on the real pasteboard shows the same sequence: a frame with `pasting image…` beside `○ idle`, then `[Image #1]` in the composer and an idle footer.

The measurement above is manual and macOS-only: the reader shells out to a system program that needs a real pasteboard, so no CI timing budget can assert it. Three runs of the shipped `readClipboardImage()` with the 5.76 MB PNG on the pasteboard returned all 5 763 018 bytes in 47.0, 47.7, and 49.7 ms; the negative control, the AppleScript coercion run on the same host and payload in the same session, took 0.50–0.51 s. A real read on Windows, WSL, and Linux remains the manual check the [paste note](../feature/2026-09-11-tui-clipboard-image-paste.md) already names.
