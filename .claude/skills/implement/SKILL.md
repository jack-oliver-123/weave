---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Read `docs/agents/openspec-workflow.md` before implementation. It is the sole authority for classification, implementation, review, verification, and delivery authorization.

## OpenSpec work

When the input is an OpenSpec change or a ticket mapped to an OpenSpec task, invoke `openspec-apply-change` for the selected change. Let it follow the project workflow through the completion boundary defined there.

## Other inputs

For every other input, follow the route selected by the project workflow. If that route requires planning first, return to its planning section instead of implementing directly.

## Completion boundary

Report the changed behavior and verification evidence, then stop at the workflow's completion boundary.
