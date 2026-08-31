---
name: prepare-wp
description: Use once a CR's impact set is realized and the FR/NFR/BR slice it produced is ready to hand off — authors the WP folder (`wp/<id>/index.md`) directly from its template with a `## Scope` section naming that slice, runs the definition-of-ready + link-integrity gate, then gates the plan approval through a human decision before handing the folder off.
---

# Prepare WP

A WP is a folder (`wp/<id>/index.md` — the same shape epics already use), never the plan itself. Its `## Scope` section (scopelinks.ts's `parseScope` grammar) is the machine-readable input — a `### Change requests` / `### Delivers` / `### Constraints` set of full-path links, not a frontmatter id list.

## What happens — authoring (HYBRID: direct Write, not `wp author`)

`praxis-ba` is this plugin's CLI at `bin/praxis-ba.cjs`. Every `praxis-ba <verb>` below is shorthand for:

```
node ${CLAUDE_PLUGIN_ROOT}/bin/praxis-ba.cjs <verb> …
```

1. `praxis-ba id next --scope wp --date <YYYYMMDD> --repo <canon-dir>` → mints and persists the next id (e.g. `WP-20260715-004`); `counters.product.wp` advances immediately.
2. **Write** `<repo>/wp/<id>/index.md` directly from `.claude/plugins/praxis-ba/templates/wp.md`: replace the sentinel `id`; `role: developer|qa`; `status: draft`; a short goal/intent body, not the full plan; then the `## Scope` section:
   - `### Change requests` — required in practice: the confirmed CR(s) this WP delivers against. The gate below hard-requires every Delivers FR's `traces_to` to include at least one CR from THIS list (an FR tracing only to some CR the WP doesn't scope fails), and every CR listed here to be `confirmed`.
   - `### Delivers` — the real FR ids this WP delivers (every one must already be `status: active` — run `shape-requirement`'s activation step first if any is still `draft`).
   - `### Constraints` — optional: NFR/BR links this WP touches without a Delivers FR already carrying them.

   Every Scope link path must be **relative to the WP file** (e.g. `../../epics/E1-x/E1-FR1.md#acceptance-criteria`, `../../cr/CR-001.md`) — never a `canon/` or `link_root/` prefix that duplicates from `wp/<id>/`. A version suffix (`E1-FR1 v2`) is required whenever the target is `baselined`.
3. `praxis-ba fmt <path> --repo <canon-dir>` then `praxis-ba validate --check --repo <canon-dir>`.

The retired `wp author` verb MUST NOT be run — replaced by the `id next` + `Write` sequence above.

## The definition-of-ready gate

```
node ${CLAUDE_PLUGIN_ROOT}/bin/praxis-ba.cjs wp prepare --repo <canon-dir> --wp <id>
```

Blocks unless every check passes:

- vision `confirmed`;
- every Delivers FR is `active` and has ≥1 well-formed AC;
- **every Delivers FR's `traces_to` intersects the WP's own `### Change requests` list** (`frs-trace-to-scoped-cr` — tracing to a confirmed CR somewhere else in the corpus is NOT enough; the WP must scope the CR it delivers against);
- **every `### Change requests` CR is itself `confirmed`** (`wp-scope-crs-confirmed`);
- every `enforces` BR resolves and isn't `retired`; every `references_nfr` NFR resolves, is `active`, and itself traces to a confirmed CR (the NFR→CR edge keeps the any-confirmed-CR form — it is not re-scoped to the WP);
- no dangling ref in the closure;
- link integrity: every `## Scope` link parses, resolves, and is a **file-relative** path from `wp/<id>/index.md` to the target (e.g. `../../epics/...`), any `#anchor` names a real heading on the target page, and any ` vN` version stamp matches the target's CURRENT version (CR refs never carry version stamps).

On green it flips every `draft`/`active` closure member to `batched` and sets this WP's `status: ready` — the ready WP page itself is the handoff artifact; nothing else is generated. It does not partially apply on failure — fix the flagged FR/NFR/BR/CR state or Scope link and re-run.

If the WP needs to be scrapped after this point (before `accept`):
```
praxis-ba wp abandon --repo <canon-dir> --wp <id>
```
reverts every `batched` member back to `active` and sets this WP `abandoned` — the escape hatch, not part of the normal flow.

## Human gate — plan approval

Approving a WP's implementation plan is a human-only action (CLAUDE.md: "Human-only actions: … approve plans …") — this is the SAME gate the `approve-plan` skill owns as its reusable form; follow it here directly (or invoke that skill) rather than skipping straight to the CLI call:

1. **AskUserQuestion**: "Approve this plan (`wp/<id>/plan.md`) for `<wp-id>`?" — never proceed on silence or an implicit assumption.
2. On approval:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/bin/praxis-ba.cjs wp approve-plan --repo <canon-dir> --wp <id> --plan wp/<id>/plan.md
   ```
   Requires the WP to be `status: ready` (set by `wp prepare` above) and the plan to exist on disk at exactly that canon-relative path — `--plan` is rejected if it points anywhere else. `wp approve-plan` re-runs `validate` and refuses `plan-approved` on VERIFY-FAIL (never soft-downgrade to manual PASS). Sets `status: plan-approved`, stamps `plan: wp/<id>/plan.md`.

## Done when

Once green and plan-approved, the WP folder is the complete input for whatever development harness the repo uses; development is governed by the repo's own process docs (CLAUDE.md here), not by this canon. The closure members are `batched`, and a human explicitly approved the plan (never inferred). `accept` is the next BA-side gate once that harness reports its work is done.
