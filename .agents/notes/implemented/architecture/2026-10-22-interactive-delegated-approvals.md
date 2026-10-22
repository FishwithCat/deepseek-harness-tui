# Agent Note: The TUI answers live descendant approvals

Status: implemented

English | [中文](2026-10-22-interactive-delegated-approvals.zh.md)

## Problem

The [archived pin to `never`](../../archived/feature/2026-08-10-subagent-approval-pinned-never.md) removed approval prompts from delegated in-process children because no surface watched them: a child's escalation waited on a prompt no one saw, or failed closed as `unavailable`, and its audit pair landed only in the child's own log. The TUI now owns a live terminal answerer and a read-only viewer for local children, so it can be the watcher that decision deferred.

## Decision

### Approval policy is a delegation setting with a non-interactive default

`dsh-subagent` gains `delegatedApproval` (`'never' | 'inherit'`, default `'never'`). `captureDelegatedPolicyOverrides(parent, delegatedApproval)` keeps the parent's explicit sandbox override and seeds one `approval/policy` event on the child's own log with `source: 'delegation'`: `'never'` pins deterministic rejection, while `'inherit'` seeds `approval.effectivePolicy(parent.session)`. A parent under `never` therefore passes `never` to its children under either setting; only an interactive parent produces an interactive child. `dsh-tui-app/cordis.patch.yml` sets `inherit`, so the shipped terminal profile opts in while every other profile keeps the package default and the archived decision's guarantee.

`ApprovalService.effectivePolicy(session)` becomes public because the delegation owner reads the resolved policy, including the configured default, rather than duplicating that fold.

### The child's model-facing statement follows its policy

`applyChildOverrides` registers the `subagent:delegation` runtime-context statement as a provider that reads the child's effective policy. A `never` child keeps the sentence that approval-requiring operations are rejected automatically; an `ask` child is told that one operation may request approval from the user who can allow or reject it, that the scope stays fixed, and that a rejection is final. The statement stays stable for the child's lifetime because no current write path can switch a child's policy.

### The TUI answers its own Agent and live descendants

`installApprovalAnswerer` claims a request when the asking Agent is the app's own Agent or a live descendant. It walks the durable `parentSession` header through `ctx.agents`, so an unrelated root, or a child whose parent is no longer live, remains delegated and fails closed. A descendant prompt names the child's `subagent/descriptor` label (or a short id when it has none), so concurrent requests stay attributable; the existing prompt queue serializes them. `Allow once` remains the only grant, and a skipped or cancelled prompt still resolves `cancelled`.

The user-question seam is unchanged: a delegated child cannot ask `ask_user_question` because the question service rejects a non-root caller with `DELEGATED_CALLER`, so the terminal answerer keeps its root-only question scope.

### Approval audit becomes visible

`TerminalTranscript` folds `approval/asked` and `approval/decided` into one durable `approval · <tool> — <outcome>` row, replaced in place at the decision. The app's own transcript shows its decisions; the read-only watch viewer shows a child's because it folds that child's log. This closes the audit gap the pin recorded without adding a new projection or cross-session stream.

External product providers keep their own non-interactive permission systems; the [product-provider decision](../feature/2026-08-15-product-subagent-noninteractive-permissions.md) is unchanged. The Auto review note's child `never` statement now describes the default composition: a TUI child under `inherit` falls back to the user after a reviewer denial.

## Alternatives considered

**Inherit on every composition.** Rejected: Web, headless, SDK, and ACP compositions do not answer descendant requests, so their child asks would turn today's deterministic `rejected` into `unavailable` and change model-facing denial text without adding a watcher.

**Switch a created child's policy from the TUI.** Rejected: the delegation boundary owns the seed, and a post-creation write in the surface would duplicate that owner and leave replay dependent on the surface.

**Answer children from the root answerer without a lineage check.** Rejected: a process can hold unrelated roots, and a prompt for a foreign Agent would grant authority the surface does not own.

**Keep the audit in the child log only.** Rejected: the terminal modal would show the decision and then leave no trace, and the viewer already folds every other durable row.

**Route child asks through the spawning tool call.** Still deferred: it needs parent-chain ownership and the spawning `callId` more broadly than one surface, and the terminal already prints the child's label without it.

## Consequences

- The shipped TUI prompts for a child's escalation when its root is interactive; unattended deployments restore `delegatedApproval: never`.
- The child's policy, audit pair, and model-facing statement remain reconstructable from its own log.
- The TUI transcript gains durable approval rows for the root's own decisions; the viewer gains the child's.
- A child whose parent chain is not live is not answered by the TUI, preserving fail-closed behavior.
- The profile and package documentation record the new config field, the two statements, and the prompt behavior.

## Verification

- `dsh-subagent` pins the `never` default and proves `inherit` writes `approval/policy: ask`, consults an answerer, allows one escalated write, and emits the interactive statement.
- `dsh-tui-app` proves a nested descendant's request opens a label-bearing prompt and resolves `allowed-once`, and an unrelated root's request resolves `unavailable` without a prompt.
- `TerminalTranscript` folds the audit pair into one row and renders the final outcome; the watch viewer folds a stored child approval pair.
- `dsh-user-approval` proves `effectivePolicy` reports the configured default and the last override.
