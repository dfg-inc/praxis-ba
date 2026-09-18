---
name: ba-jira-status
description: Read-only BA/Jira status for an Epic (canonical stories, superseded, handoff).
---

# BA Status

## Shared Praxis Runtime

This Skill uses tools from the **Praxis Runtime** Desktop Extension.

1. If `praxis_doctor` is not available: stop with `PRAXIS_RUNTIME_UNAVAILABLE`. Tell the user to install or enable the Praxis Runtime Desktop Extension.
2. Call `praxis_doctor`.
3. If Jira is not configured: stop with `JIRA_CONFIG_UNAVAILABLE`. Open Claude Desktop → Settings → Extensions → Praxis Runtime → Settings. Never request the token in chat.
4. If `.project` is missing: `praxis_project_init_preview`, wait for approval, then `praxis_project_init_apply` with `confirmation=YES`.

Allowed tools: common/Jira/project + BA status. Do not apply. Do not start Architect.

Call MCP:

- `praxis_doctor`
- `praxis_ba_status` with `epic`

Read-only. No confirmation.
