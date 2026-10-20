---
name: local-workflow
description: Start or resume BA requirements from a local business request, markdown, or repository without Jira. Use when the user describes a business problem, asks for acceptance criteria, or no Jira issue exists. Ask only blocking questions, keep requirement ids stable, and hand off to Architect.
---

# Local BA workflow

Jira is optional. Do not require a Jira key.

## Shared Praxis Runtime

1. If `praxis_doctor` is not available: stop with `PRAXIS_RUNTIME_UNAVAILABLE`.
2. Call `praxis_doctor` and `praxis_workflow_status`.
3. If Jira is not configured, continue locally. Report `JIRA_CONFIG_UNAVAILABLE` only when the user asked for a Jira write.
4. Surface Runtime `code` and `errors`. Do not invent a generic runtime failure.

## Behavior

Inspect existing workflow state and project files before asking questions. Ask at most three blocking questions. Record assumptions for non-blocking gaps. Do not invent business policy.

Stable requirement ids look like `REQ-BUI-001`. Do not regenerate them on handoff.

Preview with `praxis_workflow_preview`, show the plan, and STOP. After explicit approval, call `praxis_workflow_apply` with `confirmation=YES` and the same `previewFingerprint`.

Commands are JSON:

- `open` for a new local work item
- `clarify` when information is missing. Put facts already present in the request or workflow in `known`. Do not ask those again.
- `record-decision` after the user confirms a business decision
- `add-requirement` for requirements and acceptance criteria that are not blocked
- `add-story` for a user story: stable `US-...` id, linked requirement ids, actor, narrative `As a [role], I want [capability], so that [business value].`, preconditions, happy path, alternatives, negative cases, edge cases, business rules, Given/When/Then acceptance criteria, expected results, dependencies, assumptions, and unresolved decisions. `confirmedBehavior` is true only after the user confirms the behavior.
- `handoff` with `sourceRole=ba` and `targetRole=architect` when requirements are ready. Story ids travel with the handoff.

`praxis_workflow_status` returns `guidance` for the current work item. Use that guidance while continuing the workflow. `praxis_capabilities` classifies installed guidance and suggestions; its `executed` list stays empty. This host does not automatically run a skill because a capability was suggested. Do not mutate Jira, Git, or releases from this skill.

## Inspect stored work

When the user asks what exists ("show requirements, Stories, architecture decisions, current work and Quality results"), call `praxis_workflow_inspect` (read-only; no Jira needed). Start with `view: "overview"`, then `requirements`, `stories`, `decisions`, `work`, `handoffs`, `open-items` or `quality`, or `all`. Pass `workItemId` when several Work Items exist, and `id` for one record. Report what it returns, including Story confirmation state: an unconfirmed Story stays unconfirmed. Do not ask the user to open files for anything Runtime can return.
