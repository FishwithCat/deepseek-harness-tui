# Contributing to the TUI distribution

English | [中文](CONTRIBUTING.zh.md)

This directory contains the npm launcher for the terminal distribution. A release also publishes `apps/cli` as `@fishwithcat/dsh` and `packages/bundle/tui-app` as `@fishwithcat/dsh-tui-app`. The release scripts are [`pack-tui.ts`](../../scripts/release/pack-tui.ts) and [`publish-tui.ts`](../../scripts/release/publish-tui.ts); the workflows are [`release-tui.yml`](../../.github/workflows/release-tui.yml) and [`verify-tui.yml`](../../.github/workflows/verify-tui.yml).

## Version model

The distribution has two layers. The **TUI layer** (`@fishwithcat/dsh`, `@fishwithcat/dsh-tui-app`, and `@fishwithcat/dsh-tui`) carries a fork version of the form `<upstream>.fork.<n>`, such as `0.2.2-alpha.2.fork.1`. The **core overlay** (`dsh-agent`, `dsh-session`, `dsh-user-approval`, `dsh-tool-ask-user`, `dsh-compaction`, `dsh-compaction-basic`, `dsh-subagent`, and `dsh-tool-todo`) keeps the upstream version.

Upstream packages declare exact ranges and required peers on the core overlay. A fork version there would make npm install a second upstream copy, so only the TUI layer moves independently. A TUI-layer release does not wait for an upstream release; a core-overlay change does.

## Trusted publishing

The release workflow authenticates with GitHub OIDC and reads no npm token. Each of the 11 packages needs one trust relationship for `FishwithCat/deepseek-harness-tui`, workflow `release-tui.yml`, and environment `npm-publish`.

Configure all 11 from a machine with an npm session that has 2FA and write access. Use an isolated user config if the normal one carries a granular token, because `npm trust` rejects bypass-2FA tokens:

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

`npm trust` requires npm 11.15 or later and a package that already exists. If the local npm is older, replace `npm trust` in the loop with `npx --yes npm@12 trust` or install npm 12 first. The temporary cache and log paths keep the command away from a root-owned `~/.npm`. The first request prompts for 2FA; npm offers to skip prompts for five minutes so the rest of the loop can finish. The registry allows one trust relationship per package. If one already exists, list it with `npm trust list <package>` and remove it with `npm trust revoke --id <id> <package>` before adding the new one.

`--allow-stage-publish` is enough for this workflow. Add `--allow-publish` only if CI should also publish without staging. The trust relationship covers future versions of that package.

Remove `/tmp/npm-trust.npmrc` after the loop; it holds the login session used for the configuration.

## Release steps

Staging runs through the trust relationship above. Approval needs 2FA on an npm account that owns the scope. `npm stage` requires npm 12.

1. Push the release commit to `master`.
2. Run **Actions → Stage TUI (npm)** with `version` set to the fork version and `with_core` off.
3. Open the run summary and approve the stage ids in the listed order with `npm stage approve <id>` (npm 12) or the npm website.
4. Run **Actions → Verify TUI (npm)** with the same version. It installs the published launcher and checks that the core overlay has one copy, the CLI is the fork build, `--version` prints the fork version, and `--help` boots the TUI.

The stage step applies the `latest` dist-tag, so `npx @fishwithcat/dsh-tui` resolves to the approved version. Never dispatch an already published version; npm rejects the upload. Use the next `.fork.<n>` for a new TUI-layer release.

## New upstream base

Merge the upstream base first, then dispatch **Stage TUI (npm)** with `version` set to `<new-base>.fork.1` and `with_core` on. That publishes the eight core packages at the new base before the TUI layer. Later TUI-layer releases on that base leave `with_core` off.
