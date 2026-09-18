---
description: "Interactive terminal UI for dsh: one Agent, one session, driven in-process from a full-screen terminal surface, for users working over SSH or preferring a terminal to the browser."
kind: "package-bundle"
---

# @deepseek-ai/dsh-tui-app

English | [中文](README.zh.md)

## Summary

`dsh-tui-app` is the interactive terminal surface for dsh. Run `dsh` and one Agent starts in the current directory with the same model, tools, sandbox, and approval defaults as every other surface — but rendered as a full-screen terminal application: a scrolling transcript, a composer that stays above a pinned footer, and status lines that report the workspace, context occupancy, routed model, token throughput, total tokens, and cache-hit rate. It opens no port and starts no server, because the Agent runs in the same process. The main boundary: one session per invocation, with no browser or file sidebar.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Open the terminal UI from the directory that should be the workspace:

```sh
dsh
```

`dsh` with no profile boots this bundle; `dsh --profile tui` names it explicitly and takes the same flags. `DSH_DEFAULT_PROFILE` selects a different default for a bare invocation (`DSH_DEFAULT_PROFILE=web dsh`), and an empty value restores the upstream requirement that every launch name its profile. The app refuses to start without an interactive terminal, so a piped or redirected invocation fails loudly instead of waiting for keys it cannot read.

### Composing, prompting, and interrupting

Type a prompt and press Enter. While the Agent works, the composer switches to steering: an Enter submits text the running turn consumes at its next step, and Esc interrupts the turn. PageUp/PageDown, the mouse wheel, and terminal search scroll the transcript without leaving the app; the status bar reports when the view has scrolled away from the newest row.

Press Ctrl+V to attach the image on the system clipboard to the draft. The composer shows every held image as an `[Image #1]` marker, which behaves like typed text: moving or deleting a marker moves or drops its image. The paste reads the clipboard directly, so the terminal's own text paste keeps its usual key. While that read is in flight the footer reports `pasting image…`, so a slow platform reader never looks frozen.

Press Shift+Tab to toggle plan mode for the session's Agent. While plan mode is on, the footer marks it with `plan` beside the lifecycle state and the empty composer lists the key. A toggle made while a turn is running applies from the next step, exactly as `/plan` does; a deployment that mounts no plan mode reports it instead of changing the session. When the agent finishes planning it presents the plan through `exit_plan_mode`, and the review shows that plan as markdown above the Approve / Keep planning choice, taking the rows above the pinned composer and footer so a long plan reads on any terminal size, scrollable with the arrows, PageUp/PageDown, and the wheel, because the plan-mode policy routes the plan through the tool rather than a plain reply. Choosing Keep planning leaves plan mode active and hands the turn back, so the agent waits for your next message instead of revising the plan immediately.

| Key | Action |
|---|---|
| `Enter` | Submit the prompt, or steer the running turn |
| `Esc` | Interrupt the running turn |
| `Shift+Tab` | Toggle plan mode |
| `Ctrl+V` | Attach the image on the system clipboard to the draft (`Alt+V` on Windows and WSL, where the terminal owns Ctrl+V) |
| `Ctrl+C` | Cancel the running turn; with nothing running, exit |
| `Ctrl+D` | Exit |
| `PageUp` / `PageDown` | Scroll the transcript, or a question's overflowing detail |
| `Up` / `Down` | Scroll a question's overflowing detail; otherwise move its picker |
| `Left` / `Right` | Move a picker's selection while a question's detail owns the arrows |
| `Ctrl+L` | Repaint from scratch |

Exiting — Ctrl+C with nothing running, Ctrl+D, or `/quit` — restores the terminal and prints the session id as a `dsh --resume <session-id>` command, so a later invocation continues the same conversation. The hint is printed only where the deployment mounts a session-persistence backend; without one there is nothing for `--resume` to open.

### Commands

A line beginning with a known `/command` runs that command instead of reaching the model. Other slash text reaches the Agent unchanged: `/ponytail full` invokes an installed user-invocable skill through the shared skill loader, while unknown skill names remain ordinary text. App commands and registered commands take precedence over skills with the same name. The app owns the session commands below; every other registered command — `/compact`, `/goal`, `/plan`, and deployment-provided commands — is discovered from the command registry and dispatched against the live Agent.

| Command | Effect |
|---|---|
| `/help` | List the app's commands and every registered command |
| `/new` | Flush and close the session, then start a fresh one |
| `/sessions` | List stored sessions, newest first |
| `/resume [id]` | Resume a stored session by id, or choose one from a picker |
| `/model [provider/model]` | Choose a model from the live catalog, or switch directly |
| `/effort [id]` | Choose the routed model's declared reasoning effort, or switch directly |
| `/quit` | Exit |

### Settings

The app's only deployment settings select where it draws and which palette it uses:

| Field | Default | Meaning |
|---|---|---|
| `screen` | `'alternate'` | `'alternate'` draws the transcript in the alternate screen with the app's own scroll window; `'inline'` draws into the normal screen and leaves history to the terminal's scrollback. |
| `colorScheme` | `'auto'` | Palette selection. `'auto'` reads the terminal's exported background signal and otherwise stays dark; `'dark'` and `'light'` pin the palette. |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tui-app) is the exhaustive source for every accepted field and its JSDoc. `DSH_TUI_SCREEN` and `DSH_TUI_COLOR_SCHEME` in the bundle patch supply the defaults.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The app owns one `TuiSession` and one terminal UI. It waits for the complete composition (`ctx.get('loader')?.await()`) so the Agent's scoped tools and adapters are mounted, creates or resumes the Agent through the core registry, and then subscribes to the durable `session/event` log, the live `agent/assistant-stream` feed, and `agent/status`.

### Rendering

[`src/transcript.ts`](src/transcript.ts) folds those events into ordered rows — prompts, assistant messages, live reasoning, Tool calls with their settled outcome, and app notices — and invalidates its rendered lines through a revision counter. A prompt renders its image markers before its text, one marker per attached image in content order, because the terminal has no thumbnail and the durable content blocks are the record of what was attached. Injected context is model input rather than conversation, so it produces a row only when its producer declared a one-line `notice` form: a workspace-instruction, skill-catalog, or runtime-context message stays in the session log, while a model switch, a plan-mode change, or a goal appears as an app notice. The footer sits under the composer in both screen strategies and occupies two lines: the workspace and Agent state right-aligned against the routed model and its reasoning effort, then the token accounting and the occupancy of the next request against the routed model's capacity, with the whole log's token figures at the bottom-right edge. Those figures are the decode throughput in tokens per second, the billed prompt-plus-output total, and the cache-read share of billed prompt tokens; each is omitted until it has data, the rate is the whole-log average the Web stats strip reports rather than a live instantaneous one, and the group yields before the accounting when the terminal is too narrow for both. Plan mode adds a `plan` marker beside the Agent state, toggled by `Shift+Tab` through `ctx.planMode`. The key hints are the placeholder of the empty composer rather than a footer line: the composer is wrapped so its content line shows them until the first typed character, because the editor component renders no placeholder of its own. Occupancy and capacity come from the `contextPressure` projection of the mounted `ctx.tokenMeter`, the totals from its `tokenUsage` projection, and the throughput from the `sessionStats` projection this bundle inserts; the `(auto)` marker comes from `ctx.compaction.autoCompactionEnabled`; the model's provider qualifies the label only when the deployment registers several. [`src/views.ts`](src/views.ts) turns rows into terminal lines with [`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui) components, truncating every line to the viewport width because the renderer treats an over-wide line as a component defect, and flattening a Tool heading to one line because one row owns exactly one terminal row: a multi-line argument would otherwise print its own line breaks and spill the row into the pinned footer. A picker or prompt renders as ordinary output rather than a dialog — a plain title, a blank row, and the body — anchored directly above the composer in the alternate-screen layout, with every row padded to the viewport width so the transcript cannot show through beside it. The alternate-screen renderer owns scrolling: the transcript is its primary scroll view, so PageUp/PageDown and the wheel move the transcript while the status bar and composer stay pinned; stopping the renderer writes the whole transcript back to the normal screen, so the output stays selectable after exit. `stop()` then flushes the session and writes the resume command to stderr, after the restore because the surface no longer owns the screen, and only where a persistence backend is mounted. A Tool that declares a Host diff presentation — `edit`, `write`, and any Tool returning a `card: 'diff'` view — renders as a unified diff card instead of its model-facing result sentence: the Tool's own heading, a `+added -removed` count, and context/added/removed rows, folded after a bounded number of lines. The surface resolves that view through `ctx.tools` while folding the event, and falls back to the ordinary name-and-summary row for every other card and for a failed mutation. A Tool row's ordinary result body renders in the palette's tool-result grey rather than the assistant body's terminal foreground. The palette follows the terminal background: `colorScheme` pins dark or light, and `auto` reads the terminal's `COLORFGBG` background signal, defaulting to dark.

### Interaction seams

The app answers the two seams the Agent pauses on. `ctx.on('approval/request', …)` offers Allow once / Reject for this app's own Agent and delegates every other Agent's request, so a composition that also mounts subagents keeps its own answerers authoritative; a dismissed prompt resolves `cancelled`, which the approval service already treats as fail-closed. `ctx.on('user-questions/request', …)` renders the question's options as a picker, or a free-text input when the question declares none, and fails the asking Tool with `ASK_ABORTED` when the user dismisses it, or with `ASK_CANCELLED` when a plan review chooses Keep planning, which plan mode reads as the user taking the turn back. A question's `detail` renders as markdown above that control, in a viewport sized to the rows the control leaves; a prompt whose question carries a detail takes every row above the pinned composer and footer, while one without a detail keeps the picker's own height cap so a short list never fills a tall terminal. While the detail overflows, Up/Down, PageUp/PageDown, and the wheel scroll it and Left/Right move the picker, so a plan review shows the plan the model submitted rather than only its approval options. One prompt owns the keyboard at a time.

### Clipboard images

Ctrl+V reads the system clipboard through the platform's own reader ([`src/clipboard.ts`](src/clipboard.ts)): `osascript`'s JavaScript automation runtime reading `NSPasteboard` directly on macOS, PowerShell on Windows and WSL, `wl-paste` on Wayland, and `xclip` on X11. A reader stages bytes in a temporary file that the read deletes, and its declared media type is only a claim — the attachment service verifies it against the decoded bytes. The footer reports `pasting image…` from the key press until the bytes arrive, because a platform reader runs as a child process and a large clipboard image can take most of a second to stage. The bytes stay in memory under the marker the composer shows. A submission citing a marker resolves the exact routed model's declared input modalities, admits the batch through `ctx.attachments.admitPromptContent(…)`, and hands the Agent one user message carrying the prompt text followed by the admitted image blocks. A refusal — no attachment store, a model that excludes image input, or a failed admission — restores the draft rather than sending a partial prompt.

### Patch surface over base

The patch rides over `dsh-base` and adds no host, HTTP, or browser row. It restates the coding persona the other surfaces set, inserts the startup provider and the app, and leaves the base's model-facing rows in the host plane: this surface is single-session, so its Agent composes them process-wide instead of per session. The startup provider ([`src/startup.ts`](src/startup.ts)) injects `ctx.cmdlineArgs` ([`dsh-cmdline`](../../boot/cmdline/README.md)), parses `--resume`, `--provider`, and `--model`, and provides `tuiStartup`; the app row injects that service, so `--help` and a rejected invocation mount no terminal UI at all. The patch also sets `session-log-deepseek` to `enabled: false`, so this fork keeps Session logs on the machine instead of contributing the upstream `dsh_session_log` suffix to official DeepSeek requests; a deployment that wants that suffix re-enables the row through a `--patch` overlay or the profile's own `cordis.patch.yml`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `tui-app` plugin: launcher facts, boot, and failure exit |
| [`src/startup.ts`](src/startup.ts) | The `tui-startup` provider: flag family and `--help` |
| [`src/app.ts`](src/app.ts) | Surface construction, event wiring, input routing, teardown |
| [`src/session.ts`](src/session.ts) | Agent create/resume, prompt submission, route switching |
| [`src/transcript.ts`](src/transcript.ts) | The event fold into renderable rows |
| [`src/diff.ts`](src/diff.ts) | The pure file-diff row model |
| [`src/tool-view.ts`](src/tool-view.ts) | The Host tool-presentation bridge |
| [`src/images.ts`](src/images.ts) | Composer image markers and the submission fold |
| [`src/clipboard.ts`](src/clipboard.ts) | Platform clipboard image readers and their staging files |
| [`src/views.ts`](src/views.ts) | Transcript, status bar, and modal panel components |
| [`src/commands.ts`](src/commands.ts) | Slash-command catalog, dispatch, and model catalog |
| [`src/interactions.ts`](src/interactions.ts) | Approval and user-question answerers |
| [`src/ansi.ts`](src/ansi.ts) | Semantic styles and the component themes |
| [`cordis.patch.yml`](cordis.patch.yml) | The terminal patch over `dsh-base` |
| — | No runtime invariant companion is published; the app registers no registry and holds no intra-tree relation to audit, because its observable contract is the terminal surface itself. |
| [`tests/tui-app.spec.ts`](tests/tui-app.spec.ts) | Composer routing, clipboard paste, rendering, modal answers, and exit |
| [`tests/transcript.spec.ts`](tests/transcript.spec.ts) | The event fold, the footer, the placeholder composer, and line-width bounds |
| [`tests/clipboard.spec.ts`](tests/clipboard.spec.ts) | Every platform reader path and the staging-file adapters |
| [`tests/images.spec.ts`](tests/images.spec.ts) | Composer marker parsing |
| [`tests/startup.spec.ts`](tests/startup.spec.ts) | Command-line parsing over a real Loader tree |

### Invariant ownership

No invariant companion is published: the app contributes no registry and holds no mutable relation inside the tree, and its observable contract is the terminal surface, which the surface tests drive through a substituted Terminal.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages to go deeper into the shared core, the sibling surfaces, or the terminal library.

- [Bundle package map](../README.md) — the surfaces built on the same core.
- [dsh-base](../base/README.md) — the shared core this surface runs on.
- [dsh-headless](../headless/README.md) — the one-shot sibling for scripts and CI.
- [dsh-web-app](../web-app/README.md) — the browser sibling for multi-turn work.
- [dsh-cmdline](../../boot/cmdline/README.md) — how the launcher hands the command line to the app.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tui-app) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Interactive coding session

#### What the model sees

The app submits the typed prompt as an ordinary user message and renders the model's own output back; `/help`, `/quit`, `/new`, `/sessions`, `/resume`, and `/model` never reach the model. A model switch appends the shared model-selection notice, exactly as it does on the other surfaces. Shift+Tab enters or leaves plan mode through the same service `/plan` drives, so the model sees the plan-policy section and the user-switch notice a typed command produces. A clipboard paste adds the admitted image to that same message as a durable image reference, exactly as an upload from another surface does; the composer's `[Image N]` markers are composer text and never reach the model.

#### Token effect

Prompts and responses carry their ordinary token cost. Nothing the terminal renders — the footer, the Tool row folding, or the scroll window — adds a request or a token; the occupancy, throughput, and token-total figures are read from local measurement projections, not from an extra provider call. Toggling plan mode adds no request of its own and changes only the next request's plan-policy section. An attached image is counted at the routed model's declared image pricing when it declares one, so the footer reflects the request the model will actually receive.

#### KV Cache effect

The app adds nothing to the request prefix; it only routes the typed prompt through the composed tree.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the terminal surface does not do. They are current constraints of this bundle, not a backlog of the browser surface.

- **One Agent per invocation** — the app owns a single session; switching to another Agent means `/new` or `/resume`, which closes the current one first.
- **Multi-select questions degrade** — a `multiSelect` question is presented one choice per prompt, so a multiple-choice answer needs several rounds.
- **Keep planning waits for a message** — the terminal review has no free-text feedback field, so choosing Keep planning closes the review and hands the turn back, keeping plan mode active; the adjustment is the user's next prompt rather than an answer carried on the review.
- **A prompt's height is fixed when it opens** — the panel sizes itself from the terminal once, so resizing the terminal during a review does not resize it; close and reopen the prompt to pick up the new height.
- **Images come only from the clipboard** — the composer attaches PNG, JPEG, WebP, and GIF bytes read from the system clipboard, through `osascript` reading `NSPasteboard` on macOS, PowerShell on Windows and WSL, `wl-paste` on Wayland, or `xclip` on X11. A host with none of those readers reports the paste as an empty clipboard, and no file picker, drag-and-drop, or non-image attachment exists.
- **Tool output is folded** — a Tool result shows its first lines plus a count of the remainder; the complete output stays in the session log, not on screen.
- **Diff cards cover file mutations only** — the Host `presentCall`/`presentResult` vocabulary also declares read, search, terminal, and web cards; this surface adopts only `card: 'diff'` and renders every other card as its ordinary raw row, so a future card needs a renderer here.
- **Occupancy is an estimate** — the footer's percentage anchors on the last provider-reported prompt size and heuristically reprices what the surface gained or lost since; it is a reference for the user, not a billing or admission input.
- **Launcher-owned exit** — like every surface, the app starts only through the `dsh` profile, because only the launcher provides the bounded exit request.
- **No recorded-session snapshot** — the keyless snapshot harness drives shipped profiles over stdio, while this surface owns a terminal; its acceptance is the package tests plus a pseudo-terminal run rather than a snapshot fixture, so a regression in terminal layout needs the surface tests to be extended rather than a re-recorded snapshot.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
