---
kind: upgrade-guide
description: "Source checkouts start the terminal UI with `dsh-tui` and the renamed setup, link, and unlink scripts."
---

# Local terminal entry moves to `dsh-tui`

English | [中文](guide.zh.md)

## Change

A source checkout now starts the terminal UI with `dsh-tui`, matching the npm launcher. `pnpm run setup:dsh-tui`, `pnpm run link:dsh-tui`, and `pnpm run unlink:dsh-tui` replace `setup:dsh`, `link:dsh`, and `unlink:dsh`. The installer links `apps/tui-launcher/lib/bin.js` as `dsh-tui` instead of linking `apps/cli/lib/bin.js` as `dsh`. Installing or removing `dsh-tui` removes a global `dsh` link this checkout installed and leaves a `dsh` entry owned by another program alone. The in-app resume and subagent watch hints print `dsh-tui --resume` and `dsh-tui watch`. `pnpm dsh` stays the source-plane CLI entry for other profiles.

## Migration

1. Run `pnpm run setup:dsh-tui` on a fresh clone, or `pnpm run link:dsh-tui` after rebuilding an existing checkout.
2. Replace global `dsh` invocations that opened the terminal UI with `dsh-tui`; keep `pnpm dsh --profile <name>` for web, headless, and other profiles.
3. Run `dsh-tui --version` and `dsh-tui --resume <session-id>` to confirm the launcher resolves the built CLI and opens the profile.
4. No separate cleanup is needed for an old `dsh` link installed by `setup:dsh`; the installer removes it, and a `dsh` entry owned by another program remains.
