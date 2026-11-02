# 为 TUI 发行版贡献

[English](CONTRIBUTING.md) | 中文

本目录包含终端发行版的 npm 启动器。一次发布还会把 `apps/cli` 发布为 `@fishwithcat/dsh`，把 `packages/bundle/tui-app` 发布为 `@fishwithcat/dsh-tui-app`。发布脚本是 [`pack-tui.ts`](../../scripts/release/pack-tui.ts) 和 [`publish-tui.ts`](../../scripts/release/publish-tui.ts)；workflow 是 [`release-tui.yml`](../../.github/workflows/release-tui.yml) 和 [`verify-tui.yml`](../../.github/workflows/verify-tui.yml)。

## 版本模型

发行版分两层。**TUI 层**（`@fishwithcat/dsh`、`@fishwithcat/dsh-tui-app`、`@fishwithcat/dsh-tui`）使用 `<upstream>.fork.<n>` 形式的 fork 版本，例如 `0.2.2-alpha.2.fork.1`。**core 覆盖层**（`dsh-agent`、`dsh-session`、`dsh-user-approval`、`dsh-tool-ask-user`、`dsh-compaction`、`dsh-compaction-basic`、`dsh-subagent`、`dsh-tool-todo`）保持上游版本。

上游包对 core 覆盖层声明了精确范围和 required peer。在那里改用 fork 版本会让 npm 额外安装一份上游 core，因此只有 TUI 层独立升版。TUI 层发布不需要等上游；core 覆盖层的改动需要新的上游 base。

## Trusted publishing

发布 workflow 使用 GitHub OIDC 认证，不读取 npm token。11 个包各自需要一条信任关系，指向 `FishwithCat/deepseek-harness-tui`、workflow `release-tui.yml` 和 environment `npm-publish`。

在一台已启用 2FA、且对包有写权限的机器上配置全部 11 个包。如果默认配置里带着 granular token，请用独立的 user config，因为 `npm trust` 拒绝 bypass-2FA token：

```sh
export npm_config_userconfig=/tmp/npm-trust.npmrc
export npm_config_cache=/tmp/npm-trust-cache
export npm_config_logs_dir=/tmp/npm-trust-logs
npm login --registry=https://registry.npmjs.org/

for package in \
  @fishwithcat/dsh-agent \
  @fishwithcat/dsh-session \
  @fishwithcat/dsh-user-approval \
  @fishwithcat/dsh-tool-ask-user \
  @fishwithcat/dsh-compaction \
  @fishwithcat/dsh-compaction-basic \
  @fishwithcat/dsh-subagent \
  @fishwithcat/dsh-tool-todo \
  @fishwithcat/dsh-tui-app \
  @fishwithcat/dsh \
  @fishwithcat/dsh-tui; do
  npm trust github "$package" \
    --repository FishwithCat/deepseek-harness-tui \
    --file release-tui.yml \
    --environment npm-publish \
    --allow-stage-publish \
    --yes \
    --registry=https://registry.npmjs.org/
  sleep 2
done
```

`npm trust` 需要 npm 11.15 或更高版本，并且包已存在。如果本机 npm 更旧，把循环里的 `npm trust` 换成 `npx --yes npm@12 trust`，或先安装 npm 12。临时的 cache 和日志路径可以避开 root 拥有的 `~/.npm`。第一条请求会要求 2FA；npm 提供跳过后续五分钟提示的选项，让循环能跑完。registry 对每个包只允许一条信任关系。如果已经存在，先用 `npm trust list <package>` 查看，再用 `npm trust revoke --id <id> <package>` 删除，然后重新添加。

该 workflow 只需 `--allow-stage-publish`。只有希望 CI 绕过暂存直接发布时，才加 `--allow-publish`。信任关系覆盖该包的后续版本。

循环结束后删除 `/tmp/npm-trust.npmrc`；它保存了本次配置使用的登录会话。

## 发布步骤

暂存发布通过上面的信任关系完成。审批需要 scope 所有者账号的 2FA。`npm stage` 需要 npm 12。

1. 把发布提交推到 `master`。
2. 运行 **Actions → Stage TUI (npm)**，`version` 填 fork 版本，`with_core` 不勾选。
3. 打开 run summary，按表格顺序用 `npm stage approve <id>`（npm 12）或在 npm 网站审批。
4. 运行 **Actions → Verify TUI (npm)**，填同一个版本。它会安装已发布的启动器，检查 core 覆盖层只有一份、CLI 是 fork 构建、`--version` 输出 fork 版本、`--help` 能启动 TUI。

stage 步骤会应用 `latest` dist-tag，因此 `npx @fishwithcat/dsh-tui` 解析到已审批的版本。不要重复发布已存在的版本；npm 会拒绝上传。新的 TUI 层发布使用下一个 `.fork.<n>`。

## 新的上游 base

先合并上游 base，再用 `<new-base>.fork.1` 和勾选的 `with_core` 运行 **Stage TUI (npm)**。它会先发布新 base 的 8 个 core 包，再发布 TUI 层。之后在该 base 上的 TUI 层发布保持 `with_core` 不勾选。
