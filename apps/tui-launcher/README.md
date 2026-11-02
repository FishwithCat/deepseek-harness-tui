# `@deepseek-ai/dsh-tui-launcher`

English | [中文](README.zh.md)

The npm-installed terminal entry. `dsh-tui` creates the `tui` profile when it
is missing, resolves the installed `@deepseek-ai/dsh` CLI, and runs it with
`--profile tui`, forwarding every application argument. The packed manifest
aliases that CLI dependency to this fork's build, so the resolved command is
the fork's launcher rather than the upstream package. The launcher owns the
profile choice: `--profile`, `--from-default-profile`, and `dsh plugin` are
rejected.

The published package is `@fishwithcat/dsh-tui`. Its packed manifest aliases
the TUI layer (`@fishwithcat/dsh` and `@fishwithcat/dsh-tui-app`) at the fork
version and the eight core-overlay packages at the upstream version, so the
upstream CLI resolves every name to the fork's builds while upstream exact
ranges and required peers keep one copy. A fork version has the form
`<upstream>.fork.<n>`.

`dsh-tui watch <session-id>` is translated to `--watch <session-id>`, and
`dsh-tui --version` prints the launcher's fork version without creating a
profile or resolving the installed CLI.
