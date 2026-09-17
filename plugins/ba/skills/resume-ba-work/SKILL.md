---
name: resume-ba-work
description: Resume BA work on an Epic from remote Jira + local proposal. No duplicate stories.
---

# Resume BA Work

Same runtime rules as Jira Epic Analysis: detect repo, `praxis doctor --json`, stop with `LOCAL_RUNTIME_UNAVAILABLE` if the CLI cannot run. Use `praxis ba --help` if unsure.

```
praxis jira status --epic <EPIC> --json
praxis ba preview --epic <EPIC> --repo . --json
```

If the plan is empty/UNCHANGED, report status and stop. Apply only after human confirmation:

```
praxis ba apply --epic <EPIC> --repo . --confirm YES --json
```
