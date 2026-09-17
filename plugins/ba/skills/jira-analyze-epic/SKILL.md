---
name: jira-analyze-epic
description: Analyze a Jira Epic key, create/update Stories with AC, write Architect handoff. Idempotent.
---

# Jira analyze epic

Use MCP tools, not a shell CLI.

Call `praxis_ba_preview`. Print the BA Jira write plan. STOP and wait for human approval.

Live writes only after confirmation:

`praxis_ba_apply` with `confirmation=YES` and matching `previewFingerprint`.

Identity: `ba:{epicKey}:{logicalId}`. Never invent a second write path. Do not immediately apply after preview.
