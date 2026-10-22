# Agent Note: TUI 应答存活后代的审批

Status: implemented

[English](2026-10-22-interactive-delegated-approvals.md) | 中文

## 问题

[归档的固定 `never` 决定](../../archived/feature/2026-08-10-subagent-approval-pinned-never.md)把审批提示从委派的进程内子代理中移除，因为没有界面在关注它们：子代理的升权在无人可见的提示上等待，或以 `unavailable` 失败关闭，而审计对只落在子代理自己的日志里。TUI 现在拥有运行中的终端应答器和本地子代理的只读查看器，因此它可以成为该决定所推迟的那个关注者。

## 决定

### 审批策略是委派设置，默认非交互

`dsh-subagent` 增加 `delegatedApproval`（`'never' | 'inherit'`，默认 `'never'`）。`captureDelegatedPolicyOverrides(parent, delegatedApproval)` 保留父级的显式沙箱覆盖，并向子级自己的日志写入一条带 `source: 'delegation'` 的 `approval/policy` 事件：`'never'` 固定为确定性拒绝，`'inherit'` 写入 `approval.effectivePolicy(parent.session)`。因此无论哪种设置，运行在 `never` 下的父级都会把 `never` 传给子级；只有交互式父级才会产生交互式子级。`dsh-tui-app/cordis.patch.yml` 设置 `inherit`，因此随附的终端 profile 选择加入，其他 profile 保持包的默认值和归档决定中的保证。

`ApprovalService.effectivePolicy(session)` 变为公开方法，因为委派所有者读取解析后的策略（含配置默认值），而不是重复该折叠。

### 子级的模型可见声明跟随其策略

`applyChildOverrides` 把 `subagent:delegation` 运行时上下文声明注册为读取子级生效策略的提供者。`never` 子级保留「需要审批的操作会被自动拒绝」的语句；`ask` 子级则被告知：某个操作可以向用户请求审批，用户可允许或拒绝；范围保持固定；拒绝是最终结果。由于当前没有写入路径能切换子级策略，该声明在子级生命周期内保持稳定。

### TUI 应答自己的 Agent 与存活后代

当提问的 Agent 是本应用自己的 Agent 或存活后代时，`installApprovalAnswerer` 认领该请求。它通过 `ctx.agents` 沿持久的 `parentSession` 头部向上遍历，因此无关根代理，或父级已不存活的子代理，仍会被委托并失败关闭。后代提示会标出子级的 `subagent/descriptor` 标签（没有标签时用短 id），使并发请求仍可归属；现有的提示队列将它们串行化。`Allow once` 仍是唯一的批准，跳过或取消仍解析为 `cancelled`。

用户提问接缝不变：委派子代理无法调用 `ask_user_question`，因为提问服务会以 `DELEGATED_CALLER` 拒绝非根调用者，所以终端应答器保持仅根 Agent 的提问范围。

### 审批审计变为可见

`TerminalTranscript` 把 `approval/asked` 与 `approval/decided` 折叠为一行持久的 `approval · <工具> — <结果>`，并在决定时原地替换。应用自己的转录显示其决定；只读 watch 查看器显示子代理的决定，因为它折叠的是子代理日志。这在没有新增投影或跨会话流的情况下弥补了固定决定所记录的审计缺口。

外部产品 provider 保留各自的非交互权限系统；[产品 provider 决定](../feature/2026-08-15-product-subagent-noninteractive-permissions.zh.md)不变。Auto review 记录中关于子级 `never` 的说明现在描述默认组合：`inherit` 下的 TUI 子级在审查者拒绝后回退到用户。

## 考虑过的替代方案

**所有组合都继承。** 拒绝：Web、headless、SDK 与 ACP 组合不应答后代请求，它们的子代理请求会把今天的确定性 `rejected` 变为 `unavailable`，并改变模型可见的拒绝文本，却没有增加关注者。

**由 TUI 切换已创建子级的策略。** 拒绝：委派边界拥有该种子，界面中的创建后写入会重复该所有者，并使重放依赖界面。

**不做血统检查，由根应答器应答所有子代理。** 拒绝：一个进程可能持有无关根代理，为外来 Agent 弹出提示会授予界面并不拥有的权限。

**只把审计留在子代理日志中。** 拒绝：终端模态框显示决定后不会留下痕迹，而查看器已经折叠其他所有持久行。

**通过发起委派的工具调用路由子代理请求。** 仍然推迟：它需要比单个界面更广的父链所有权与发起 `callId`；终端已经打印子代理标签，不需要它。

## 后果

- 当根会话处于交互式策略时，随附的 TUI 会为子代理升权弹出提示；无人值守部署恢复 `delegatedApproval: never`。
- 子级的策略、审计对与模型可见声明仍可从其自身日志重建。
- TUI 主转录新增根 Agent 自己决定的持久审批行；查看器新增子代理的审批行。
- 父链不再存活的子代理不会被 TUI 应答，保持失败关闭。
- profile 与包文档记录新的配置字段、两种声明与提示行为。

## 验证

- `dsh-subagent` 固定 `never` 默认值，并证明 `inherit` 写入 `approval/policy: ask`、调用应答器、允许一次升级写入并输出交互式声明。
- `dsh-tui-app` 证明嵌套后代的请求会打开带标签的提示并解析为 `allowed-once`，且无关根代理的请求解析为 `unavailable` 且不弹出提示。
- `TerminalTranscript` 把审计对折叠为一行并渲染最终结果；watch 查看器折叠存储的子代理审批对。
- `dsh-user-approval` 证明 `effectivePolicy` 报告配置默认值与最后一条覆盖。
