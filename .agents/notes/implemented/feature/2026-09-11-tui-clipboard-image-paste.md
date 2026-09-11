# Agent Note: TUI clipboard image paste

Status: implemented

English | [中文](2026-09-11-tui-clipboard-image-paste.zh.md)

## Problem

The [fork terminal surface](../architecture/2026-09-11-fork-terminal-surface.md) composed text only: a prompt could not carry an image, and the transcript had no way to show one. Every other surface already accepts images — the browser composer pastes and drops them, ACP and MCP project them to durable blocks — so the terminal user could attach an image only by starting the session somewhere else. Images are also the one rich input a terminal cannot deliver by itself: bracketed paste carries text, and no terminal escape sequence hands image bytes to a full-screen application.

## Decision

**Ctrl+V attaches the image on the system clipboard to the draft.** The app asks the platform's own clipboard reader (`src/clipboard.ts`): `osascript` on macOS, `System.Windows.Forms.Clipboard` through PowerShell on Windows and WSL, `wl-paste` on Wayland, and `xclip` on X11. A reader stages bytes in one temporary file under the system temporary directory, and the read deletes it whether or not it held an image. Windows terminals and WSL distribute Ctrl+V to their own paste, so the surface binds the same action to Alt+V there — the reference agent's `app.clipboard.pasteImage` default. The reader's declared media type is a claim, not authority: admission verifies it against the decoded bytes, so a reader that mislabels its payload fails as an invalid image instead of persisting it.

**The composer cites each held image with a text marker.** Ctrl+V inserts `[Image #1]` at the cursor through the editor's `insertTextAtCursor`, the API pi-tui documents for clipboard image markers. The marker is ordinary editable text, so moving or deleting it moves or drops the image, and a draft that never submits holds its bytes only in memory. Submission removes the markers of images the draft still holds and leaves a marker literal when the draft holds no such image; the composer's markers never reach the model as prompt text.

**Submission admits the whole batch before any message exists.** The app resolves the exact routed model's declared input modalities (a missing declaration is unknown capability and proceeds), admits the batch through `ctx.attachments.admitPromptContent(…)`, then hands the Agent one user message whose content is the prompt text followed by the admitted image blocks in content order. This is the host prompt path every other surface uses: images are durably committed before the owning event is appended, so a replay reconstructs exactly what the model saw. A refusal — no attachment store, a model that excludes image input, or a failed admission — restores the draft rather than sending a partial prompt.

**The transcript renders markers derived from durable content.** A user row shows one marker per image block, in content order, before its text. Numbering is per message rather than per composer draft, so a resumed session renders the same row without any composer state.

## Alternatives considered

**A native clipboard addon, as the reference agent ships.** `@mariozechner/clipboard` provides `hasImage()` and `getImageBinary()` with prebuilt binaries for every platform. It lost because it does not delete the platform code: the reference agent still ships `wl-paste`, `xclip`, and WSL PowerShell fallbacks beside it, because the addon is X11-only on Linux and cannot see the Windows clipboard from WSL. Adding a native dependency, its platform packages, their release-age exemptions, and their third-party notices would buy the same behavior this surface already reaches with programs macOS, Windows, and every Linux desktop ship.

**Asking the terminal for the clipboard through an escape protocol.** Kitty's `OSC 5522` read and its equivalents can return clipboard data to an application. It lost on coverage and on plumbing: only a few terminals implement the read direction, none of them iTerm2, Terminal.app, or Windows Terminal, and pi-tui exposes no OSC response channel to application code, so the surface would own a parser for a path most users cannot use.

**An attachment rail above the composer, as the Web surface renders.** Thumbnails over the textarea are the right presentation where a thumbnail is possible. It lost in a terminal because a rail cannot be edited: the composer is one text buffer, and a separate rail would need its own removal key and its own ordering rules beside the text that references it, while a marker is deleted with Backspace like any other character.

**Inserting the platform's staged file path, as the reference agent does.** The reference agent writes the clipboard image to a temporary file and inserts its path, relying on its own path-to-attachment intake. It lost because this harness has no such intake for a user prompt: the path would reach the model as a string, so the image would never be a durable content block, and reading it would remain a separate tool call.

**Falling back to clipboard text when the clipboard holds no image.** The reference agent binds one key to paste image or text. It lost because a terminal already delivers text paste: the fallback needs a second platform reader on every host, and on macOS it teaches Ctrl+V as a second text-paste key beside Cmd+V.

## Consequences

A terminal user can now paste a screenshot into a prompt and see in the transcript which images a prompt carried, and the images live in the same durable attachment store the other surfaces use, so a resumed session keeps them. The costs are a platform-specific reader per host, a paste that needs the platform tool to exist (a host with none reports an empty clipboard), and one more runtime dependency edge: `dsh-tui-app` now declares `@deepseek-ai/dsh-attachment` to read the store it admits into.

## Testing

`tests/clipboard.spec.ts` drives every reader path through an injected command runner — preference order among offered media types, absent and non-zero-exit readers, empty payloads, path quoting for both script languages, and the WSL path translation — and exercises the real staging-file adapters against the filesystem. `tests/images.spec.ts` pins the marker fold. `tests/tui-app.spec.ts` mounts the real `dsh-attachment-local` store and proves that a Ctrl+V paste reaches the Agent as text plus a durable image block, that an image-only prompt submits without text, that a clipboard without an image, a text-only route, and a missing attachment store each report and restore the draft, that Alt+V governs where Ctrl+V is reserved, and that one kitty-protocol press and release pair pastes once. `tests/transcript.spec.ts` pins the row a durable image prompt renders, including a resumed image-only prompt. A pseudo-terminal run of the shipped profile confirms the composer hint, the real clipboard read, and the marker the composer then shows.

The named coverage gap is unchanged: the package owns a terminal, so the keyless snapshot harness cannot record this surface. `tests/clipboard.spec.ts` substitutes the command runner and asserts the arguments each reader passes, so only the macOS reader is verified end to end against a real clipboard (a real PNG that the local store then admitted); a real read on another platform remains a manual check.
