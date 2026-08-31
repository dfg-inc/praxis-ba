---
name: shape-requirement
description: Use once a CR's entry point is confirmed and its impact set names an FR, NFR, or BR — authors a brand-new draft requirement for a `spawns` impact, or amends an already-shaped one (active or baselined) for an `amends` impact, then realizes/records that impact entry against the CR. Never hand-edits a baselined page.
---

# Shape Requirement

`grill-cr` confirms a CR with a non-empty impact set — each entry either `spawns` a brand-new FR/NFR/BR under an epic, or `amends` one that already exists. This skill executes ONE impact entry at a time: decide which entry you're realizing, then follow the matching case below.

## Case A — a `spawns` impact (authoring: direct Write, not `req add`)

1. Decide the type (`fr`/`nfr`/`br`) and epic from the impact entry (`{spawns: <type>, epic: <E#>}`). An epic must already exist under `<repo>/epics/` — this skill does not mint epics (no `epic add`-equivalent authoring flow is in scope here).
2. `praxis-ba id next --scope fr:E1 --repo <canon-dir>` (or `nfr:E1` / `br:E1`) → mints and persists the next id (e.g. `E1-FR9`); the ledger advances immediately.
3. **Write** the page directly from the matching template (`.claude/plugins/praxis-ba/templates/fr.md` / `nfr.md` / `br.md`):
   - locate the epic's existing directory (list `<repo>/epics/` for the `E{n}` or `E{n}-*` match) for fr/nfr — write to `<that-dir>/<id>.md`; br is flat — write to `<repo>/br/<id>.md`.
   - replace the sentinel `id`/`epic`; set `traces_to: [<the confirmed CR id>]` (fr/nfr) so `definitionOfReady` can resolve it later; fill `enforces`/`references_nfr` (fr), or `verified_by` (nfr), or `kind`/`enforcement` (br) as known — when Rationale cites project NFR catalogue ids (`PXT-NFR-001`) or canon `E#-NFR#`, those ids must appear in `references_nfr` (the CLI also merges body mentions on `req edit`); set `goal_ids: [<G#>]` when a goal exists (skill `goals`); leave `status: draft`, `version: 1`.
   - fr body: the user story + a well-formed `## Acceptance Criteria` block (`- AC-N: given…, when…, then…` or `Дано… / Когда… / Тогда…`, ids unique within the page) + `## Rationale`. nfr body: the `## Planguage` block (Tag/Scale/Meter/Goal) + `## Rationale`. br body: one declarative sentence + `**Example:**` + `**Source:**`.
4. `praxis-ba fmt <path> --repo <canon-dir>` then `praxis-ba validate --check --repo <canon-dir>`.
5. When the human is satisfied with the drafted body, **activate** it — it is still `draft` at this point, not yet eligible for `wp prepare` (`definitionOfReady` hard-requires `status: active`):
   ```
   praxis-ba req edit --repo <canon-dir> --req <id> --body-file <body-only-or-full-page> --activate
   ```
   `--body-file` may be body-only **or** a full page; the CLI strips a leading frontmatter fence so a second YAML block is never written. No `--cr`/`--date` needed here — `--activate` is legal only when the current status is `draft`, and no version bump / `## History` applies to a pre-baseline item.
6. **Realize** the impact entry against the CR, so the CR's own record shows this spawn is fulfilled:
   ```
   praxis-ba cr realize --repo <canon-dir> --cr <cr-id> --spawn <E#>:<fr|nfr|br> --id <new-id>
   ```
   Stamps `realized: <new-id>` on the CR's first still-un-realized matching impact entry — validates that `<new-id>`'s `traces_to` already includes the CR (fr/nfr) before it will stamp.

The retired `req add` verb MUST NOT be run — replaced by the `id next` + `Write` sequence above.

## Case B — an `amends` impact (transactional only, NEVER a hand Write)

An already-shaped page — active OR baselined — already carries `version`/possibly `## History` machinery a hand `Write` would corrupt or silently skip. This is exactly why `req edit` stays a kept CLI verb at all, and v3 it works against BOTH an `active` item and a `baselined` one, not only the latter.

1. Identify the amending CR — the CR from whose confirmed impact set this `{amends: <id>}` entry comes (not necessarily a fresh "new" CR; the same CR `grill-cr` already confirmed this impact under).
2. Draft the full new body into a **scratch** file — never touch the canon page directly.
3. ```
   praxis-ba req edit --repo <canon-dir> --req <id> --cr <the-amending-cr-id> --body-file <scratch-file> --date <YYYYMMDD>
   ```
   The writer diffs old vs. new content (`shouldBump`): if it actually changed, `version` increments and the prior body is archived verbatim into a generated `## History` entry — a no-op body (no real content change) is rejected outright as an error, since a CR-driven edit that changes nothing can't be a real amendment. Do **not** pass `--activate` here — it is rejected on anything but a `draft` item.
4. `praxis-ba validate --check --repo <canon-dir>` to confirm the bump/History landed and the corpus is still schema-valid.

## Done when

The impact entry is realized: Case A leaves the new page `active` and the CR's matching `spawns` entry `realized`; Case B leaves the amended page with a bumped version + History entry. `praxis-ba validate --check` is green either way.

Once the whole batch of a CR's impact entries is shaped, run the `ba-lint` skill before `prepare-wp`: `validate` covers canon structure, but not the body semantics (a `[NEEDS CLARIFICATION]` marker left in an active requirement, a reference to an NFR id absent from the project catalogue, a tag outside the vocabulary) nor anything outside `canon/` — and `prepare-wp`'s link-integrity gate will fail on exactly those broken links.
