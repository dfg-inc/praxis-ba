---
name: ba-jira-status
description: Read-only BA/Jira status for an Epic (canonical stories, superseded, handoff).
---

# BA Status

Detect the workspace repo. Run:

```
praxis doctor --json
praxis ba status --epic <EPIC> --json
```

If the CLI cannot run: `LOCAL_RUNTIME_UNAVAILABLE`. Read-only. Do not apply. Do not start Architect.
