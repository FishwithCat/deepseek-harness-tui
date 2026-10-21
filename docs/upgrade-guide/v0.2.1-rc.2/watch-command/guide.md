---
kind: upgrade-guide
description: "The watch subcommand reserves the shorthand for custom profiles named watch."
---

# `watch` opens the subagent viewer

English | [中文](guide.zh.md)

## Change

`dsh watch <session-id>` opens the read-only TUI subagent viewer. The leading `watch` token is a reserved subcommand, so `dsh watch` no longer launches a custom profile named `watch`. The existing `dsh tui --watch <session-id>` command remains available.

## Migration

1. If you have a custom profile named `watch`, launch it with `dsh --profile watch`, passing its app arguments afterward.
2. Run `dsh watch --help` to confirm that the subcommand lists `<session-id>` as its required argument.
