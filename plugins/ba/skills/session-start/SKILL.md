---
name: session-start
description: Use at the start of a BA session — runs the session bootstrap script (role ba, stage research) so project config and applicable knowledge rules are loaded before other skills.
---

# Session start

Load `.project` defaults, the applicable knowledge rules for role `ba`, stage `research` (override with `stage`; not for quality), and the Work Items of this repository. Does not mutate canon.

## What happens

1. Call the Runtime tool **`praxis_session_start`** with `role: "ba"` (and `repo` when it is not the current directory). It works in every host, including Claude Desktop Chat, where skills run in an isolated sandbox and cannot execute local scripts. It is read-only and starts nothing.
   - If `praxis_session_start` is not available, stop with `PRAXIS_RUNTIME_UNAVAILABLE`. Do not substitute a guess.
2. Show the human what it returned: Runtime version and build fingerprint, `.project` status (missing / loaded / invalid), knowledge rules loaded or why skipped, the Work Items with the current one marked, and `nextSteps`.
3. If `.project` is missing, surface the suggested path and continue with defaults only after the human acknowledges. If `knowledge.path` is unset, rules are **not applied**; do not invent a dataset path.
4. If several Work Items exist and none is selected, ask which one and pass `workItemId` from then on.
5. To show stored requirements, Stories, decisions, handoffs, open items or Quality evidence, call **`praxis_workflow_inspect`**. Do not ask the human to open files.

## Optional local script (CLI / Claude Code)

Where the host can run local commands, the plugin also ships a bootstrap script that prints the same facts:

```
node <plugin-dir>/tools/session-bootstrap.cjs [repo-root]
```

The packaged plugin ships the self-contained `.cjs`; a source checkout has `tools/session-bootstrap.mjs`, which needs `@praxis/plugin-sdk` built. The script is a convenience. The Runtime tool is the supported path.

## Done when

The human has seen the session summary. No writes.
