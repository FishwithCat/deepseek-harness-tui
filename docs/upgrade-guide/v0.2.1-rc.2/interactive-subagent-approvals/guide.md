---
kind: upgrade-guide
description: "The TUI asks before a delegated subagent escalates, controlled by subagent.delegatedApproval."
---

# Delegated subagents can ask for approval

English | [中文](guide.zh.md)

## Change

The TUI answers approvals for its own Agent and live subagent descendants, and its profile sets `subagent.delegatedApproval: inherit`. An in-process child started under the interactive `ask` policy records that policy and pauses an approval-requiring operation on an Allow once / Always allow / Reject prompt instead of being rejected automatically; the heading names the child's descriptor label. Always allow records a per-tool grant on the root Agent, so later asks for that tool from the root or any live child settle without a prompt. The grant is a required Session event; a build that predates it refuses a session containing one instead of silently dropping the grant. A parent under `never` (for example the Full access preset) still delegates `never`, and every other profile keeps the package default `never`.

## Migration

1. Expect a prompt when a delegated subagent escalates; the child's audit row also appears in `dsh watch <session-id>`.
2. If the TUI runs unattended, set `subagent.delegatedApproval: never` in the profile patch to restore deterministic rejection.
3. To let another surface answer child approvals, make its `approval/request` answerer cover descendants and set the same field to `inherit`; a child cannot switch its own policy.
