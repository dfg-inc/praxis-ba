---
name: ba-jira-status
description: Read-only BA/Jira status for an Epic (canonical stories, superseded, handoff).
---

# BA Status

Detect the workspace repo. Call MCP:

- `praxis_doctor`
- `praxis_ba_status` with `epic`

Read-only. No confirmation. Do not apply. Do not start Architect. If runtime/repo/Jira is missing, return the matching capability code.
