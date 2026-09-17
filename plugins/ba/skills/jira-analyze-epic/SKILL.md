---
name: jira-analyze-epic
description: Analyze a Jira Epic key, create/update Stories with AC, write Architect handoff. Idempotent.
---

# Jira analyze epic

Use the public Praxis CLI. If unsure, `praxis ba --help`.

```
praxis ba preview --epic PRX-1 --repo . --json
```

Print the BA Jira write plan before any apply. Live writes only after human confirmation:

```
praxis ba apply --epic PRX-1 --repo . --confirm YES --json
```

Identity: `ba:{epicKey}:{logicalId}`. Never invent a second write path.
