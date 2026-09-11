---
description: "Interactive terminal UI for dsh: one Agent, one session, driven in-process from a full-screen terminal surface, for users working over SSH or preferring a terminal to the browser."
kind: "package-bundle"
---

# @deepseek-ai/dsh-tui-app

English | [中文](README.zh.md)

## Summary

`dsh-tui-app` is the interactive terminal surface for dsh. Run `dsh` and one Agent starts in the current directory with the same model, tools, sandbox, and approval defaults as every other surface — but rendered as a full-screen terminal application: a scrolling transcript, a pinned status bar, and a composer that stays at the bottom. It opens no port and starts no server, because the Agent runs in the same process. The main boundary: one session per invocation, with no browser, image attachment, or file sidebar.

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

Type a prompt and press Enter. While the Agent works, the composer switches to steering: an Enter submits text the running turn consumes at its next step, and Ctrl+C cancels the turn. PageUp/PageDown, the mouse wheel, and terminal search scroll the transcript without leaving the app; the status bar reports when the view has scrolled away from the newest row.

| Key | Action |
|---|---|
| `Enter` | Submit the prompt, or steer the running turn |
| `Ctrl+C` | Cancel the running turn; with nothing running, exit |
| `Ctrl+D` | Exit |
| `PageUp` / `PageDown` | Scroll the transcript |
| `Ctrl+L` | Repaint from scratch |

### Commands

A line beginning with `/` runs a command instead of reaching the model. The app owns the session commands below; every other registered command — `/compact`, `/goal`, `/plan`, and deployment-provided commands — is discovered from the command registry and dispatched against the live Agent.

| Command | Effect |
|---|---|
| `/help` | List the app's commands and every registered command |
| `/new` | Flush and close the session, then start a fresh one |
| `/sessions` | List stored sessions, newest first |
| `/resume [id]` | Resume a stored session by id, or choose one from a picker |
| `/model [provider/model]` | Choose a model from the live catalog, or switch directly |
| `/quit` | Exit |

### Settings

The app's only deployment setting selects where it draws:

| Field | Default | Meaning |
|---|---|---|
| `screen` | `'alternate'` | `'alternate'` draws the transcript in the alternate screen with the app's own scroll window; `'inline'` draws into the normal screen and leaves history to the terminal's scrollback. |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tui-app) is the exhaustive source for every accepted field and its JSDoc. `DSH_TUI_SCREEN` in the bundle patch supplies the default value.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The app owns one `TuiSession` and one terminal UI. It waits for the complete composition (`ctx.get('loader')?.await()`) so the Agent's scoped tools and adapters are mounted, creates or resumes the Agent through the core registry, and then subscribes to the durable `session/event` log, the live `agent/assistant-stream` feed, and `agent/status`.

### Rendering

[`src/transcript.ts`](src/transcript.ts) folds those events into ordered rows — prompts, assistant messages, live reasoning, Tool calls with their settled outcome, and app notices — and invalidates its rendered lines through a revision counter. [`src/views.ts`](src/views.ts) turns rows into terminal lines with [`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui) components, truncating every line to the viewport width because the renderer treats an over-wide line as a component defect. The alternate-screen renderer owns scrolling: the transcript is its primary scroll view, so PageUp/PageDown and the wheel move the transcript while the status bar and composer stay pinned.

### Interaction seams

The app answers the two seams the Agent pauses on. `ctx.on('approval/request', …)` offers Allow once / Reject for this app's own Agent and delegates every other Agent's request, so a composition that also mounts subagents keeps its own answerers authoritative; a dismissed prompt resolves `cancelled`, which the approval service already treats as fail-closed. `ctx.on('user-questions/request', …)` renders the question's options as a picker, or a free-text input when the question declares none, and fails the asking Tool with `ASK_ABORTED` when the user dismisses it. One prompt owns the keyboard at a time.

### Patch surface over base

The patch rides over `dsh-base` and adds no host, HTTP, or browser row. It restates the coding persona the other surfaces set, inserts the startup provider and the app, and leaves the base's model-facing rows in the host plane: this surface is single-session, so its Agent composes them process-wide instead of per session. The startup provider ([`src/startup.ts`](src/startup.ts)) injects `ctx.cmdlineArgs` ([`dsh-cmdline`](../../boot/cmdline/README.md)), parses `--resume`, `--provider`, and `--model`, and provides `tuiStartup`; the app row injects that service, so `--help` and a rejected invocation mount no terminal UI at all.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `tui-app` plugin: launcher facts, boot, and failure exit |
| [`src/startup.ts`](src/startup.ts) | The `tui-startup` provider: flag family and `--help` |
| [`src/app.ts`](src/app.ts) | Surface construction, event wiring, input routing, teardown |
| [`src/session.ts`](src/session.ts) | Agent create/resume, prompt submission, route switching |
| [`src/transcript.ts`](src/transcript.ts) | The event fold into renderable rows |
| [`src/views.ts`](src/views.ts) | Transcript, status bar, and modal panel components |
| [`src/commands.ts`](src/commands.ts) | Slash-command catalog, dispatch, and model catalog |
| [`src/interactions.ts`](src/interactions.ts) | Approval and user-question answerers |
| [`src/ansi.ts`](src/ansi.ts) | Semantic styles and the component themes |
| [`cordis.patch.yml`](cordis.patch.yml) | The terminal patch over `dsh-base` |
| — | No runtime invariant companion is published; the app registers no registry and holds no intra-tree relation to audit, because its observable contract is the terminal surface itself. |
| [`tests/tui-app.spec.ts`](tests/tui-app.spec.ts) | Composer routing, rendering, modal answers, and exit |
| [`tests/transcript.spec.ts`](tests/transcript.spec.ts) | The event fold and line-width bounds |
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

The app submits the typed prompt as an ordinary user message and renders the model's own output back; `/help`, `/quit`, `/new`, `/sessions`, `/resume`, and `/model` never reach the model. A model switch appends the shared model-selection notice, exactly as it does on the other surfaces.

#### Token effect

Prompts and responses carry their ordinary token cost. Nothing the terminal renders — the status bar, the Tool row folding, or the scroll window — adds a request or a token.

#### KV Cache effect

The app adds nothing to the request prefix; it only routes the typed prompt through the composed tree.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the terminal surface does not do. They are current constraints of this bundle, not a backlog of the browser surface.

- **One Agent per invocation** — the app owns a single session; switching to another Agent means `/new` or `/resume`, which closes the current one first.
- **Multi-select questions degrade** — a `multiSelect` question is presented one choice per prompt, so a multiple-choice answer needs several rounds.
- **No attachments or images** — the composer sends text only; image and file blocks are not composed or rendered.
- **Tool output is folded** — a Tool result shows its first lines plus a count of the remainder; the complete output stays in the session log, not on screen.
- **Launcher-owned exit** — like every surface, the app starts only through the `dsh` profile, because only the launcher provides the bounded exit request.
- **No recorded-session snapshot** — the keyless snapshot harness drives shipped profiles over stdio, while this surface owns a terminal; its acceptance is the package tests plus a pseudo-terminal run rather than a snapshot fixture, so a regression in terminal layout needs the surface tests to be extended rather than a re-recorded snapshot.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
