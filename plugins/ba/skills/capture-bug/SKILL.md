---
name: capture-bug
description: Use when a client reports a bug against a shipped FR/NFR/BR — mints the bug directly from its template, recording repro/expected/actual and which requirement it violates. Dev-discovered mid-WP bugs live outside this canon, in the repo's own engineering docs, not here.
---

# Capture Bug

This canon is for CLIENT-REPORTED bugs only — a bug a developer finds mid-WP lives outside this canon, in the repo's own engineering docs, not here. Every bug id, canon or not, mints via `praxis-ba id next --scope bug` (one shared number line), so ids never collide across the two homes.

## What happens — authoring (HYBRID: direct Write, not `bug capture`)

1. `praxis-ba id next --scope bug --repo <canon-dir>` → mints and persists the next id (e.g. `BUG-004`); `counters.product.bug` advances immediately.
2. **Write** `<repo>/bugs/<id>.md` directly from `.claude/plugins/praxis-ba/templates/bug.md`: replace the sentinel `id`; set `affects: [<FR/NFR/BR id(s) this bug violates>]` (the typed ref this bug is against); `severity` (free text, no fixed enum — e.g. `low`/`medium`/`high`/`critical`); `reported` (the report date); `reporter` (who reported it); `status: open`. Body: **Repro** (exact steps from a known starting state), **Expected**, **Actual**.
3. `praxis-ba fmt <path> --repo <canon-dir>` then `praxis-ba validate --check --repo <canon-dir>`.

The retired `bug capture` verb MUST NOT be run — replaced by the `id next` + `Write` sequence above.

## Resolution (later, not this skill's job)

Once fixed or triaged, a bug is resolved via the transactional verb:
```
praxis-ba bug resolve --repo <canon-dir> --bug <id> --status fixed|wontfix|duplicate
```
Add `--spawn-cr` to mint a fresh CR (`status: captured`) and stamp this bug's `spawned_cr` in the same call — that new CR still needs its own `capture-cr` + `grill-cr` treatment before anything traces to it.

## Done when

The bug is on disk with `status: open`, a real `affects` target, and `praxis-ba validate --check` is green.
