# DeepSeek Harness TUI

English | [中文](README.zh.md)

This repository is the terminal-UI fork of DeepSeek Harness, the open-source agent harness developed by [DeepSeek AI](https://deepseek.com) and built on an **everything-is-a-plugin** architecture powered by [Cordis](https://github.com/cordiverse/cordis). The upstream project README — plugin architecture, Web UI, Desktop, and the full harness — lives in [README.upstream.md](README.upstream.md).

Run `dsh` in the directory that should be the workspace and one Agent starts there: one session, one process, no server and no port. The Agent uses the same model, tools, sandbox, and approval defaults as every other surface, but renders into the terminal as a full-screen application with a scrolling transcript, a composer above a pinned footer, and status lines for the workspace, context occupancy, routed model, token throughput, total tokens, and cache-hit rate.

A bare `dsh` defaults to the terminal profile. Set `DSH_DEFAULT_PROFILE=web` to make the browser the default again, or pass `--profile web` explicitly.

## Developer preview

DeepSeek Harness is in _developer preview_ and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

Review the [safety notice](SAFETY.md) before running the project.

<a id="run"></a>

## Install and run

The terminal surface is not published to the registry, so install from a checkout. On a fresh clone, one command installs the dependencies, runs the complete build, and links `dsh` into a directory on `PATH`:

```sh
git clone https://github.com/FishwithCat/deepseek-harness-tui.git
cd deepseek-harness-tui
pnpm run setup:dsh
```

The complete build matters: `pnpm run build` also builds the native system addon and both compiler faces, and a checkout built without them starts the terminal UI but hangs when the session flushes on exit. The installer links `apps/cli/lib/bin.js` into `$HOME/.local/bin` (`%APPDATA%\npm` on Windows), so `dsh` runs from any directory. It is idempotent: re-run `pnpm run link:dsh` after a rebuild, or to repair a link left dangling by a moved or cleaned checkout. `pnpm run link:dsh -- --dir <path>` installs elsewhere, `DSH_LINK_BIN_DIR` sets the target, and `pnpm run unlink:dsh` removes a link this checkout installed. An entry owned by another program is refused rather than overwritten.

A registry install (`npx @deepseek-ai/dsh` or `npm install -g`) cannot carry this fork's terminal surface, because `@deepseek-ai/dsh-tui-app` is not published and the launcher's other dependencies would resolve to the upstream packages.

### Run from source

```sh
pnpm install
pnpm run build
pnpm dsh
```

`pnpm run build` prepares the repository artifacts, and `pnpm dsh` uses them without rebuilding. `pnpm run build:tui` builds only the native system addon and the host compiler face the terminal UI needs.

### Flags

`dsh` opens the terminal UI; `dsh --profile tui` names the profile explicitly. `--resume <session-id>` resumes a stored session, and `--provider` / `--model` select the routed model for a new session. The app refuses to start without an interactive terminal, so a piped or redirected invocation fails loudly instead of waiting for keys it cannot read.

## What the terminal UI offers

- **One Agent, one session.** The Agent runs in-process; every invocation draws its own transcript and holds a single session.
- **Steering and interruption.** While a turn runs, Enter submits text the running turn consumes at its next step, and Esc interrupts the turn together with every live subagent descendant.
- **Full-screen transcript.** PageUp/PageDown, the mouse wheel, and terminal search scroll the transcript without leaving the app; the status bar reports when the view has scrolled away from the newest row.
- **Plan mode.** Shift+Tab toggles plan mode for the session's Agent. When the agent finishes planning it presents the plan as markdown above the Approve / Keep planning choice.
- **Clipboard images.** Ctrl+V (Alt+V on Windows and WSL) attaches the image on the system clipboard to the draft, and the composer shows every held image as an `[Image #1]` marker.
- **Approvals and questions.** Approval prompts offer Allow once / Reject, and `ask_user_question` renders as a picker — checkable when the question sets `multiSelect` — or a free-text input.
- **Sessions.** Exit prints a `dsh --resume <session-id>` command, and `/sessions` and `/resume` browse and restore stored conversations.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Enter` | Submit the prompt, or steer the running turn |
| `Esc` | Interrupt the running turn and the session's live subagents |
| `Shift+Tab` | Toggle plan mode |
| `Ctrl+V` | Attach the image on the system clipboard to the draft (`Alt+V` on Windows and WSL) |
| `Ctrl+C` | Cancel the running turn and live subagents; with neither working, exit |
| `Ctrl+D` | Exit |
| `PageUp` / `PageDown` | Scroll the transcript, or a question's overflowing detail |
| `Up` / `Down` | Scroll a question's overflowing detail; otherwise move its picker |
| `Left` / `Right` | Move a picker's selection while a question's detail owns the arrows |
| `Space` | Check or uncheck an option in a multi-select question |
| `Ctrl+L` | Repaint from scratch |

## Commands

A line beginning with a known `/command` runs that command instead of reaching the model; other slash text reaches the Agent unchanged.

| Command | Effect |
|---|---|
| `/help` | List the app's commands and every registered command |
| `/new` | Flush and close the session, then start a fresh one |
| `/sessions` | List stored sessions, newest first |
| `/resume [id]` | Resume a stored session by id, or choose one from a picker |
| `/model [provider/model]` | Choose a model from the live catalog, or switch directly |
| `/effort [id]` | Choose the routed model's declared reasoning effort, or switch directly |
| `/questions` | Answer a question whose foreground window closed |
| `/quit` | Exit |

## Settings

| Field | Default | Meaning |
|---|---|---|
| `screen` | `'alternate'` | `'alternate'` draws in the alternate screen with the app's own scroll window; `'inline'` draws into the normal screen and leaves history to the terminal scrollback. |
| `colorScheme` | `'auto'` | `'auto'` follows the terminal's exported background signal and otherwise stays dark; `'dark'` and `'light'` pin the palette. |

## Development

The terminal surface lives in [`packages/bundle/tui-app`](packages/bundle/tui-app/README.md). Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md); agents follow [AGENTS.md](AGENTS.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
