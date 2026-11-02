# `@deepseek-ai/dsh-tui-launcher`

[English](README.md) | 中文

npm 安装与源码 checkout 共用的终端入口。`dsh-tui` 在 `tui` profile 不存在时创建
它，解析已安装的 `@deepseek-ai/dsh` CLI，并以 `--profile tui` 启动，原样转发应用
参数。打包后的 manifest 把这个 CLI 依赖别名到本 fork 的构建，因此实际解析到的是
fork 的启动器，而不是上游包。profile 由启动器固定：`--profile`、
`--from-default-profile` 和 `dsh plugin` 会被拒绝。源码 checkout 用
`pnpm run link:dsh-tui` 安装同一个命令，并用 `pnpm dsh-tui` 从源码运行。

实际发布的包名是 `@fishwithcat/dsh-tui`。打包后的 manifest 把 TUI 层
（`@fishwithcat/dsh` 与 `@fishwithcat/dsh-tui-app`）别名到 fork 版本，把 8 个
核心覆盖包别名到上游版本，让上游 CLI 按同一批依赖名解析到 fork 的构建，同时让
上游的精确范围与 required peer 只保留一份副本。fork 版本的形式为
`<upstream>.fork.<n>`。

`dsh-tui watch <session-id>` 会转换成 `--watch <session-id>`，`dsh-tui --version`
会打印启动器的 fork 版本，不创建 profile，也不解析已安装的 CLI。
