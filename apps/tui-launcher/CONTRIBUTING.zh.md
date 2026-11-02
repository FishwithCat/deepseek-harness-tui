# 为 TUI 发行版贡献

[English](CONTRIBUTING.md) | 中文

本目录包含终端发行版的 npm 启动器。一次发布还会把 `apps/cli` 发布为 `@fishwithcat/dsh`，把 `packages/bundle/tui-app` 发布为 `@fishwithcat/dsh-tui-app`。发布脚本是 [`pack-tui.ts`](../../scripts/release/pack-tui.ts) 和 [`publish-tui.ts`](../../scripts/release/publish-tui.ts)；workflow 是 [`release-tui.yml`](../../.github/workflows/release-tui.yml) 和 [`verify-tui.yml`](../../.github/workflows/verify-tui.yml)。

## 版本模型

发行版分两层。**TUI 层**（`@fishwithcat/dsh`、`@fishwithcat/dsh-tui-app`、`@fishwithcat/dsh-tui`）使用 `<upstream>.fork.<n>` 形式的 fork 版本，例如 `0.2.2-alpha.2.fork.1`。**core 覆盖层**（`dsh-agent`、`dsh-session`、`dsh-user-approval`、`dsh-tool-ask-user`、`dsh-compaction`、`dsh-compaction-basic`、`dsh-subagent`、`dsh-tool-todo`）保持上游版本。

上游包对 core 覆盖层声明了精确范围和 required peer。在那里改用 fork 版本会让 npm 额外安装一份上游 core，因此只有 TUI 层独立升版。TUI 层发布不需要等上游；core 覆盖层的改动需要新的上游 base。

## 发布步骤

暂存发布（staging）需要 `@fishwithcat` scope 的写权限和 `npm-publish` environment；审批需要 scope 所有者账号的 2FA。`npm stage` 需要 npm 12。

1. 把发布提交推到 `master`。
2. 运行 **Actions → Stage TUI (npm)**，`version` 填 fork 版本，`with_core` 不勾选。
3. 打开 run summary，按表格顺序用 `npm stage approve <id>`（npm 12）或在 npm 网站审批。
4. 运行 **Actions → Verify TUI (npm)**，填同一个版本。它会安装已发布的启动器，检查 core 覆盖层只有一份、CLI 是 fork 构建、`--version` 输出 fork 版本、`--help` 能启动 TUI。

stage 步骤会应用 `latest` dist-tag，因此 `npx @fishwithcat/dsh-tui` 解析到已审批的版本。不要重复发布已存在的版本；npm 会拒绝上传。新的 TUI 层发布使用下一个 `.fork.<n>`。

## 新的上游 base

先合并上游 base，再用 `<new-base>.fork.1` 和勾选的 `with_core` 运行 **Stage TUI (npm)**。它会先发布新 base 的 8 个 core 包，再发布 TUI 层。之后在该 base 上的 TUI 层发布保持 `with_core` 不勾选。
