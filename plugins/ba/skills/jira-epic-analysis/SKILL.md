---
name: jira-epic-analysis
description: Analyze a Jira Epic, prepare BA stories and Architect handoff. Invoke when the user names an Epic (e.g. PRX-123).
---

# Jira Epic Analysis

Primary human UX is Claude UI / Cowork with project access. Do not tell the user to run CLI, Make, Node, or `launchctl`.

## Shared Praxis Runtime

This Skill uses tools from the **Praxis Runtime** Desktop Extension.

1. If `praxis_doctor` is not available: stop with `PRAXIS_RUNTIME_UNAVAILABLE`. Tell the user to install or enable the Praxis Runtime Desktop Extension. Do not instruct them to run CLI or edit config files.
2. Call `praxis_doctor`.
3. If Jira is not configured: stop with `JIRA_CONFIG_UNAVAILABLE` and the `missing` field list. Tell the user: Open Claude Desktop → Settings → Extensions → Praxis Runtime → Settings and complete Jira configuration. Never request the token in chat.
4. If `.project` is missing: call `praxis_project_init_preview`, show inferred config, STOP, and only after approval call `praxis_project_init_apply` with `confirmation=YES`. Do not create `.project` silently.

Allowed tools: common/Jira/project + BA (`praxis_ba_status`, `praxis_ba_preview`, `praxis_ba_apply`). Do not call Architect, Developer, or Quality tools. Do not start Architect.

## Flow

Call, in order:

- `praxis_doctor`
- `praxis_jira_status` / `praxis_ba_status` with `epic`
- `praxis_ba_preview` with `epic`

Show the BA write plan (CREATE / UPDATE / UNCHANGED / SUPERSEDED). Wait for explicit human approval. Do not call apply in the same autonomous sequence as preview.

Only after the human approves, call `praxis_ba_apply` with:

- `confirmation`: `YES`
- `previewFingerprint`: the exact value returned by preview

Do not write without confirmation and matching fingerprint. Ignore superseded duplicates except as audit (e.g. PRX-2).

User prompts (examples): «Возьми PRX-123 и подготовь требования для архитектора.» / “Take PRX-123 and prepare requirements for the architect.”
