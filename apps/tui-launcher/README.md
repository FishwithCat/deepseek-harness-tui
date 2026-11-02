# `@deepseek-ai/dsh-tui-launcher`

English | [中文](README.zh.md)

The npm-installed terminal entry. `dsh-tui` creates the `tui` profile when it
is missing, resolves the installed `@deepseek-ai/dsh` CLI, and runs it with
`--profile tui`, forwarding every application argument. The packed manifest
aliases that CLI dependency to this fork's build, so the resolved command is
the fork's launcher rather than the upstream package. The launcher owns the
profile choice: `--profile`, `--from-default-profile`, and `dsh plugin` are
rejected.

The published package is `@fishwithcat/dsh-tui`. Its packed manifest replaces
the workspace dependencies with `npm:` aliases for the fork-only packages, so
the upstream CLI resolves those names to the fork's builds. Keep the launcher
and every aliased package on the upstream version; a `-fork.N` version does
not satisfy the exact ranges upstream packages declare.

`dsh-tui watch <session-id>` is translated to `--watch <session-id>`, and
`dsh-tui --version` does not create a profile.
