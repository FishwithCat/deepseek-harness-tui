# DeepSeek Harness TUI

[English](README.md) | 中文

本仓库是 DeepSeek Harness 的终端界面 fork。DeepSeek Harness 是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。裸 `dsh` 会在当前目录启动一个 Agent：一个会话、一个进程，没有浏览器服务器，也没有固定端口。该 Agent 使用的模型、工具、沙箱与审批默认值与其他界面完全一致，但以全屏终端应用呈现：可滚动的对话记录、位于固定页脚之上的输入框，以及报告工作区、上下文占用、路由模型、token 吞吐量、token 总量、缓存命中率与委派 subagent 数量的状态行。

运行本项目前，请阅读[安全说明](SAFETY.zh.md)。

<a id="quick-start"></a>

## 快速上手

需要 Node.js 22.19+ 或 24+、通过 Corepack 安装的 pnpm、Git、交互式终端，以及一个 DeepSeek API key。在新克隆的仓库上，一条命令完成安装依赖、完整构建，并把 `dsh` 链接到 `PATH`：

```sh
git clone https://github.com/FishwithCat/deepseek-harness-tui.git
cd deepseek-harness-tui
pnpm run setup:dsh
```

在启动环境中设置 API key —— PowerShell 中为 `$env:DEEPSEEK_API_KEY = "sk-..."` —— 然后在应作为工作区的目录中启动终端界面：

```sh
export DEEPSEEK_API_KEY=sk-...
dsh
```

已存放于 `$DSH_HOME/.credentials.yaml` 的密钥同样可用。输入提示并按 Enter；`/help` 列出命令，`/model` 切换路由模型，`Ctrl+D` 退出。退出时会打印一条 `dsh --resume <session-id>` 命令，供之后继续该对话。安装器的链接选项与构建要求见[安装与运行](#run)。

<a id="run"></a>

## 安装与运行

快速上手所用的 `pnpm run setup:dsh` 就是完整路径：它会构建原生系统插件与两个编译面，然后把 `apps/cli/lib/bin.js` 链接到 `$HOME/.local/bin`（Windows 为 `%APPDATA%\npm`），因此在任何目录都能运行 `dsh`。完整构建这一点很关键：缺少这些产物的 checkout 虽然能启动终端界面，却会在退出时卡在会话落盘。

安装器是幂等的：重新构建后再次运行 `pnpm run link:dsh`，或修复因仓库移动、`clean` 而断开的链接。`pnpm run link:dsh -- --dir <path>` 可安装到其他位置，`DSH_LINK_BIN_DIR` 设置目标目录，`pnpm run unlink:dsh` 删除本 checkout 安装的链接。属于其他程序的同名条目会被拒绝，而不是被覆盖。

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

`dsh` 打开终端界面；`dsh --profile tui` 显式指定该 profile。`--resume <session-id>` 继续已存储的会话，`--provider` / `--model` 为新会话选择路由模型。`--watch <session-id>` 打开本地 subagent 的只读查看器，且不能与会话参数组合。没有交互式终端时应用会拒绝启动，因此管道或重定向调用会明确报错，而不是等待无法读取的按键。

## 终端界面功能

- **一个 Agent，一个会话。** Agent 在进程内运行；每次调用绘制自己的对话记录并持有一个会话。
- **引导与中断。** turn 运行期间，Enter 提交的文本会在该 turn 的下一个 step 被消费，Esc 则中断该 turn 以及所有存活的 subagent 后代。委派的工作会超出该 turn 的生命周期，因此只要还有 subagent 仍在运行，页脚就会继续报告 `running`。
- **全屏对话记录。** PageUp/PageDown、鼠标滚轮与终端搜索可在不退出应用的情况下滚动对话记录；当视图滚离最新一行时，状态栏会给出提示。在备用屏幕模式下，选中文本后松开鼠标会自动复制。
- **计划模式。** Shift+Tab 切换会话 Agent 的计划模式。当 agent 完成规划后，它会以 markdown 形式在 Approve / Keep planning 选项之上展示该计划。
- **剪贴板图片。** Ctrl+V（Windows 与 WSL 为 Alt+V）把系统剪贴板中的图片附加到草稿，输入框会把每张持有的图片显示为 `[Image #1]` 标记。
- **审批。** 审批提示为应用自己的 Agent 及其存活 subagent 提供 Allow once / Always allow `<tool>` / Reject，subagent 的提示会标注该 subagent。Always allow 在会话上记录按工具区分的授权，之后对该工具的询问不再弹出提示，并在恢复会话后继续有效。
- **提问。** `ask_user_question` 渲染为选择器（当问题设置 `multiSelect` 时可勾选）或自由文本输入；`Other…` 打开自由文本答案，Esc 跳到下一题，Ctrl+C 取消整批提问。已结算的调用会报告所选标签，而不是原始结果 JSON。
- **委派 subagent。** 会话产生委派工作后，页脚显示 `● subagents (running/total)`。`/subagents` 打开一个固定的可滚动面板，列出所有委派 subagent（含 subagent 自身的下级 subagent）及其激活状态与 watch 命令；面板每次渲染都会重新读取实时会话，因此 subagent 会在面板打开期间加入或离开。
- **本地 shell 命令。** 以 `!` 开头的行在会话工作区中运行，使用与 Agent 的 `bash` 工具相同的沙箱策略，不弹出审批提示，也不发起模型请求。其命令与输出仅保留在本进程。参见[本地 shell 命令](#local-shell-commands)。
- **会话。** 退出时会打印一条 `dsh --resume <session-id>` 命令，`/sessions` 与 `/resume` 按标题浏览和恢复已存储的对话。
- **压缩。** 当压缩在 turn 生命周期之外运行时，页脚报告 `● compacting` 而不是 `idle`。

## 键盘快捷键

| 按键 | 操作 |
|---|---|
| `Enter` | 提交提示、引导运行中的 turn，或关闭 subagent 面板 |
| `Esc` | 中断运行中的 turn 与会话的存活 subagent；在提示中跳过当前问题；在 subagent 面板中关闭它 |
| `Shift+Tab` | 切换计划模式 |
| `Ctrl+V` | 把系统剪贴板中的图片附加到草稿（Windows 与 WSL 为 `Alt+V`） |
| `Ctrl+C` | 取消运行中的 turn 与存活 subagent，或停止本地 `!` 命令；在提示中取消整批提问；在 subagent 面板中关闭它；都不在运行时退出 |
| `Ctrl+D` | 退出 |
| `PageUp` / `PageDown` | 滚动对话记录、问题中溢出的详情，或 subagent 面板 |
| `Up` / `Down` | 滚动问题中溢出的详情或 subagent 面板；否则移动其选择器 |
| `Left` / `Right` | 当问题的详情占用方向键时移动选择器的选中项 |
| `Space` | 在多选问题中勾选或取消勾选选项 |
| `Ctrl+L` | 从头重绘 |

## 命令

以已知 `/command` 开头的行会执行该命令，而不会发送给模型；其他斜杠文本会原样发送给 Agent。`/compact`、`/goal` 与 `/plan` 等已注册命令会从命令注册表中发现，并针对实时 Agent 分发。

| 命令 | 效果 |
|---|---|
| `/help` | 列出应用命令与所有已注册命令 |
| `/new` | 落盘并关闭当前会话，然后启动一个新会话 |
| `/sessions` | 按标题与由新到旧列出已存储的会话 |
| `/subagents` | 打开一个固定的实时面板，列出委派 subagent 的激活状态与 watch 命令 |
| `/resume [id]` | 按 id 恢复已存储的会话，或从按标题标注已存储会话的选择器中挑选一个 |
| `/model [provider/model]` | 从实时目录中选择模型，或直接切换 |
| `/effort [id]` | 选择路由模型声明的推理强度，或直接切换 |
| `/questions` | 回答前台窗口已关闭的问题 |
| `/quit` | 退出 |

<a id="local-shell-commands"></a>

### 本地 shell 命令

以 `!` 开头的行在本地运行，而不会发送给 Agent：`!git status` 通过与 Agent 的 `bash` 工具相同的沙箱策略、以挂载的 shell 执行器运行，不弹出审批提示。每一行都在会话工作目录中启动全新的 shell，因此 `cd` 与导出的变量不会延续到下一行。命令请求 600 秒的上限，超出单流上限的输出会保留为尾部，并在行中给出 spill 文件路径。运行期间页脚显示 `● shell`。

该行仅存在于本地。其命令与输出不会进入会话日志，也不会发送给模型，并会在 `/new`、`/resume` 与退出时消失。`\!ls` 会把字面文本 `!ls` 发送给 Agent。同一时间只运行一条本地命令：运行期间会拒绝提示与新的 `!` 行，而在 turn 或压缩运行期间也会拒绝 `!` 行，并保留草稿。Ctrl+C 停止运行中的命令并保留其已产生的输出；斜杠命令始终可用。

## 查看 subagent

本地 subagent 启动时，TUI 会发布一个回环连接，并以普通通知的形式打印 watch 命令：

```
· watch: dsh watch <session-id>
```

在另一个终端中运行该命令即可跟随该 subagent。`dsh tui --watch <session-id>` 是等效的显式写法。查看器是只读的：没有输入框，不会发送提示、审批工具或取消 subagent。它显示已提交的对话记录，以及当前正在流式传输的文本、推理、工具调用与审批行；其页脚报告 subagent 的状态与连接状态 —— `online`、`history` 或 `disconnected` —— 以及上下文占用、吞吐量、token 与缓存命中率。PageUp/PageDown、鼠标滚轮、选择复制与调色板的行为与交互界面一致；Esc、Ctrl+C 与 Ctrl+D 只会离开查看器。

没有可用的实时服务时，查看器会打开已存储的日志并标记 `history`；它不获取写锁、不恢复 Agent，也不发起模型请求。只有由 TUI 启动的本地 subagent 可以被查看，查看器连接中断时会提示断开，而不会自动重连。两个终端必须使用同一用户、同一 `$DSH_HOME` 以及兼容的 TUI 持久化设置。

## 设置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `screen` | `'alternate'` | `'alternate'` 在备用屏幕中绘制，并使用应用自己的滚动窗口；`'inline'` 绘制到普通屏幕，把历史留给终端回滚缓冲。 |
| `colorScheme` | `'auto'` | `'auto'` 跟随终端导出的背景信号，否则保持深色；`'dark'` 与 `'light'` 固定调色板。 |

## 了解更多

- [包 README](packages/bundle/tui-app/README.zh.md) —— 实现、watch 协议与已知限制。
- [上游项目 README](README.upstream.md) —— 完整 harness、插件架构、Web UI 与 Desktop。
- [开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md) —— 贡献者安装与设计。
- [参与贡献](CONTRIBUTING.zh.md)、[MIT 许可证](LICENSE)与[第三方声明](THIRD_PARTY_NOTICES.md)。
