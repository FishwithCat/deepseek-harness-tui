---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-22-approval-grants

[English](2026-10-22-approval-grants.md) | 中文

## 概述

新增持久化的 approval/grant 事件以记住按工具的批准，并标记它覆盖的审计决定。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-22-approval-grants
baseline: false
changes:
  - root: "event:approval/decided"
    previous: "2026-09-11-initial"
    after: "9e19c5180611b84c128c8820dc3a432fac4b5780fe1897e7557fc1b99334fa69"
    decision: same-version
  - root: "event:approval/grant"
    previous: null
    after: "1525755c8d2d6ad380c2f42cc5b203dc4fa8b1f96bbd3cd9a8c7a8b9ce986db4"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有日志既没有授权事件也没有可选的 remembered 字段，因此仍然有效，支持授权的读取方会把它们的缺失视为无授权。新的 approval/grant 事件是必需的第一方记录：旧的 V4 读取方会以「格式不受支持」错误拒绝该会话，而不是静默丢弃它无法兑现的授权，因此不会误读后续审批决定。可选的 remembered 字段是增量属性；支持授权的读取方会保留旧决定，并把缺失值视为一次性决定。新读取方保留旧日志，并且只在有效策略为 ask 时应用授权；never 仍优先拒绝。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/interaction/user-approval/tests packages/bundle/tui-app/tests：504 个测试通过。pnpm run typecheck 通过。

<a id="dev-note"></a>
## 开发备注

无。
