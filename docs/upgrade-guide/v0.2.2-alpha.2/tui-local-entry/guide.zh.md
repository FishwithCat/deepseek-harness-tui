---
kind: upgrade-guide
description: "源码 checkout 改用 `dsh-tui` 启动终端界面，并重命名 setup、link 与 unlink 脚本。"
---

# 本地终端入口迁移到 `dsh-tui`

[English](guide.md) | 中文

## 变更

源码 checkout 现在改用 `dsh-tui` 启动终端界面，与 npm 启动器一致。`pnpm run setup:dsh-tui`、`pnpm run link:dsh-tui` 与 `pnpm run unlink:dsh-tui` 取代 `setup:dsh`、`link:dsh` 与 `unlink:dsh`。安装器改为把 `apps/tui-launcher/lib/bin.js` 链接为 `dsh-tui`，不再把 `apps/cli/lib/bin.js` 链接为 `dsh`。安装或删除 `dsh-tui` 时，会删除本 checkout 安装的全局 `dsh` 链接，并保留属于其他程序的 `dsh` 条目。应用内的恢复提示与 subagent 查看提示改为打印 `dsh-tui --resume` 与 `dsh-tui watch`。`pnpm dsh` 仍是其他 profile 的源码面 CLI 入口。

## 迁移

1. 新克隆的仓库运行 `pnpm run setup:dsh-tui`；已有 checkout 重新构建后运行 `pnpm run link:dsh-tui`。
2. 把用 `dsh` 打开终端界面的全局调用改为 `dsh-tui`；web、headless 与其他 profile 继续使用 `pnpm dsh --profile <name>`。
3. 运行 `dsh-tui --version` 与 `dsh-tui --resume <session-id>`，确认启动器解析到已构建的 CLI 并打开 profile。
4. 无需单独清理旧 `setup:dsh` 创建的全局 `dsh` 链接：安装器会删除它，属于其他程序的 `dsh` 条目会保留。
