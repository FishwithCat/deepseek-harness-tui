---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-22-approval-grants

English | [中文](2026-10-22-approval-grants.zh.md)

## Summary

Adds a durable approval/grant event for a per-tool remembered approval and marks the audit decision it covers.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing logs contain neither the grant event nor the optional remembered field, so they remain valid and a grant-aware reader treats their absence as no grant. The new approval/grant event is a required first-party record: an older V4 reader refuses the session with a format-unsupported error instead of silently dropping a grant it cannot honor, so it cannot misinterpret later approval decisions. The optional remembered field is additive; a grant-aware reader preserves older decisions and reads an absent value as a one-shot decision. New readers preserve older logs and apply a grant only while the effective policy is ask; never still rejects first.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/interaction/user-approval/tests packages/bundle/tui-app/tests: 504 tests passed. pnpm run typecheck passed.

<a id="dev-note"></a>
## Dev Note

None.
