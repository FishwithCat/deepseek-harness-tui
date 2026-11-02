# `@deepseek-ai/dsh-tui-launcher`

[English](README.md) | 中文

npm 安装后的终端入口。`dsh-tui` 在 `tui` profile 不存在时创建它，解析已安装的
`@deepseek-ai/dsh` CLI，并以 `--profile tui` 启动，原样转发应用参数。打包后的
manifest 把这个 CLI 依赖别名到本 fork 的构建，因此实际解析到的是 fork 的启动器，
而不是上游包。profile 由启动器固定：`--profile`、`--from-default-profile` 和
`dsh plugin` 会被拒绝。

实际发布的包名是 `@fishwithcat/dsh-tui`。打包后的 manifest 会把 workspace
依赖替换成指向 fork 包的 `npm:` 别名，让上游 CLI 按同一批依赖名解析到 fork 的
构建。启动器和所有被别名的包必须与上游同号；`-fork.N` 不满足上游包声明的精确
范围。

`dsh-tui watch <session-id>` 会转换成 `--watch <session-id>`，`dsh-tui --version`
不会创建 profile。
