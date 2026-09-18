---
name: resume-ba-work
description: Resume BA work on an Epic from remote Jira + local proposal. No duplicate stories.
---

# Resume BA Work

## Shared Praxis Runtime

This Skill uses tools from the **Praxis Runtime** Desktop Extension.

1. If `praxis_doctor` is not available: stop with `PRAXIS_RUNTIME_UNAVAILABLE`. Tell the user to install or enable the Praxis Runtime Desktop Extension. Do not instruct them to run CLI or edit config files.
2. Call `praxis_doctor`.
3. If Jira is not configured: stop with `JIRA_CONFIG_UNAVAILABLE`. Open Claude Desktop → Settings → Extensions → Praxis Runtime → Settings. Never request the token in chat.
4. If `.project` is missing: `praxis_project_init_preview`, wait for approval, then `praxis_project_init_apply` with `confirmation=YES`.

Allowed tools: common/Jira/project + BA. Do not start Architect.

Call `praxis_jira_status` and `praxis_ba_preview`. If the plan is empty/UNCHANGED, report status and stop.

Apply only after human approval. Do not immediately apply after preview.

Then `praxis_ba_apply` with `confirmation=YES` and the matching `previewFingerprint`.
