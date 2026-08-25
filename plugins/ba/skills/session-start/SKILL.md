---
name: session-start
description: Use at the start of a BA session — runs the session bootstrap script (role ba, stage research) so project config and applicable knowledge rules are loaded before other skills.
---

# Session start

WBS 1.4 / 1.5 precursor: load `.project` defaults and the applicable knowledge slice for **role `ba`**, **stage `research`**, then print a short bootstrap summary. Does not mutate canon.

## What happens

1. From the product repo root (the directory that has or should have `.project`), run:
   ```
   node <plugin-dir>/tools/session-bootstrap.mjs [repo-root]
   ```
   Omit the argument to use the current working directory. Requires workspace packages built (`@praxis/plugin-sdk` and deps).
2. Read the printed lines: plugin version, `.project` status (missing / loaded / invalid), knowledge rules loaded or why skipped.
3. If `.project` is missing, surface the suggested path and continue with defaults only after the human acknowledges.
4. Proceed to `status` or the skill the human asked for.

## Done when

The human has seen the bootstrap summary for this session. No canon writes.
