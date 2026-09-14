---
name: jira-analyze-epic
description: Analyze a Jira Epic key, create/update Stories with AC, write Architect handoff. Idempotent.
---

# Jira analyze epic

Human provides Epic key (example `PRX-1`) and repo path.

Use **only** `baAnalyzeEpic` / this skill for Story writes. Do not also run `create-story` or `confirm-write-package` in the same BA pass — that is a second write path and created PRX-2 + PRX-3 in alpha.22.

```
node plugins/jira/tools/jira-workflow.mjs preview --epic PRX-1 --repo .
```

Print the BA Jira write plan (UNCHANGED / UPDATE / CREATE / SUPERSEDED) before any apply.

Live writes only after human confirmation. Do not destroy existing Jira text. Stop and ask if critical context is missing.

Identity: `ba:{epicKey}:{logicalId}` (requirement id). Never UUID, timestamp, or summary-as-key.

Resume from `.praxis-jira/write-journal.json` if a previous create returned a key.
