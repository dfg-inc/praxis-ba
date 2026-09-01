---
name: approve-plan
description: Use to record a human's plan-approval decision for a `ready` WP — the reusable human gate `prepare-wp` calls into once its definition-of-ready check is green and a plan exists at `wp/<id>/plan.md`.
---

# Approve Plan

This is the canonical form of the "approve WP → plan" human gate (CLAUDE.md: "Human-only actions: … approve plans …"). `prepare-wp` reaches this exact gate as its own last step — this skill exists standalone so the gate can also be re-run on its own, e.g. a plan revision, without re-running the whole prepare flow.

## Preconditions

- The target WP is `status: ready` (set by `praxis-ba wp prepare`) — `wp approve-plan` rejects anything else.
- A plan file exists on disk at exactly the canon-relative path `wp/<id>/plan.md` — the same folder the WP's own `wp/<id>/index.md` lives in — `wp approve-plan` rejects any other `--plan` path, or one that doesn't exist.

## What happens

1. Read the plan and summarize its shape to the human: what it delivers, the task breakdown, how it traces back to the WP's `## Scope` section.
2. **AskUserQuestion**: "Approve this plan (`wp/<id>/plan.md`) for `<wp-id>`, or does it need changes first?" — a human decision only; an agent never self-approves a plan (the same posture as `accept` — machines write VERIFY-OK/FAIL, never the approval itself).
3. On approval, run machine validation first (hard gate — do not skip; do not substitute manual review):
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/praxis-ba.cjs validate --repo <canon-dir>
   ```
   Non-zero exit / VERIFY-FAIL → stop; fix findings; do not approve.
4. Then:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/praxis-ba.cjs wp approve-plan --repo <canon-dir> --wp <id> --plan wp/<id>/plan.md
   ```
   This is the ONLY writer of `status: plan-approved` and the `plan:` frontmatter field.
   The CLI re-validates structurally and refuses approval if validation fails.
   **On success it also emits the machine BA → Architect handoff** at:

   `wp/<id>/handoffs/ba-architect.handoff.json`

   (`contract: "ba.architect.handoff"`). Do not hand-author this JSON — the CLI is the writer. JSON output includes `handoffPath`.
5. On "needs changes", loop back to a plan revision — do not call `wp approve-plan` until a subsequent AskUserQuestion actually confirms approval.

## Done when

The WP's frontmatter (`wp/<id>/index.md`) shows `status: plan-approved` and `plan: wp/<id>/plan.md`, a human explicitly said so, **and** `wp/<id>/handoffs/ba-architect.handoff.json` exists for Architect intake.
