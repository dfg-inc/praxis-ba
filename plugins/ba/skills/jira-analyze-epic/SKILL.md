---
name: jira-analyze-epic
description: Analyze a Jira Epic key, create/update Stories with AC, write Architect handoff. Idempotent.
---

# Jira analyze epic

Human provides Epic key (example `PRX-1`) and repo path.

```
node plugins/jira/tools/jira-workflow.mjs preview --epic PRX-1 --repo .
```

Live writes only after human confirmation. Do not destroy existing Jira text. Stop and ask if critical context is missing.

Idempotency uses `praxis.artifactId` issue property, never summary matching.
