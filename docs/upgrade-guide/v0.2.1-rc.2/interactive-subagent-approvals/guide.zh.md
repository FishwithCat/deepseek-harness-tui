---
kind: upgrade-guide
description: "TUI 在委派子代理升权前询问用户，由 subagent.delegatedApproval 控制。"
---

# 委派子代理可以请求审批

[English](guide.md) | 中文

## 变更

TUI 会为本应用自己的 Agent 及存活的子代理后代应答审批，其 profile 设置 `subagent.delegatedApproval: inherit`。在交互式 `ask` 策略下启动的进程内子代理会记录该策略，需要审批的操作会暂停在「允许一次／拒绝」提示上，而不再被自动拒绝；提示标题会标出子代理的 descriptor 标签。运行在 `never` 下的父级（例如 Full access preset）仍向子级委派 `never`，其他 profile 保持包的默认值 `never`。

## 迁移

1. 委派子代理升级时需要处理提示；该子级的审计行也会出现在 `dsh watch <session-id>` 中。
2. 如果 TUI 以无人值守方式运行，在 profile patch 中设置 `subagent.delegatedApproval: never`，恢复确定性拒绝。
3. 若要让其他界面应答子代理审批，让它的 `approval/request` 应答器覆盖后代，并把同一字段设为 `inherit`；子代理不能自行切换策略。
