---
kind: upgrade-guide
description: "watch 子命令占用了名为 watch 的自定义 profile 的简写。"
---

# `watch` 打开子代理查看器

[English](guide.md) | 中文

## 变更

`dsh watch <session-id>` 打开只读 TUI 子代理查看器。开头的 `watch` 是保留子命令，因此 `dsh watch` 不再启动名为 `watch` 的自定义 profile。现有的 `dsh tui --watch <session-id>` 命令仍可使用。

## 迁移

1. 如果你有名为 `watch` 的自定义 profile，使用 `dsh --profile watch` 启动，并在其后传入应用参数。
2. 运行 `dsh watch --help`，确认子命令将 `<session-id>` 列为必需参数。
