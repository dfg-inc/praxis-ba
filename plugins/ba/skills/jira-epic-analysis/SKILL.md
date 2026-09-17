---
name: jira-epic-analysis
description: Analyze a Jira Epic, prepare BA stories and Architect handoff. Invoke when the user names an Epic (e.g. PRX-123).
---

# Jira Epic Analysis

Primary human UX is Claude UI / Cowork with project access. Do not tell the user to run CLI, Make, or Node.

## Capability detection

1. Resolve the workspace repository. If none, stop with `REPOSITORY_UNAVAILABLE`.
2. Call MCP `praxis_doctor` (read-only).
3. If local execution is not available: `LOCAL_RUNTIME_UNAVAILABLE`. Do not pretend Jira was read.
4. If Jira config is missing: `JIRA_CONFIG_UNAVAILABLE`. Never ask the user to paste a token into chat.
5. If `.project` is missing: call `praxis_project_init_preview`, show it, STOP, and only after approval call `praxis_project_init_apply` with `confirmation=YES`.

Claude Chat may show this Skill, but local development workflow depends on workspace/runtime capabilities.

## Flow

Call, in order:

- `praxis_doctor`
- `praxis_jira_status` / `praxis_ba_status` with `epic`
- `praxis_ba_preview` with `epic`

Show the BA write plan (CREATE / UPDATE / UNCHANGED / SUPERSEDED). Wait for explicit human approval. Do not call apply in the same autonomous sequence as preview.

Only after the human approves, call `praxis_ba_apply` with:

- `confirmation`: `YES`
- `previewFingerprint`: the exact value returned by preview

Do not write without confirmation and matching fingerprint. Ignore superseded duplicates except as audit (e.g. PRX-2). Do not start Architect.

User prompts (examples): «Возьми PRX-123 и подготовь требования для архитектора.» / “Take PRX-123 and prepare requirements for the architect.”
