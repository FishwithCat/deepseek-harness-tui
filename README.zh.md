# DeepSeek Harness TUI

[English](README.md) | 中文

本仓库是 DeepSeek Harness 的终端界面 fork。DeepSeek Harness 是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架），构建于**一切皆插件**的架构之上，由 [Cordis](https://github.com/cordiverse/cordis) 驱动。上游项目 README（插件架构、Web UI、Desktop 与完整 harness）见 [README.upstream.md](README.upstream.md)。

在应作为工作区的目录中运行 `dsh`，即在该目录启动一个 Agent：一个会话、一个进程，没有服务器也没有端口。该 Agent 使用的模型、工具、沙箱与审批默认值与其他界面完全一致，但以全屏终端应用呈现：可滚动的对话记录、位于固定页脚之上的输入框，以及报告工作区、上下文占用、路由模型、token 吞吐量、token 总量和缓存命中率的状态行。

裸 `dsh` 默认为终端 profile。设置 `DSH_DEFAULT_PROFILE=web` 可让浏览器重新成为默认，或显式传入 `--profile web`。

## 开发者预览

DeepSeek Harness 处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

运行本项目前，请阅读[安全说明](SAFETY.zh.md)。

<a id="run"></a>

## 安装与运行

终端界面未发布到 registry，因此需要从 checkout 安装。在新克隆的仓库上，一条命令完成安装依赖、完整构建，并把 `dsh` 链接到 `PATH` 上的目录：

```sh
git clone https://github.com/FishwithCat/deepseek-harness-tui.git
cd deepseek-harness-tui
pnpm run setup:dsh
```

完整构建这一点很关键：`pnpm run build` 还会构建原生系统插件与两个编译面，缺少它们的 checkout 虽然能启动终端界面，却会在退出时卡在会话落盘。随后安装器把 `apps/cli/lib/bin.js` 链接到 `$HOME/.local/bin`（Windows 为 `%APPDATA%\npm`），因此在任何目录都能运行 `dsh`。它是幂等的：重新构建后再次运行 `pnpm run link:dsh`，或修复因仓库移动、`clean` 而断开的链接。`pnpm run link:dsh -- --dir <path>` 可安装到其他位置，`DSH_LINK_BIN_DIR` 设置目标目录，`pnpm run unlink:dsh` 删除本 checkout 安装的链接。属于其他程序的同名条目会被拒绝，而不是被覆盖。

从 registry 安装（`npx @deepseek-ai/dsh` 或 `npm install -g`）无法带上本 fork 的终端界面，因为 `@deepseek-ai/dsh-tui-app` 未发布，而启动器的其他依赖会解析到上游包。

<a id="run-from-source"></a>

### 从源码运行

```sh
pnpm install
pnpm run build
pnpm dsh
```

`pnpm run build` 会准备仓库产物，`pnpm dsh` 会直接使用这些产物，不会重新构建。`pnpm run build:tui` 只构建终端界面所需的原生系统插件与 host 编译面。

### 命令行参数

`dsh` 打开终端界面；`dsh --profile tui` 显式指定该 profile。`--resume <session-id>` 继续已存储的会话，`--provider` / `--model` 为新会话选择路由模型。没有交互式终端时应用会拒绝启动，因此管道或重定向调用会明确报错，而不是等待无法读取的按键。

## 终端界面功能

- **一个 Agent，一个会话。** Agent 在进程内运行；每次调用绘制自己的对话记录并持有一个会话。
- **引导与中断。** turn 运行期间，Enter 提交的文本会在该 turn 的下一个 step 被消费，Esc 则中断该 turn 以及所有存活的 subagent 后代。
- **全屏对话记录。** PageUp/PageDown、鼠标滚轮与终端搜索可在不退出应用的情况下滚动对话记录；当视图滚离最新一行时，状态栏会给出提示。
- **计划模式。** Shift+Tab 切换会话 Agent 的计划模式。当 agent 完成规划后，它会以 markdown 形式在 Approve / Keep planning 选项之上展示该计划。
- **剪贴板图片。** Ctrl+V（Windows 与 WSL 为 Alt+V）把系统剪贴板中的图片附加到草稿，输入框会把每张持有的图片显示为 `[Image #1]` 标记。
- **审批与提问。** 审批提示提供 Allow once / Reject，`ask_user_question` 则渲染为选择器（当问题设置 `multiSelect` 时可勾选）或自由文本输入。
- **会话。** 退出时会打印一条 `dsh --resume <session-id>` 命令，`/sessions` 与 `/resume` 用于浏览和恢复已存储的对话。

## 键盘快捷键

| 按键 | 操作 |
|---|---|
| `Enter` | 提交提示，或引导运行中的 turn |
| `Esc` | 中断运行中的 turn 与会话的存活 subagent |
| `Shift+Tab` | 切换计划模式 |
| `Ctrl+V` | 把系统剪贴板中的图片附加到草稿（Windows 与 WSL 为 `Alt+V`） |
| `Ctrl+C` | 取消运行中的 turn 与存活 subagent；两者都不在运行时退出 |
| `Ctrl+D` | 退出 |
| `PageUp` / `PageDown` | 滚动对话记录，或滚动问题中溢出的详情 |
| `Up` / `Down` | 滚动问题中溢出的详情；否则移动其选择器 |
| `Left` / `Right` | 当问题的详情占用方向键时移动选择器的选中项 |
| `Space` | 在多选问题中勾选或取消勾选选项 |
| `Ctrl+L` | 从头重绘 |

## 命令

以已知 `/command` 开头的行会执行该命令，而不会发送给模型；其他斜杠文本会原样发送给 Agent。

| 命令 | 效果 |
|---|---|
| `/help` | 列出应用命令与所有已注册命令 |
| `/new` | 落盘并关闭当前会话，然后启动一个新会话 |
| `/sessions` | 按由新到旧列出已存储的会话 |
| `/resume [id]` | 按 id 恢复已存储的会话，或从选择器中挑选一个 |
| `/model [provider/model]` | 从实时目录中选择模型，或直接切换 |
| `/effort [id]` | 选择路由模型声明的推理强度，或直接切换 |
| `/questions` | 回答前台窗口已关闭的问题 |
| `/quit` | 退出 |

## 设置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `screen` | `'alternate'` | `'alternate'` 在备用屏幕中绘制，并使用应用自己的滚动窗口；`'inline'` 绘制到普通屏幕，把历史留给终端回滚缓冲。 |
| `colorScheme` | `'auto'` | `'auto'` 跟随终端导出的背景信号，否则保持深色；`'dark'` 与 `'light'` 固定调色板。 |

## 开发

终端界面位于 [`packages/bundle/tui-app`](packages/bundle/tui-app/README.zh.md)。请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)；面向 agent 请遵循 [AGENTS.md](AGENTS.md)。

## 参与贡献

参见 [CONTRIBUTING.zh.md](CONTRIBUTING.zh.md)。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
