# Agent Note: fork 的终端界面

Status: implemented

[English](2026-09-11-fork-terminal-surface.md) | 中文

## Problem

本 fork 需要一个可与其他终端编码代理相比的交互式终端界面：全屏对话记录、固定输入框、流式输出、工具行，以及在终端上应答 Agent 暂停等待的审批与提问。上游提供 `web`、`headless`、`sdk`、`sdk-minimal` 与 `acp`，因此终端用户只能驱动浏览器、跑一次性任务，或通过协议接入编辑器。

fork 还必须保持 rebase 成本低廉。任何改变现有界面组合方式的做法，或把启动器行为变成没有回退开关的 fork 专属行为，都会让此后每一次上游合并变成一个决策而不是一次冲突。

## Decision

**该界面是基于 `dsh-base` 的普通组合包。** `@deepseek-ai/dsh-tui-app` 不添加任何 host、HTTP 服务器、Web 运行时或浏览器行；它插入一个命令行 provider 与一个应用插件。`tui` profile 模板是 `['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-tui-app']`，patch 重载策略为 startup，与其他一旦启动就拥有工作的应用一致。`dsh-base` 本就因为「TUI 是单会话、进程级组合其 agent」而把面向模型的行保留在 host 平面，因此没有任何 base 行需要移动。profile 与组合包本身就是[profile 插件组合包决策](2026-08-05-profile-plugin-bundles.zh.md)给出的机制。

**应用在同一进程内驱动一个 Agent。** 它先等待组合完成，再通过 `ctx.agents` 创建或恢复 Agent，并订阅持久的 `session/event` 日志、实时的 `agent/assistant-stream` 流与 `agent/status`。没有第二个进程、没有线协议，也没有需要保持同步的客户端会话副本。

**终端库是参考 agent 所用库的维护中的同源后继。** `@earendil-works/pi-tui` 提供备用屏幕视口、滚动视图、输入框、markdown 渲染器、选择列表与鼠标处理。已弃用的 `@mariozechner/pi-tui` 是同一包在旧命名空间下的发布；仓库本就依赖 `@earendil-works/pi-ai`，因此 fork 停留在同一发布序列上。

**两种屏幕策略都随附，默认使用备用屏幕。** `TuiAltScreen` 让对话记录拥有自己的滚动窗口，同时状态栏与输入框保持固定；`TuiMainScreen` 绘制到普通屏幕，把历史留给终端自身的回滚缓冲。`Config.screen` 在通过校验后选择二者，`DSH_TUI_SCREEN` 提供 bundle 默认值。

**页脚位于输入框之下，并报告路由容量。** 本界面沿用参考 agent 的页脚顺序——对话记录、输入框，然后固定的页脚——使用户在输入时关注的事实以两行贴近屏幕底边：第一行是工作区与 Agent 状态，其右侧右对齐路由模型名及其推理档位；第二行是 token 计数与「下一次请求相对路由模型容量的占用」。快捷键提示是空输入框的 placeholder：用户在决定输入什么时仍然看得到它，同时页脚不必为它占一行。占用与容量取自 `ctx.tokenMeter` 投影，自动压缩策略取自 `ctx.compaction.autoCompactionEnabled`，因此界面呈现的是部署事实，而不必读取 provider 配置。

**应用只为本自己的 Agent 应答两个交互接缝。** `approval/request` 提供「允许一次／拒绝」并委托其他所有 Agent 的请求；被取消的提示解析为 `cancelled`，审批服务本就把它视为 fail-closed。`user-questions/request` 渲染问题声明的选项，未声明选项时渲染自由文本输入，并在用户取消时以 `ASK_ABORTED` 让提问的工具失败。委托而非独占，使同时挂载子 Agent 的组合仍然正确。

**裸 `dsh` 启动 fork 默认值，回退开关只有一个环境变量。** `dsh` 以 `options.profile ?? process.env.DSH_DEFAULT_PROFILE ?? 'tui'` 解析 profile。`DSH_DEFAULT_PROFILE=web` 选择浏览器默认值，空值则恢复上游「每次调用都必须指定 profile」的要求，因此偏向上游的部署无需打补丁即可恢复旧行为。

对上游的改动很少且是增量的：`PROFILE_TEMPLATES` 中的 `tui` 条目、根与 `apps/cli` 清单中的组合包依赖与三条脚本、`apps/cli/src/args.ts` 中的默认 profile 解析、项目引用与 `startup` 路径别名，以及终端库的发布年龄豁免——外加此前断言「必须提供 profile」错误的测试。其余全部位于新包内。

**本 fork 自带全局安装器。** `scripts/link-dsh.ts`（`pnpm run link:dsh`、`unlink:dsh`，以及供新克隆使用的 `setup:dsh`）把构建产物 `apps/cli/lib/bin.js` 链接到 `$HOME/.local/bin` 或 `%APPDATA%\npm`。registry 安装无法服务本 fork：`@deepseek-ai/dsh-tui-app` 未发布，且启动器的其他 `workspace:^` 依赖会解析到上游包，因此安装出的命令必须指向本 checkout 的构建产物。该安装器是幂等的，会修复因仓库移动或 `clean` 而断开的链接，并拒绝属于其他程序的同名条目。`setup:dsh` 运行的是完整构建（`pnpm run build`）而不是仅库构建：原生系统插件与 client 编译面都是本界面能够完成会话落盘并退出的前提。

## 上游移除后的重新引入

上游在 [TUI 包移除决策](../../archived/simplification/2026-08-04-remove-tui-package.md)中删除了它自己的终端界面，并写明任何重新引入都欠下的东西：「一个具名的产品或将部署、一个显式的包边界、一个具体的交互 provider，以及针对该界面的组装式生命周期与记录验收」。本 fork 就是那个部署，而每个条件都是通过构造满足的，而不是通过继承被删除的包。

具名部署是本 fork 的默认 `dsh` 调用，这也是该界面以 profile 而非可复用 UI 包形式交付的原因：组合本身就是产品需求。包边界是 `packages/bundle/tui-app`，一个只导出其插件、命令行 provider 与 patch 文件的组合包。具体的交互 provider 是应用注册的两个应答者，每个 Agent 暂停的接缝一个。组装式验收就是 profile 启动本身：包测试通过替换 `Terminal` 驱动输入路由、渲染、模态应答与退出，启动测试在真实 Loader 树上解析参数族，而一次伪终端运行 `dsh --profile tui` 会渲染对话记录并干净退出。

没有任何东西继承自被删除的实现。它连同被打补丁的 `pi-tui` 制品一起被删除；本界面改为依赖维护中的已发布库，因此该补丁及其 vendored 制品不会回归。

## Alternatives considered

**通过 SDK JSON-RPC 服务器接入的 TUI 客户端。** `dsh --profile sdk` 已经提供有文档的协议，因此终端客户端可以接入它。它落败是因为它为本界面并不需要的能力倍增了失败面：两个进程、一条传输，以及一个必须与持久日志保持一致的客户端会话副本，而应用本可直接读取该日志。对于确实需要进程外能力的客户端，它仍然可用。

**作为 Web Host API 客户端的终端界面。** 复用 `ctx.sessionController`、gateway 与投影面能复用最多逻辑。它落败是因为它把一个界面并不需要的 Host/HTTP/浏览器组装拖了进来，而该栈的客户端半边仅支持 `platform: "web"`，因此终端仍需在最大的依赖之上从零构建渲染器。

**复用 React 客户端包（`packages/client/*`）。** chat、tool 与 session 状态包已经解决了展示与状态问题。它们落败是因为每一个都通过仅限 Web 的客户端模块平台渲染 DOM；终端可以复用其 store，却无法复用其组件，最终留下两套展示栈并存的混合架构。

**手写 ANSI 渲染。** 一个小渲染器可以让依赖闭包保持为空。它落败是因为现有库已经删除了带历史与 kill-ring 支持的输入框、markdown 渲染、滚动视图、备用屏幕视口、鼠标选择与差分渲染器——否则这些都会成为自有代码及其测试。

**恢复已删除的 `packages/ui/tui` 实现。** 它的渲染器、卡片与适配器都是针对本代码库编写的。它落败于移除决策已经点名的两点：它是为已不存在的 `dsh` 调用形态（显式 config 入口，而非 profile）构建的，并且它带有一个仓库必须重新拥有的 `pi-tui` 补丁制品。移除决策自身的结论正是这里遵循的规则——终端前端应从其真实的 host 与交互需求出发，而不是默认继承旧实现。

**原地修改上游默认值且不提供覆盖开关。** 无条件把 `tui` 设为默认值是更小的 diff。它落败是因为无法复现上游契约的 fork 也就无法对它做二分定位；一个环境变量以一条表达式为代价保留了这种能力。

## Consequences

fork 获得了交互式终端界面，同时没有改变任何现有 profile 的组合方式，而上游 rebase 只需要处理本 Agent Note 点名的三个小 hunk。该界面可以在没有终端的情况下测试：应用从 `internals` 获取其 `Terminal`，而对话折叠相对 I/O 是纯的，因此输入路由与模态应答都能针对替换的终端运行。

代价是一个新的运行时依赖及其闭包，第三方声明现已披露它；初始 profile 启动比 headless 更重，因为交互界面保持完整的 base 组合（会话标题、目标、命令与投影注册表）挂载。

边界是刻意为之并记录在包 README 中的：每次调用一个 Agent、唯一附件是剪贴板图片的输入框（[TUI 剪贴板图片粘贴](../feature/2026-09-11-tui-clipboard-image-paste.zh.md)）、工具输出折叠、注入上下文只以生产者声明的通知呈现、`multiSelect` 问题每次提示一个选项，以及所有界面共有的、由启动器拥有的退出。

有一个覆盖缺口是被点名而非被关闭的：无密钥快照框架通过 stdio 驱动随附 profile，因此无法录制本界面的终端输出。它的验收是包测试加一次伪终端运行，而终端布局的回归需要扩展这些测试，而不是重新录制快照。
