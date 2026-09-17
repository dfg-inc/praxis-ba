---
name: resume-ba-work
description: Resume BA work on an Epic from remote Jira + local proposal. No duplicate stories.
---

# Resume BA Work

Same capability rules as Jira Epic Analysis: `praxis_doctor`, then stop with `LOCAL_RUNTIME_UNAVAILABLE` / `REPOSITORY_UNAVAILABLE` / `JIRA_CONFIG_UNAVAILABLE` when those apply. Never paste tokens into chat.

Call `praxis_jira_status` and `praxis_ba_preview`. If the plan is empty/UNCHANGED, report status and stop.

Apply only after human approval. Do not immediately apply after preview.

Then `praxis_ba_apply` with `confirmation=YES` and the matching `previewFingerprint`.
