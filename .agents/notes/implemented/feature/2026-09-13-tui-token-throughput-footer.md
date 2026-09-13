# Agent Note: TUI footer token throughput and cache figures

Status: implemented

English | [中文](2026-09-13-tui-token-throughput-footer.zh.md)

## Problem

The Web chat stats strip reports whole-session figures — decode throughput in tokens per second, the billed token total, and the cache-hit share — from the `sessionStats` and `tokenUsage` session projections. The [fork terminal surface](../architecture/2026-09-11-fork-terminal-surface.md) footer reported only the last provider call's `↑in ↓out` and the next request's context occupancy, so a terminal user could not see how fast the session was decoding, how many tokens it had consumed, or how much of the prompt the provider served from cache.

## Decision

**The TUI mounts `dsh-session-stats` and reads the same folds the Web strip reads.** The bundle patch inserts the `session-stats` row, whose unit registers the `sessionStats` projection key on the base projection registry; totals and the cache-hit share come from `tokenUsage`, which the base-mounted token meter already registers. No timing fold is re-derived in the terminal.

**One projection snapshot serves the whole footer.** `TuiApp.measurement` reads `contextPressure`, `tokenUsage`, and `sessionStats` together and caches the derived `{context, stats}` against the Session and its log position, because the live Assistant stream repaints far more often than it appends events. Keying on the Session as well as the seq keeps a `/new` or `/resume` replacement from reusing the previous session's figures.

**The figures are the footer's bottom-right group.** `StatusBar` pairs the existing accounting — last-call usage and occupancy — on the left of the bottom line with `sessionStatsParts`: `<tps> tok/s`, `<total> tok`, and `<cache>% cache`, each omitted until it has data. The group is right-aligned through the existing `pairLine`, so it truncates and then drops before the accounting on a narrow terminal; when it renders nothing, the line is exactly what it was before. Formatting mirrors the Web strip: whole `tok/s` from ten up, compact token counts, and a cache share that never rounds a partial hit to `100%`.

## Alternatives considered

**Re-derive the decode fold inside the TUI.** The terminal already folds every session event for the transcript, so it could track step boundaries and first-token times itself. It lost because `dsh-session-stats` already owns that fold with its own real-composition and wall-time tests; a second copy would drift and add a timing surface to maintain.

**Show live instantaneous throughput from stream chunks.** That would move while a response streams. It lost because it is a different figure from the Web strip, needs a separate sampling policy, and reads as noise between settlements.

**Put the group on a third footer line.** A dedicated line would give the figures more room. It lost because the footer is deliberately two lines and every prompt panel's row budget is computed from that (`PINNED_FOOTER_ROWS`); the bottom-right of the existing line is the corner the request named.

## Consequences

The TUI profile now mounts one more host row, and `dsh-tui-app` declares `@deepseek-ai/dsh-session-stats` as a dependency so the patch row resolves from the bundle's own manifest. The figures are whole-log averages updated when a step settles, matching the Web strip rather than tracking the live stream. A session without the projection registry, or a deployment that unmounts either unit, omits only the figures those units supply.

## Testing

`tests/transcript.spec.ts` pins `sessionStatsParts` directly — throughput formatting on both sides of ten, the negative clamp, omitted figures, a full hit, an integer partial, a decimal partial, and a ratio clamped to `99.9` — and the `StatusBar` rendering: the group right-aligned on the bottom line, the accounting line unpadded while no figure has data, and the group yielding before the accounting at a narrow width. `tests/tui-app.spec.ts` boots the app over the real registries with the token meter and the session-stats plugin mounted, then appends a step whose message carries usage and a first-token timestamp, asserting `1.1k tok`, `90% cache`, and `tok/s` in the composited frame.
