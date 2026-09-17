# Agent Note: The fork terminal surface

Status: implemented

English | [中文](2026-09-11-fork-terminal-surface.zh.md)

## Problem

This fork needs an interactive terminal surface comparable to other terminal coding agents: a full-screen transcript, a pinned composer, streaming output, tool rows, and terminal answers to the approvals and questions an Agent pauses on. Upstream ships `web`, `headless`, `sdk`, `sdk-minimal`, and `acp`, so a terminal user could only drive a browser, run one shot, or attach an editor over a protocol.

The fork also has to stay cheap to rebase. Anything that changes how existing surfaces compose, or that turns launcher behavior into fork-only behavior without an escape hatch, makes every future upstream merge a decision instead of a conflict.

## Decision

**Only known commands claim slash input.** The app checks its existing command catalog before dispatch, so local and registered commands take precedence over same-named skills. Every other slash line uses ordinary prompt submission or steering. Skill discovery and instruction injection remain owned by the shared skill plugins; the terminal does not maintain a second skill resolver. Composer tests cover idle submission, running-turn steering, and command precedence.

**The surface is an ordinary bundle over `dsh-base`.** `@deepseek-ai/dsh-tui-app` adds no host, HTTP server, Web runtime, or browser row; it inserts a command-line provider and one app plugin. The `tui` profile template is `['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-tui-app']` with startup patch reload, like the other applications that own work once they start. `dsh-base` already keeps its model-facing rows in the host plane precisely because "the TUI is single-session and composes its agent process-wide", so no base row had to move. Profiles and bundles themselves are the mechanism from [the profile-plugin-bundles decision](2026-08-05-profile-plugin-bundles.md).

**The app drives one Agent in the same process.** It awaits the complete composition, creates or resumes the Agent through `ctx.agents`, and subscribes to the durable `session/event` log, the live `agent/assistant-stream` feed, and `agent/status`. There is no second process, no wire protocol, and no client-side session replica to keep in step.

**The terminal library is the maintained sibling of the one the reference agent ships.** `@earendil-works/pi-tui` provides the alternate-screen viewport, scroll view, composer, markdown renderer, select list, and mouse handling. The deprecated `@mariozechner/pi-tui` publishes the same package under the old namespace; the repository already depends on `@earendil-works/pi-ai`, so the fork stays on that release train.

**Both screen strategies ship, and the alternate screen is the default.** `TuiAltScreen` gives the transcript its own scroll window with the status bar and composer pinned; `TuiMainScreen` renders into the normal screen and leaves history to the terminal's own scrollback. `Config.screen` selects between them after validation, with `DSH_TUI_SCREEN` supplying the bundle default.

**The footer sits under the composer and reports the routed capacity.** The surface keeps the reference agent's footer order — transcript, composer, then a pinned footer — so the facts a user watches while typing stay at the bottom edge across two lines: the workspace and Agent state right-aligned against the routed model and its reasoning effort, then the token accounting and the next request's occupancy against the routed model's capacity. The key hints are the empty composer's placeholder, which keeps them visible while the user decides what to type without spending a footer line. Occupancy and capacity come from the `ctx.tokenMeter` projection and the automatic-compaction policy from `ctx.compaction.autoCompactionEnabled`, so a surface presents deployment facts without reading a provider's configuration.

**The app answers the two interaction seams for its own Agent only.** `approval/request` offers Allow once / Reject and delegates every other Agent's request; a dismissed prompt resolves `cancelled`, which the approval service already treats as fail-closed. `user-questions/request` renders the declared options, or a free-text input when none are declared, with the question's `detail` as scrollable markdown above that control, and fails the asking Tool with `ASK_ABORTED` when the user dismisses it. Delegating rather than claiming keeps a composition that also mounts subagents correct.

**A bare `dsh` boots the fork default, and the override is one environment variable.** `dsh` resolves the profile as `options.profile ?? process.env.DSH_DEFAULT_PROFILE ?? 'tui'`. `DSH_DEFAULT_PROFILE=web` selects the browser default, and an empty value restores the upstream requirement that every invocation name its profile, so an upstream-minded deployment can recover the old behavior without patching anything.

The upstream diff is small and additive: the `tui` entry in `PROFILE_TEMPLATES`, the bundle dependency and three scripts in the root and `apps/cli` manifests, the default-profile resolution in `apps/cli/src/args.ts`, the project references and the `startup` path alias, and the release-age exemption for the terminal library — plus the tests that asserted the removed "profile required" error. Everything else lives in the new package.

**The fork ships its own global installer.** `scripts/link-dsh.ts` (`pnpm run link:dsh`, `unlink:dsh`, and `setup:dsh` for a fresh clone) links the built `apps/cli/lib/bin.js` into `$HOME/.local/bin` or `%APPDATA%\npm`. A registry install cannot serve this fork: `@deepseek-ai/dsh-tui-app` is unpublished and the launcher's other `workspace:^` ranges would resolve to upstream packages, so the installed command must name the checkout's build output. The installer is idempotent, refreshes a link a moved or cleaned checkout left dangling, and refuses an entry owned by another program. `setup:dsh` runs the complete build (`pnpm run build`) rather than the library build alone: the native system addon and the client compiler face are both required before the surface can flush a session and exit.

## Reintroduction after the upstream removal

Upstream deleted its own terminal frontend in [the TUI-package removal decision](../../archived/simplification/2026-08-04-remove-tui-package.md), which names what any reintroduction owes: "a named product or deployment, an explicit package boundary, a concrete interaction provider, and assembled lifecycle and transcript acceptance for that frontend." This fork is that deployment, and each condition is met by construction rather than by inheriting the deleted package.

The named deployment is this fork's default `dsh` invocation, which is why the surface ships as a profile rather than as a reusable UI package: the composition itself is the product need. The package boundary is `packages/bundle/tui-app`, a bundle whose only exports are its plugin, its command-line provider, and its patch file. The concrete interaction providers are the two answerers the app registers, one per seam the Agent pauses on. The assembled acceptance is the profile boot itself: the package tests drive composer routing, rendering, modal answers, and exit through a substituted `Terminal`, the startup test parses the flag family over a real Loader tree, and a pseudo-terminal run of `dsh --profile tui` renders the transcript and exits cleanly.

Nothing is inherited from the deleted implementation. It was deleted with its patched `pi-tui` artifact; this surface depends on the maintained published library instead, which is why the patch and its vendored artifact do not return.

## Alternatives considered

**A TUI client over the SDK JSON-RPC server.** `dsh --profile sdk` already serves a documented protocol, so a terminal client could attach to it. It lost because it doubles the failure surface for no capability this surface needs: two processes, a transport, and a client-side session replica that must be kept consistent with the durable log the app can already read directly. It stays available for out-of-process clients that genuinely need it.

**A terminal client of the Web Host API.** Reusing `ctx.sessionController`, the gateway, and the projection surface would reuse the most logic. It lost because it drags the Host/HTTP/browser assembly into a surface that needs none of it, and the client half of that stack is `platform: "web"` only, so the terminal would still need a renderer built from scratch on top of the largest possible dependency.

**Reusing the React client packages (`packages/client/*`).** The chat, tool, and session state packages already solve presentation and state. They lost because every one of them renders DOM through a Web-only client module platform; a terminal could reuse the stores but not the components, leaving a mixed architecture with two presentation stacks to maintain.

**Hand-rolled ANSI rendering.** A small renderer would have kept the dependency closure empty. It lost because the existing library already deletes a composer with history and kill-ring support, markdown rendering, a scroll view, the alternate-screen viewport, mouse selection, and the differential renderer — all of which would otherwise be owned code with its own tests.

**Restoring the deleted `packages/ui/tui` implementation.** Its renderer, cards, and adapters were written against this codebase. It lost on two counts the removal decision already named: it was built for a `dsh` invocation shape that no longer exists (the explicit-config entrypoint, not profiles), and it carried a patched `pi-tui` artifact the repository would have to re-own. The removal decision's own conclusion is the rule followed here — a terminal frontend starts from its actual host and interaction requirements rather than inheriting the old implementation by default.

**Changing the upstream default in place without an override.** Making `tui` the default unconditionally is the smallest diff. It lost because a fork that cannot reproduce upstream's contract cannot bisect a difference against it; one environment variable preserves that ability at the cost of one expression.

## Consequences

The fork gains an interactive terminal surface without changing how any existing profile composes, and an upstream rebase touches three small hunks that the Agent Note names. The surface is testable without a terminal: the app takes its `Terminal` from `internals`, and the transcript fold is pure with respect to I/O, so both composer routing and modal answers run against a substituted terminal.

The cost is a new runtime dependency and its closure, which the third-party notices now disclose; the initial profile boot is heavier than headless because the interactive surface keeps the full base composition (session titles, goals, commands, and the projection registry) mounted.

Boundaries are deliberate and recorded in the package README: one Agent per invocation, a composer whose only attachment is a clipboard image ([TUI clipboard image paste](../feature/2026-09-11-tui-clipboard-image-paste.md)), folded Tool output, injected context shown only as the notice its producer declared, one choice per prompt for a `multiSelect` question, and the launcher-owned exit that every surface shares.

One coverage gap is named rather than closed: the keyless snapshot harness drives shipped profiles over stdio, so it cannot record this surface's terminal output. Its acceptance is the package tests plus a pseudo-terminal run, and a terminal-layout regression needs those tests extended rather than a snapshot re-recorded.
