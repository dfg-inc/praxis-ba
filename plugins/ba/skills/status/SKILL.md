---
name: status
description: Use at any point to see where the product canon currently stands — vision confirmed or not, open/confirmed CRs, active vs. batched vs. baselined requirement counts, WP pipeline state, open bugs. Read-only — runs status/validate/render and summarizes; never mutates.
---

# Status

A deterministic read-only rollup — no agent judgment, no canon writes. Use it before starting any other skill (to see what already exists) and after one finishes (to confirm the write landed the way you expect).

## What happens

Three read-only CLI calls, nothing else:

```
praxis-ba status --repo <canon-dir>
praxis-ba validate --repo <canon-dir>
praxis-ba render --repo <canon-dir> --what rtm
```

- `praxis-ba status` — counts by status for epics/FRs/NFRs/BRs/CRs/WPs/bugs/goals, plus **structured missing items** (`missing:requirement-without-ac`, `missing:requirement-unverifiable-ac`, `missing:requirement-not-linked-to-wp`, `missing:requirement-without-goal`, `missing:goal-without-requirements`). Advisory exit 2 when any missing list is non-empty. It does **not** report vision confirmation on its own — read `<repo>/vision.md`'s frontmatter directly (`status: draft|confirmed`) alongside it.
- `praxis-ba goals status` (alias `check-goals`) — requirements without goals and goals with zero requirements.
- `praxis-ba validate` — schema validity, dangling refs, orphan FRs, duplicate AC ids, the id-max-guard, accept partial-state, orphaned pending markers. Add `--check` for the stronger frontmatter-round-trip + derived-view-idempotency guardrails.
- `praxis-ba render --what rtm` (or `--what prd` / `--what backlog`; `praxis-ba export` dispatches to the exact same verb under a second name) — the human-readable requirements-traceability matrix / PRD / backlog. Never writes a file itself — the rendered text rides in the check's own `reason` field; pipe it to a file yourself if you want a saved copy.

## What to surface

- Vision confirmed? If not, nothing downstream can reach `ready`/`baselined` — say so plainly.
- Any CR still `captured` (not yet `confirmed`) — a reminder, not a call to action; the human decides when to run `grill-cr`'s interview + confirmation gate.
- Any `draft` FR/NFR/BR that traces to a confirmed CR but was never activated (`shape-requirement`'s Case A step 5) — it can't be batched until it is.
- Any WP stuck at `ready` (definition-of-ready passed, no plan approved yet) or `plan-approved` (handed to development, not yet accepted).
- Any `validate` check that is `ok: false` — call it out as a real defect to fix, not something to wave through.

## Done when

The human has an accurate, current picture of the canon. No gates, no next step prescribed by default — what to do next is the human's call.
