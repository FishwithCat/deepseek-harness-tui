# Contributing to the TUI distribution

English | [中文](CONTRIBUTING.zh.md)

This directory contains the npm launcher for the terminal distribution. A release also publishes `apps/cli` as `@fishwithcat/dsh` and `packages/bundle/tui-app` as `@fishwithcat/dsh-tui-app`. The release scripts are [`pack-tui.ts`](../../scripts/release/pack-tui.ts) and [`publish-tui.ts`](../../scripts/release/publish-tui.ts); the workflows are [`release-tui.yml`](../../.github/workflows/release-tui.yml) and [`verify-tui.yml`](../../.github/workflows/verify-tui.yml).

## Version model

The distribution has two layers. The **TUI layer** (`@fishwithcat/dsh`, `@fishwithcat/dsh-tui-app`, and `@fishwithcat/dsh-tui`) carries a fork version of the form `<upstream>.fork.<n>`, such as `0.2.2-alpha.2.fork.1`. The **core overlay** (`dsh-agent`, `dsh-session`, `dsh-user-approval`, `dsh-tool-ask-user`, `dsh-compaction`, `dsh-compaction-basic`, `dsh-subagent`, and `dsh-tool-todo`) keeps the upstream version.

Upstream packages declare exact ranges and required peers on the core overlay. A fork version there would make npm install a second upstream copy, so only the TUI layer moves independently. A TUI-layer release does not wait for an upstream release; a core-overlay change does.

## Release steps

Staging needs write access to the `@fishwithcat` scope and the `npm-publish` environment. Approval needs 2FA on an npm account that owns the scope. `npm stage` requires npm 12.

1. Push the release commit to `master`.
2. Run **Actions → Stage TUI (npm)** with `version` set to the fork version and `with_core` off.
3. Open the run summary and approve the stage ids in the listed order with `npm stage approve <id>` (npm 12) or the npm website.
4. Run **Actions → Verify TUI (npm)** with the same version. It installs the published launcher and checks that the core overlay has one copy, the CLI is the fork build, `--version` prints the fork version, and `--help` boots the TUI.

The stage step applies the `latest` dist-tag, so `npx @fishwithcat/dsh-tui` resolves to the approved version. Never dispatch an already published version; npm rejects the upload. Use the next `.fork.<n>` for a new TUI-layer release.

## New upstream base

Merge the upstream base first, then dispatch **Stage TUI (npm)** with `version` set to `<new-base>.fork.1` and `with_core` on. That publishes the eight core packages at the new base before the TUI layer. Later TUI-layer releases on that base leave `with_core` off.
