# DeepSeek Harness TUI

English | [中文](README.zh.md)

This repository is the terminal-UI fork of DeepSeek Harness, the open-source agent harness from [DeepSeek AI](https://deepseek.com). A bare `dsh` starts one Agent in the current directory: one session, one process, no browser server and no fixed port. The Agent uses the same model, tools, sandbox, and approval defaults as every other surface, but renders into the terminal as a full-screen application with a scrolling transcript, a composer above a pinned footer, and status lines for the workspace, context occupancy, routed model, token throughput, total tokens, cache-hit rate, and delegated subagents.

Review the [safety notice](SAFETY.md) before running the project.

<a id="quick-start"></a>

## Quick start

You need Node.js 22.19+ or 24+, pnpm installed through Corepack, Git, an interactive terminal, and a DeepSeek API key. On a fresh clone, one command installs the dependencies, runs the complete build, and links `dsh` onto `PATH`:

```sh
git clone https://github.com/FishwithCat/deepseek-harness-tui.git
cd deepseek-harness-tui
pnpm run setup:dsh
```

Set the API key in the launch environment — `$env:DEEPSEEK_API_KEY = "sk-..."` in PowerShell — and start the terminal UI from the directory that should be the workspace:

```sh
export DEEPSEEK_API_KEY=sk-...
dsh
```

A key already stored in `$DSH_HOME/.credentials.yaml` also works. Type a prompt and press Enter; `/help` lists the commands, `/model` switches the routed model, and `Ctrl+D` exits. Exiting prints a `dsh --resume <session-id>` command that continues the conversation later. See [Install and run](#run) for the installer's link options and the build's requirements.

<a id="run"></a>

## Install and run

The quick start's `pnpm run setup:dsh` is the complete path: it builds the native system addon and both compiler faces, then links `apps/cli/lib/bin.js` into `$HOME/.local/bin` (`%APPDATA%\npm` on Windows), so `dsh` runs from any directory. The complete build matters: a checkout built without those artifacts starts the terminal UI but hangs when the session flushes on exit.

The installer is idempotent: re-run `pnpm run link:dsh` after a rebuild, or to repair a link left dangling by a moved or cleaned checkout. `pnpm run link:dsh -- --dir <path>` installs elsewhere, `DSH_LINK_BIN_DIR` sets the target, and `pnpm run unlink:dsh` removes a link this checkout installed. An entry owned by another program is refused rather than overwritten.

A registry install (`npx @deepseek-ai/dsh` or `npm install -g`) cannot carry this fork's terminal surface, because `@deepseek-ai/dsh-tui-app` is not published and the launcher's other dependencies would resolve to the upstream packages.

### Run from source

```sh
pnpm install
pnpm run build
pnpm dsh
```

`pnpm run build` prepares the repository artifacts, and `pnpm dsh` uses them without rebuilding. `pnpm run build:tui` builds only the native system addon and the host compiler face the terminal UI needs.

### Flags

`dsh` opens the terminal UI; `dsh --profile tui` names the profile explicitly. `--resume <session-id>` resumes a stored session, and `--provider` / `--model` select the routed model for a new session. `--watch <session-id>` opens the read-only viewer for a local subagent and cannot be combined with the session flags. The app refuses to start without an interactive terminal, so a piped or redirected invocation fails loudly instead of waiting for keys it cannot read.

## What the terminal UI offers

- **One Agent, one session.** The Agent runs in-process; every invocation draws its own transcript and holds a single session.
- **Steering and interruption.** While a turn runs, Enter submits text the running turn consumes at its next step, and Esc interrupts the turn together with every live subagent descendant. Delegated work outlives the turn, so the footer keeps reporting `running` while a child is still active.
- **Full-screen transcript.** PageUp/PageDown, the mouse wheel, and terminal search scroll the transcript without leaving the app; the status bar reports when the view has scrolled away from the newest row. In alternate-screen mode, selecting text copies it on release.
- **Plan mode.** Shift+Tab toggles plan mode for the session's Agent. When the agent finishes planning it presents the plan as markdown above the Approve / Keep planning choice.
- **Clipboard images.** Ctrl+V (Alt+V on Windows and WSL) attaches the image on the system clipboard to the draft, and the composer shows every held image as an `[Image #1]` marker.
- **Approvals.** Approval prompts offer Allow once / Always allow `<tool>` / Reject for the app's Agent and its live subagents, and a child's prompt is labeled with the child. Always allow records a per-tool grant on the session, so later asks for that tool proceed without a prompt and survive resume.
- **Questions.** `ask_user_question` renders as a picker — checkable when the question sets `multiSelect` — or a free-text input; `Other…` opens the free-text answer, Esc skips to the next question, and Ctrl+C cancels the batch. A settled call reports the chosen labels instead of raw result JSON.
- **Delegated subagents.** Once the session has delegated work, the footer shows `● subagents (running/total)`. `/subagents` opens a pinned, scrollable panel with every delegated child, nested children included, and each child's activation state and watch command; it re-reads live sessions, so children join and leave while it is open.
- **Local shell commands.** A line beginning with `!` runs in the session's workspace under the same sandbox policy as the Agent's `bash` tool, with no approval prompt and no model request. Its command and output stay local to this process. See [Local shell commands](#local-shell-commands).
- **Sessions.** Exit prints a `dsh --resume <session-id>` command, and `/sessions` and `/resume` browse and restore stored conversations by title.
- **Compaction.** While a compaction runs outside the turn lifecycle, the footer reports `● compacting` instead of `idle`.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Enter` | Submit the prompt, steer the running turn, or close the subagent panel |
| `Esc` | Interrupt the running turn and the session's live subagents; at a prompt, skip the question; in the subagent panel, close it |
| `Shift+Tab` | Toggle plan mode |
| `Ctrl+V` | Attach the image on the system clipboard to the draft (`Alt+V` on Windows and WSL) |
| `Ctrl+C` | Cancel the running turn and live subagents, or stop a local `!` command; at a prompt, cancel the whole ask; in the subagent panel, close it; with neither working, exit |
| `Ctrl+D` | Exit |
| `PageUp` / `PageDown` | Scroll the transcript, a question's overflowing detail, or the subagent panel |
| `Up` / `Down` | Scroll a question's overflowing detail or the subagent panel; otherwise move its picker |
| `Left` / `Right` | Move a picker's selection while a question's detail owns the arrows |
| `Space` | Check or uncheck an option in a multi-select question |
| `Ctrl+L` | Repaint from scratch |

## Commands

A line beginning with a known `/command` runs that command instead of reaching the model; other slash text reaches the Agent unchanged. Registered commands such as `/compact`, `/goal`, and `/plan` are discovered from the command registry and dispatched against the live Agent.

| Command | Effect |
|---|---|
| `/help` | List the app's commands and every registered command |
| `/new` | Flush and close the session, then start a fresh one |
| `/sessions` | List stored sessions by title, newest first |
| `/subagents` | Open a pinned, live panel of delegated children with their activation state and watch command |
| `/resume [id]` | Resume a stored session by id, or choose one from a picker of stored sessions labeled by title |
| `/model [provider/model]` | Choose a model from the live catalog, or switch directly |
| `/effort [id]` | Choose the routed model's declared reasoning effort, or switch directly |
| `/questions` | Answer a question whose foreground window closed |
| `/quit` | Exit |

### Local shell commands

A line beginning with `!` runs locally instead of reaching the Agent: `!git status` executes through the mounted shell executor under the same sandbox policy as the Agent's `bash` tool, without an approval prompt. Each line is a fresh shell in the session's working directory, so `cd` and exported variables do not carry to the next line. The command asks for a 600-second bound, and output beyond the per-stream cap stays a tail whose spill file the row names. The footer reads `● shell` while it runs.

The row is local only. Its command and output never enter the session log, are never sent to the model, and disappear on `/new`, `/resume`, and exit. `\!ls` sends the literal text `!ls` to the Agent instead. One local command runs at a time: prompts and further `!` lines are refused while it runs, and a `!` line is refused while a turn or compaction runs, keeping the draft. Ctrl+C stops the running command and keeps the output it already produced; slash commands remain available.

## Watching a subagent

When a local subagent starts, the TUI publishes a loopback connection and prints a watch command as an ordinary notice:

```
· watch: dsh watch <session-id>
```

Run that command in another terminal to follow the child. `dsh tui --watch <session-id>` is the equivalent explicit spelling. The viewer is read-only: it has no composer and does not send prompts, approve tools, or cancel the child. It shows the committed transcript plus the text, reasoning, tool calls, and approval rows currently streaming, and its footer reports the child's state and connection — `online`, `history`, or `disconnected` — with context occupancy, throughput, tokens, and cache-hit share. PageUp/PageDown, the mouse wheel, selection copy, and the palette work as they do in the interactive surface; Esc, Ctrl+C, and Ctrl+D only leave the viewer.

When no live service exists, the viewer opens the stored log and marks `history`; it takes no write lock, restores no Agent, and issues no model request. Only local subagents started by a TUI can be watched, and a dropped viewer connection reports the disconnect instead of reconnecting. Both terminals must use the same user, the same `$DSH_HOME`, and compatible TUI persistence settings.

## Settings

| Field | Default | Meaning |
|---|---|---|
| `screen` | `'alternate'` | `'alternate'` draws in the alternate screen with the app's own scroll window; `'inline'` draws into the normal screen and leaves history to the terminal scrollback. |
| `colorScheme` | `'auto'` | `'auto'` follows the terminal's exported background signal and otherwise stays dark; `'dark'` and `'light'` pin the palette. |

## Learn more

- [Package README](packages/bundle/tui-app/README.md) — implementation, watch protocol, and known limitations.
- [Upstream project README](README.upstream.md) — the full harness, plugin architecture, Web UI, and Desktop.
- [Development guide](docs/development.md) and [architecture documentation](docs/architecture.md) — contributor setup and design.
- [Contributing](CONTRIBUTING.md), the [MIT license](LICENSE), and [third-party notices](THIRD_PARTY_NOTICES.md).
