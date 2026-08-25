---
name: accept
description: Use once a plan-approved WP's development harness reports its validation is green — the sole human-gated path to baselining a WP's requirements, the only verb in this system that ever writes baselines/.
---

# Accept

`accept` is the single baseline writer — "there is no standalone `baseline` verb, only `accept` writes baselines." It is transactional, not authoring: the WP and its FR/NFR/BR closure already exist and are `batched`/`plan-approved`; this verb flips them to `baselined`, freezes their content into `baselines/BL-…/`, and resolves any CR whose full declared `impacts` set (amends and/or spawns entries) is now provably delivered — every `amends` entry's target carries a `## History` entry citing the CR, every `spawns` entry's `realized` target's `traces_to` includes the CR.

## Preconditions

- WP is `status: plan-approved` (`prepare-wp`/`approve-plan` already ran).
- The development harness's validation is green (whatever that harness defines — this skill only gates on the evidence JSON below; it never runs, or even needs to know, what that harness's own checks were).
- A VERIFY-EVIDENCE JSON exists (`{wpId, commit, testRunHashes, suites, producedAt, producedBy, toolVersion}`, typically `.ba/cache/verify-<wp-id>.json`) whose `commit` matches the current `HEAD` and whose `testRunHashes` are present — the honest, non-forgery-proof signal `acceptGate` checks; it does not re-run anything itself.

## Human gate

Accepting = baselining = the point of no easy return (a baselined item's content can only change again via `shape-requirement`'s Case B, a full CR-gated version bump). This is an explicit human-only action (CLAUDE.md: "Human-only actions: … accept …").

1. Summarize to the human what is about to be baselined: the WP, its FR/NFR/BR closure, the evidence file, and whether every `acceptGate` check (vision confirmed, AC-presence, plan-approved, evidence matches HEAD) is currently green.
2. **AskUserQuestion**: "Accept and baseline `<wp-id>` now?" — never infer a yes from a green evidence file alone; the human decision is the gate, the evidence file is only input to it.
3. On yes:
   ```
   praxis-ba accept --repo <canon-dir> --wp <id> --evidence <path-to-verify-evidence.json> --date <YYYYMMDD> --head-commit <sha>
   ```
   (`--date`/`--head-commit` are optional — omit to let the CLI default to today / `git rev-parse HEAD` under `--repo`.) Writes VERIFY-OK/VERIFY-FAIL, never a bare `PASS` — a FAIL here means the gate rejected the accept, not that anything was partially baselined (the transaction is crash-safe and idempotent via a write-ahead marker; a legitimate crash mid-transaction self-resumes on the next `accept` call for the same WP).

## Done when

`accept` returns `VERIFY-OK`, the WP is `status: accepted`, its delivered set is `baselined` under a new `baselines/BL-…/`, and a human explicitly triggered it — never a machine-initiated baseline.
