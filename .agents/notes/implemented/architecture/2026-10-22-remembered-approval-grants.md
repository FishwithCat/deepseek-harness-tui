# Agent Note: Remembered per-tool approval grants

Status: implemented

English | [中文](2026-10-22-remembered-approval-grants.zh.md)

## Problem

[The TUI's delegated approval answerer](2026-10-22-interactive-delegated-approvals.md) offers one response per request. A session that repeatedly escalates the same tool therefore prompts on every call, and a subagent's ask prompts again even after its root approved the same tool. The approval seam had no durable way to remember a decision: its closed outcome vocabulary is one-shot, and a surface-local set would not replay, would not reach a child's audit, and would bypass the service's `never` policy.

## Decision

### A grant is durable session state

`ApprovalService.grant(session, toolName)` appends one `approval/grant` event. `isGranted(agent, toolName)` reads the Agent's own session and each live ancestor through `parentSession`; a vanished ancestor ends the walk. Re-granting the same tool in the same session appends nothing. The event is a required first-party record, so a build without grant support refuses a session that contains one rather than silently re-prompting. A grant may be recorded outside a turn because the event is standalone; `request()` keeps its own turn-enclosure requirement.

### Grants are checked inside the service

`request()` resolves a covered ask `allowed-once` after the `never` check and before answerer dispatch. `never` always wins, and a grant cannot make an answerer see an ask it is no longer entitled to. Covered decisions append the existing `approval/decided` event with `remembered: true`. The closed `ApprovalOutcome` vocabulary does not change, so tools, sandbox escalation, ACP, and their switches keep one grant value.

### The TUI records on its root Agent

`installApprovalAnswerer` adds `Always allow <tool>` beside Allow once and Reject. Choosing it calls `grant(owned.session, toolName)` and returns `allowed-once`; the grant therefore covers the whole app tree whether the prompt came from the root or a child. The label names the tool and the prompt description states the session-and-subagents scope. `TerminalTranscript` renders a `remembered` decision as `allowed always`, in the root transcript or the child watch viewer.

The model sees no new context: a grant changes which asks reach an answerer, not the asking consumer's allowed tool result. Grants have no revocation API or TUI control; switching the policy to `never` suppresses every ask.

## Alternatives considered

**Add `allowed-always` to `ApprovalOutcome`.** Rejected: the outcome is a closed wire vocabulary consumed by tool dispatch, sandbox escalation, ACP, and tests; a new value would force every switch to change, and old readers could not interpret the new audit value. `remembered` marks the existing allowed decision instead.

**Keep grants in a TUI-local set.** Rejected: a resumed session would lose the grant, the child watch viewer would show a grant it cannot explain, and requests outside the TUI would still prompt even though the session's answerer had already allowed the tool.

**Grant only the asking child.** Rejected: the requested behavior is that a root's Always allow reaches its subagents; recording on the app's root gives one policy for the whole tree and makes a child's selection equally explicit.

**Grant the exact tool call or arguments.** Rejected: `ApprovalRequest` deliberately carries no arguments, and duplicating the call's argument body into a second durable identity would make the grant drift from the already-logged tool call.

**Let any answerer grant by returning a new outcome.** Rejected: a machine answerer could then create durable state implicitly. The TUI calls `grant` explicitly, and the service evaluates stored grants before dispatch.

## Consequences

- A grant covers every operation its tool gates for the rest of the session and its live descendants; it is broader than one escalation target and has no revoke control.
- An older build refuses a session that contains the required `approval/grant` event; it does not silently drop the grant. A grant-aware build reads older logs without grants as having none and keeps their recorded one-shot decisions.
- Each covered ask still appends `approval/asked` and `approval/decided`, keeping the audit complete.
- The TUI's prompt now has three choices; `Always allow` is the only path that records durable state.

## Verification

- `dsh-user-approval` proves idempotent grants, the empty-name rejection, automatic `allowed-once` with `remembered`, `never` precedence, a grant recorded during an answer, a live descendant, multiple ancestors, and a missing parent or registry.
- `dsh-tui-app` proves Always allow from the root reaches a later root ask and a child, Always allow from a child reaches the root, and the transcript renders `allowed always`.
- The persistence record `2026-10-22-approval-grants` acknowledges the new event and optional decision field as same-version.
