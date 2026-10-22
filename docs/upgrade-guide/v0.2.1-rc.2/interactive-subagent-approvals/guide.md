---
kind: upgrade-guide
description: "The TUI asks before a delegated subagent escalates, controlled by subagent.delegatedApproval."
---

# Delegated subagents can ask for approval

English | [中文](guide.zh.md)

## Change

The TUI answers approvals for its own Agent and live subagent descendants, and its profile sets `subagent.delegatedApproval: inherit`. An in-process child started under the interactive `ask` policy records that policy and pauses an approval-requiring operation on an Allow once / Reject prompt instead of being rejected automatically; the heading names the child's descriptor label. A parent under `never` (for example the Full access preset) still delegates `never`, and every other profile keeps the package default `never`.

## Migration

1. Expect a prompt when a delegated subagent escalates; the child's audit row also appears in `dsh watch <session-id>`.
2. If the TUI runs unattended, set `subagent.delegatedApproval: never` in the profile patch to restore deterministic rejection.
3. To let another surface answer child approvals, make its `approval/request` answerer cover descendants and set the same field to `inherit`; a child cannot switch its own policy.
