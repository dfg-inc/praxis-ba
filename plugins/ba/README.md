# praxis-ba (v3 — canon-graph)

The ADLC **Business Analyst** plugin: author and govern a **md-first, git-native requirements canon** with skills + a self-contained validator/CLI. v3 adds impact-traced CRs (a single confirm gate after a relentless `grill-cr` interview), folder-shaped WPs, and a **dev-harness-agnostic** posture — this plugin prepares INPUT for development only; it names no specific downstream dev workflow, tool, or vendor.

## What's new in 0.4.0 — the layer around the canon

Until now the plugin covered `canon/` and nothing else. But a BA does not work in
`canon/` alone: the sources live next to it (client documents, the NFR catalogue, the
role model, the tag vocabulary, meeting notes, diagrams), and the engine neither
writes that layer nor sees it. Two gaps followed from that, and both are closed here.

**A step that had no owner: how many requirements this CR becomes.** Between the
interview and authoring, nobody decided where the boundaries between requirements ran
— so the number of requirements was whatever the interview happened to produce, and
glued-together stories reached the canon already carrying ids. That is expensive:
a requirement lives in exactly one work package, and acceptance runs per whole
requirement, so one disputed criterion blocks everything glued to it. `grill-cr` now
derives its impact set through a slice-planning gate (`ba-plan-slice`), which shows a
human the plan — one story per `fr`, rules and NFRs separated, a source for every line
— and hands back the very `--impacts-file` the confirm gate applies.

**Checks that stopped at the canon border.** `validate` proves structure: schema, graph,
ids, statuses. It says nothing about whether a requirement still carries a
`[NEEDS CLARIFICATION]` marker into development, references an NFR id that does not
exist in the project catalogue, or links to a file somebody has moved. `shape-requirement`
now ends by running those checks (`ba-lint`) before a work package is prepared —
`prepare-wp`'s own link-integrity gate fails on exactly the links they find.

Alongside that, five skills and ten templates for the layer itself: laying it out on a
new project (`ba-scaffold`), and reversing it out of an existing codebase when the code
came first and the requirements never got written down (`ba-onboard`,
`ba-code-surface-scan`).

Everything new stays outside `canon/`: canon pages are still authored only by the canon
skills, and the engine's write path is untouched. The only new dependency is `python3`,
used by `tools/lint.py`.

## Installing this plugin (consumers)

This repo is **both** the marketplace and the plugin it distributes. To consume it in a host repo, declare the git marketplace and enable the plugin in that repo's `.claude/settings.local.json`, pinned to a released tag (`ref`) so the harness resolves a **specific version**:

```json
{
  "extraKnownMarketplaces": {
    "praxis-ba": {
      "source": {
        "source": "url",
        "url": "git@gl.jetru.by:engineering/ai-tooling/praxis-ba.git",
        "ref": "v1.0"
      }
    }
  },
  "enabledPlugins": {
    "praxis-ba@praxis-ba": true
  }
}
```

- `extraKnownMarketplaces.<name>.source.ref` pins the marketplace fetch to a git ref — a tag (`v1.0`), branch, or commit. Bump this to move to a new release.
- `enabledPlugins` uses the `<plugin>@<marketplace>` convention — here both are `praxis-ba`.
- Put this in `.claude/settings.json` (committed) to share the pin with the whole team, or `.claude/settings.local.json` (git-ignored) for a personal/per-machine override.

Verify with `/plugin marketplace list` (shows `praxis-ba` at `v1.0`) and `/plugin list` (shows `praxis-ba@praxis-ba` enabled).

## What's here

- **`skills/`** — 9 canon skills: `confirm-vision`, `capture-cr`, `grill-cr`, `shape-requirement`, `prepare-wp`, `approve-plan`, `accept`, `capture-bug`, `status`. They author md canon pages **directly** from `templates/`, then gate through the CLI. `grill-cr` is new in v3 — it sits between `capture-cr` (capture only, client's words verbatim) and `shape-requirement`, and now owns the CR entry-point + impact-set human gate end-to-end.
- **`skills/ba-*`** — 5 skills for the **project layer around the canon**, the part the engine neither writes nor sees: `ba-scaffold` (lays out `inputs/`, `shared/`, `diagrams/`, `meetings/`, `tasks/`, `archive/` from `templates/layer/`), `ba-onboard` + `ba-code-surface-scan` (reverse project context out of an existing codebase when there are no BA artefacts yet), `ba-plan-slice` (the slice-planning gate `grill-cr` calls before its confirmation gate — turns scope into one-story-per-`fr` slices and produces the `--impacts-file`), `ba-lint` (semantic body checks + the layer outside `canon/`). They never write inside `canon/` — canon pages are authored only by the skills above.
- **`templates/`** — the 8 canon page skeletons (vision, fr, nfr, br, cr, wp, bug, epic-index).
- **`templates/layer/`** — 10 skeletons for the project layer (project, glossary, stakeholders, rbac, data-model, integrations, nfr-catalog, as-is, taxonomy, inputs-readme). Filename = target filename, except `inputs-readme.md` → `inputs/README.md` and `nfr-catalog.md` → `shared/nfr.md`.
- **`tools/lint.py`** — the 5 semantic body checks `validate` does not cover: a `[NEEDS CLARIFICATION]` marker left in an active requirement, a reference to an NFR id absent from the project catalogue, a tag outside the vocabulary, a child ahead of its parent, a broken relative link. **Requires `python3`** (the only non-bundled dependency in this plugin). Run with `--no-structural` whenever the CLI is present — without the flag it re-runs checks the engine already owns.
- **`bin/praxis-ba.cjs`** — the **self-contained CLI** (`@praxis-ba/canon-graph` bundled into one file; no build, no `node_modules`, no `npm install`). Run: `node <plugin-dir>/bin/praxis-ba.cjs <verb> --repo <canon-dir>`.

## The v3 model in brief

- **CR flow:** capture (`capture-cr`, client's words verbatim, no product judgment yet) → grill (`grill-cr`, a product-only interview, one question at a time with a recommended answer) → **one human gate**: `praxis-ba cr confirm --entry vision|requirement --impacts-file <path>` — confirms both the entry point AND the full impact set (an array of `{amends: <FR/NFR/BR id>}` and/or `{spawns: fr|nfr|br, epic: <E#>}` entries) in a single transactional write.
- **Shaping executes the confirmed impact set** (`shape-requirement`), one entry at a time:
  - a `spawns` entry is realized via `praxis-ba cr realize --cr <id> --spawn <E#>:<fr|nfr|br> --id <new-id>` — mints the new requirement and stamps the CR's own record of what it spawned;
  - an `amends` entry is realized via `praxis-ba req edit --req <id> --body-file <path> --cr <cr-id> [--activate]` — this **bumps the target's `version`** and prepends a `### v{N} — {date} — {cr-id}` entry under `## History` (the prior body archived verbatim underneath, heading levels demoted so nested History from an earlier bump never collides). A confirmed `--cr` is required for every bump now — v3 makes the CR citation universal, not just for baselined items.
- **CRs auto-resolve on full delivery** — during `accept`, a CR with a non-empty `impacts` set resolves once every entry is provably delivered (each `amends` target `baselined` with a `## History` citation back to this CR; each `spawns` target `realized` and itself `baselined`, with `traces_to` citing this CR back). No manual "close the CR" step.
- **WP = a folder**, not a flat file: `wp/<id>/index.md` (frontmatter + goal) **co-located** with `wp/<id>/plan.md` (the approved plan). A WP carries no FR/NFR/BR scope in frontmatter at all — it lives entirely in the `## Scope` section (`### Change requests` / `### Delivers` / `### Constraints`), plain markdown links (`- [<id>[ vN]](<path>[#anchor])`) that are the **machine-readable refs** `wp prepare`'s link-integrity gate reads and `wp approve-plan`/`accept` re-check. `plan.md` is a canon **attachment**, not a discoverable canon node — excluded from canon-wide scans (see `.ba/config.yaml` below) so it never gets treated as an untyped page.
- **Dev-harness-agnostic (permanent):** nothing in this plugin's skills or templates may name a specific downstream development harness, workflow-plugin convention, dev-loop file layout, or model vendor. A plan-approved WP folder is the complete handoff — what happens after that is entirely the host repo's own process, described in the host repo's own docs (e.g. its `CLAUDE.md`), never here.

## The canon

A canon root is a directory holding `.ba/{config,counters}.yaml`, `vision.md`, `epics/E#-*/`, `br/`, `cr/`, `wp/`, `bugs/`, `baselines/BL-*/`. Requirements are markdown (machine frontmatter + human body); traceability is typed frontmatter refs (`traces_to` / `enforces` / `references_nfr` / `fr_ids`); registers + backlinks + RTM are generated views (e.g. VitePress data loaders in a host repo's own docs site).

`.ba/config.yaml` declares what counts as canon and how `## Scope` links resolve:

```yaml
canon_roots:
  - vision.md
  - epics/
  - br/
  - cr/
  - wp/
  - bugs/
link_root: product
```

`canon_roots` is the allow-list a canon-wide scan (`validate`, `render`, backlink derivation) walks — anything else under the repo root (prose docs, `.ba/` itself, a WP's own `plan.md`) is out of scope by construction. `link_root` is the prefix every `## Scope` link's path must carry (`<link_root>/<canon-relative path>`) — normally the canon directory's own folder name, so links read correctly from wherever the canon root sits inside a larger host repo.

## CLI verbs

`id next` · `fmt` · `validate [--check]` · `vision confirm` · `cr confirm --entry vision|requirement --impacts-file <path>` · `cr realize` · `req edit|retire` · `epic add` · `wp prepare|approve-plan|abandon` · `bug capture|resolve` · `accept` · `status` · `render` (alias `export`) · `migrate` · `migrate-v3`.

Retired (no longer real dispatch verbs — replaced by the hybrid `id next` + direct `Write` pattern): `cr capture`, `req add`, `wp author`.

Every verb takes `--repo <canon-dir>`.

## Hybrid write-path

Skills `Write` canon md **directly** (`id next` → author from a template → `fmt` → `validate --check`); the CLI is reserved for transactional ops (`req edit` on a baselined item, `cr confirm`, `accept`, gates, reads). The human gates — confirm vision, confirm CR entry point + impact set (`grill-cr`), approve plan, accept/baseline — go through a real prompt (`AskUserQuestion`); machines write `VERIFY-OK`/`VERIFY-FAIL`, never `PASS`.

## Bootstrapping a fresh canon

A brand-new canon root needs three files before any skill can run against it:

`.ba/counters.yaml` (zeroed):

```yaml
product:
  epic: 0
  cr: 0
  wp: 0
  bug: 0
  baselineSeq: {}
epics: {}
retired: []
```

`.ba/config.yaml`:

```yaml
canon_roots:
  - vision.md
  - epics/
  - br/
  - cr/
  - wp/
  - bugs/
link_root: <canon-dir-basename>
```

`vision.md`, from `templates/vision.md` (`status: draft` until a human runs `vision confirm`):

```markdown
---
type: vision
status: draft
---

State, in one or two paragraphs, what this product is for and the outcome
it exists to produce.
```

From there: `node <plugin-dir>/bin/praxis-ba.cjs status --repo <canon-dir>` should report `VERIFY-OK`, and `confirm-vision` can run.

## Rebuilding the bundled CLI (maintainers)

`bin/praxis-ba.cjs` is bundled from this repo's own vendored source at `canon-graph/` (built from budget-scout's `@praxis-ba/canon-graph`; see `canon-graph/README`-level comments in source for provenance) with esbuild, fully in-repo — no external monorepo needed:

```bash
cd canon-graph && npm install && npm run build   # tsc -> dist/, the bin's own runtime import target
npx esbuild bin/praxis-ba.mjs --bundle --platform=node --format=cjs --target=node20 \
  --banner:js='#!/usr/bin/env node' \
  --outfile=../praxis-ba/bin/praxis-ba.cjs
```

(CJS format is required — an ESM bundle trips `gray-matter`'s and `yaml`'s dynamic `require`.)

**Note:** `canon-graph/bin/praxis-ba.mjs` uses a top-level `await` (real Node ESM supports this natively — how the file runs directly and how `canon-graph/test/bin.test.ts` spawns it), which esbuild's CJS output format cannot represent directly (CJS modules are synchronous by spec). If a straight `esbuild bin/praxis-ba.mjs ...` run fails with `Top-level await is currently not supported with the "cjs" output format`, bundle from a transient wrapper entry instead — same logic as `praxis-ba.mjs`, with the top-level `await runCli(argv)` rewritten as a `.then()` chain — and delete the wrapper once the bundle is written. Keep `canon-graph/bin/praxis-ba.mjs` itself untouched; only the esbuild entry needs the rewrite. Also: **do not** pass `--banner:js` when the entry file already starts with its own `#!/usr/bin/env node` shebang — esbuild preserves an entry's own shebang automatically, and combining both duplicates the line (a syntax error at runtime — `node` sees two `#!` lines back to back).
