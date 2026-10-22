---
description: "Channel-neutral one-shot approval seam for users and maintainers composing answerers, setting policy, or debugging fail-closed permission decisions."
kind: "package-reference"
---

# @deepseek-ai/dsh-user-approval

English | [中文](README.zh.md)

## Summary

Use this package to require a decision before a sensitive tool action proceeds. The `ask` policy sends each request to the deployment's human or machine answerers; `never` rejects it without prompting. Missing or failed answerers return `unavailable`, so the action fails closed. A one-shot approval covers only its request; a remembered grant covers the same tool for the session and its live descendants. Every request and outcome is recorded in the requesting session's audit log. The model sees the resulting tool outcome and current policy, but not the human permission UI or audit events.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Compose this service when sensitive tool actions should pause for a human or machine decision instead of running unconditionally. The tools pipeline and the sandboxed bash tool route their `ask` decisions through this seam and fail closed when it is absent, so interactive deployments mount it with at least one answerer.

### Composing answerers

Answerers are `approval/request` waterfall listeners: return an outcome to answer for an owned agent, or call `next()` to delegate. Agent-scoped listeners receive only that agent's requests, and a deployment composes one terminal answerer — sibling listener order is not a policy-priority mechanism. Without a terminal answerer, requests resolve `unavailable` and fail closed; the service itself never prompts a human.

### Setting the policy

The effective policy is the one set for the session, falling back to the configured default. `ask` (the default) delegates to the composed answerers; `never` rejects every request deterministically before interactive dispatch — the strict headless stance for CI and unattended runs.

```yaml
- name: '@deepseek-ai/dsh-user-approval'
  config:
    policy: ask
```

| Field | Default | Meaning |
|---|---|---|
| `policy` | `ask` | Default for sessions without an `approval/policy` override |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-user-approval) is the exhaustive source for every accepted field and its JSDoc. `effectivePolicy(session)` reads the policy currently in force, including the configured default; delegation uses it to decide whether a child inherits an interactive policy. `setPolicy(agent, policy)` switches a live agent and queues a "changed by the user" message for its next model step; `setApprovalPolicy(session, policy)` is the direct durable write path used by session initialization.

### Remembering a tool

`grant(session, toolName)` appends one durable `approval/grant` for a tool, and `isGranted(agent, toolName)` checks the Agent's own session and each live ancestor through `parentSession`. Under `ask`, a granted ask resolves `allowed-once` without consulting an answerer and its `approval/decided` carries `remembered: true`; `never` still rejects first. The TUI records the grant on its own root Agent, so one Always allow choice covers the app and every live subagent, including one that asked.

### Requesting a decision

`request(req)` names the agent, tool, optional call id and reason, and an abort signal. Optional `displayReason` supplies localized presentation text without changing the logged reason. It requires an open turn: an idle or between-turn caller throws before auditing anything. Aborting withdraws the question — the request settles `cancelled` and a late answer is discarded. A failure that prevents either audit append from committing rejects instead of returning an unlogged decision.

### What the model and user see

The model sees only the asking consumer's eventual tool outcome — allowed, rejected, cancelled, or unavailable — plus the current policy in the runtime-context snapshot; the audit events, remembered grants, and the human permission UI are not model context. A `never` switch is announced to the model by a sourced user message, and both policies contribute their complete current meaning to the snapshot.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The observable behavior is covered in [Use this package](#use-this-package); this section explains dispatch, policy enforcement, and the audit path.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `ApprovalService`: request dispatch, policy fold and write path, remembered grants, runtime-context contribution |
| [`src/types.ts`](src/types.ts) | `ApprovalRequestId` brand and outcome types |

### Dispatch

`decide()` races the answerer waterfall against the request signal and contains every answerer failure: a throwing listener fails the question closed to `unavailable`, and a rogue non-vocabulary return is normalized to `unavailable`. The `never` policy is enforced inside the service before waterfall dispatch, so a listener registered later with `prepend` cannot bypass the deterministic rejection. A remembered grant is checked after `never` and before dispatch, so a covered ask never reaches an answerer. The request must be turn-enclosed because the audit pair is the durable log's commit/replay boundary — a bare event between turns is indistinguishable from a crash tail.

### Policy and the runtime-context snapshot

The system-prompt contribution `approval:policy` states the complete current meaning of the effective policy — `ask` with its fail-closed consequence, or `never` with its non-escalation consequence — after retained history, so switching policy appends a new full snapshot instead of rewriting the stable request header. `setPolicy()` also injects a sourced user message announcing the change for the next step.

### Audit

`request()` appends `approval/asked` with the request identity and tool, then `approval/decided` with the closed outcome; a decision covered by a remembered grant also carries `remembered: true`. `grant()` appends `approval/grant` once per tool. The exact appended fields live in [`src/index.ts`](src/index.ts). All are log-only.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the approval vocabulary to the consumers and the design rationale.

- [Approval subsystem reference](../../../docs/subsystems/approval.md) — the shared request/outcome vocabulary and the `ctx.approval` Cordis surface.
- [Approval seam Agent Note](../../../.agents/notes/implemented/feature/2026-07-06-approval-seam.md) — design rationale for the seam.
- [Remembered approval grants Agent Note](../../../.agents/notes/implemented/architecture/2026-10-22-remembered-approval-grants.md) — why grants are tool-scoped session state and how the TUI shares them with subagents.
- [Sandbox reference](../../shell/tool-bash/README.md) — how the sandboxed bash tool consumes approvals for escalated retries.
- [Interaction group map](../README.md) — adjacent permission preset and question packages.

-----

<a id="model-experience"></a>
## Model Experience

### Current approval policy context

#### What the model sees

The first request and each effective policy change append a full runtime-context snapshot after retained history. Under `ask`, the approval contribution states that configured answerers may be consulted and absence fails closed. Under `never`, it states the deterministic rejection and non-escalation consequence. Unchanged requests retain the earlier snapshot without adding another message.

##### Ask-policy contribution

```markdown
Approval policy: ask. Operations that require approval may ask through the configured answerers; without an available answerer, the request fails closed.
```

##### Never-policy contribution

```markdown
Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`).
```

#### Token effect

One concise context message on the first request and on an effective change; unchanged requests add no duplicate policy tokens.

#### KV Cache effect

Append-only after retained history. An `ask`/`never` switch preserves the stable system and conversation prefix instead of rewriting the first wire message.

### Tool outcome

#### What the model sees

`approval/asked` and `approval/decided` are log-only. The model sees only the asking consumer's eventual allowed, rejected, cancelled, or unavailable tool outcome; the human permission UI is not context.

#### Token effect

Zero duplicate audit tokens. A rejection may replace a normal tool result with a small retained error, while an allowance leaves the consumer's ordinary result.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the seam is a poor fit or needs special composition care. They are current package constraints, not a general permission comparison.

- **Requests are valid only inside an open turn** — an idle or between-turn caller throws before auditing; a durable out-of-turn approval workflow is deferred. Grants are standalone log entries and may be recorded outside a turn.
- **Grants are per tool name** — the request carries no arguments, so a grant covers every operation the tool gates; there is no per-command, per-path, or per-call grant.
- **Grants have no revocation control** — a grant lasts for the session and its live descendants; switching the policy to `never` suppresses every ask, but no API removes one grant.
- **The request carries no tool arguments** — an answerer sees the tool name, reason, and optional call id; the ACP machine channel requires a call id and delegates requests without one.
- **No built-in answerer** — headless or incompletely composed deployments resolve `unavailable` and fail closed; the service itself never prompts a human.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
