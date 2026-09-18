---
name: jira-analyze-epic
description: Analyze a Jira Epic key, create/update Stories with AC, write Architect handoff. Idempotent.
---

# Jira analyze epic

## Shared Praxis Runtime

This Skill uses tools from the **Praxis Runtime** Desktop Extension.

1. If `praxis_doctor` is not available: stop with `PRAXIS_RUNTIME_UNAVAILABLE`. Tell the user to install or enable the Praxis Runtime Desktop Extension.
2. Call `praxis_doctor`.
3. If Jira is not configured: stop with `JIRA_CONFIG_UNAVAILABLE`. Open Claude Desktop → Settings → Extensions → Praxis Runtime → Settings. Never request the token in chat.

Allowed tools: common/Jira/project + BA. Do not start Architect.

Call `praxis_ba_preview`. Print the BA Jira write plan. STOP and wait for human approval.

Live writes only after confirmation:

`praxis_ba_apply` with `confirmation=YES` and matching `previewFingerprint`.

Identity: `ba:{epicKey}:{logicalId}`. Never invent a second write path. Do not immediately apply after preview.
