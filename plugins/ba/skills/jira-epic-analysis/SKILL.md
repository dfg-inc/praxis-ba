---
name: jira-epic-analysis
description: Analyze a Jira Epic, prepare BA stories and Architect handoff. Invoke when the user names an Epic (e.g. PRX-123).
---

# Jira Epic Analysis

Primary human UX is Claude UI. The user should not need Make, Node scripts, or internal paths.

## Capability detection

1. Detect the workspace repository (`git rev-parse --show-toplevel`). If several repos exist, ask which one. If none, stop.
2. Run `${CLAUDE_PLUGIN_ROOT}/bin/praxis doctor --json` (or `praxis doctor --json` if on PATH).
3. If the command cannot execute: stop with `LOCAL_RUNTIME_UNAVAILABLE`. Do not pretend Jira was read or files changed.
4. If `.project` is missing: `praxis project init --infer --json`, show the preview, ask the human once, then `praxis project init --infer --confirm YES --json`.

If you are unsure which command exists, run `praxis ba --help` or `praxis ba preview --help` first. Never guess command names. Never inspect Praxis `.mjs` internals to discover the API.

## Flow

```
praxis doctor --json
praxis jira status --epic <EPIC> --json
praxis ba preview --epic <EPIC> --repo . --json
```

Show the BA write plan (UNCHANGED / UPDATE / CREATE / SUPERSEDED). Wait for human confirmation.

Then:

```
praxis ba apply --epic <EPIC> --repo . --confirm YES --json
```

Do not write without `--confirm YES`. Do not invent a second Story write path. Ignore superseded duplicates except as audit. Do not start Architect.

User prompts (examples): «Возьми PRX-123 и подготовь требования для архитектора.» / “Take PRX-123 and prepare requirements for the architect.”
