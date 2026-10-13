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
- `add-requirement` for requirements and acceptance criteria
- `handoff` with `sourceRole=ba` and `targetRole=architect` when requirements are ready

Call `praxis_capabilities` when the request needs security, architecture, or quality guidance. Guidance is not tool execution. Do not mutate Jira, Git, or releases from this skill.
