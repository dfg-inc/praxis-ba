# praxis-ba

The ADLC **Business Analyst** plugin: author and govern a **md-first, git-native requirements canon** with skills + a self-contained validator/CLI.

**Install:** see [Install](#install) below. Jira is optional; local mode needs no account.

v3 adds impact-traced CRs (a single confirm gate after a relentless `grill-cr` interview), folder-shaped WPs, and a **dev-harness-agnostic** posture — this plugin prepares INPUT for development only; it names no specific downstream dev workflow, tool, or vendor.

## The layer around the canon (added in 0.4.0)

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

**Checks that stopped at the canon border.** `validate` proves structure **and**
semantic body discipline: a `[NEEDS CLARIFICATION]` marker left in an active
requirement, a reference to an NFR id absent from the project catalogue, a tag
outside the vocabulary, a child ahead of its parent, and broken relative links.
`shape-requirement` ends by running `ba-lint` (`praxis-ba validate`) before a
work package is prepared — `prepare-wp`'s own link-integrity gate fails on
exactly the links they find.

Alongside that, five skills and ten templates for the layer itself: laying it out on a
new project (`ba-scaffold`), and reversing it out of an existing codebase when the code
came first and the requirements never got written down (`ba-onboard`,
`ba-code-surface-scan`).

Everything new stays outside `canon/`: canon pages are still authored only by the canon
skills, and the engine's write path is untouched. The packaged plugin runtime is
**Node.js only** (no system Python).

## Install

From the Praxis Marketplace (Claude Code, Claude Desktop Code, Cowork):

```
claude plugin marketplace add dfg-inc/praxis-marketplace
claude plugin install praxis-ba@praxis
```

(install `praxis@praxis` instead for all four roles). In the Claude UI: Customize -> Plugins -> Add marketplace -> `dfg-inc/praxis-marketplace`. The shared Praxis Runtime (one MCP server) comes with it.

**Installing does not need a Jira token or any account.** Local mode (requirements, review, prototype, plan, stories in the repository) works without Jira. Jira is an optional integration that you configure separately, only if you want to read or write Jira; never paste a token into chat.

**Claude Desktop Chat** has no plugin Runtime: install `praxis-runtime.mcpb`, then upload the BA ZIP. The full ZIP carries every skill below plus the self-contained CLI under `tools/`; the light ZIP carries the Jira/local-workflow skills and the requirements-review, prototype, story-plan, stories-review, change-request and resume-work skills (they need only the Runtime tools). Steps that run the CLI (`approve-plan`, `prepare-wp`, `ba-lint`, `accept`, `one-pager`) need a host that can run local commands (Claude Code, Cowork); without one they report that instead of pretending.

## Skills

<!-- skills:start -->
30 skills in version 0.1.0-alpha.49, read from `plugins/ba/skills` and from the built archives.

| Skill | What it is for | Marketplace plugin | Desktop Chat full ZIP | Desktop Chat light ZIP |
| --- | --- | --- | --- | --- |
| `accept` | Use once a plan-approved WP's development harness reports its validation is green — the sole human-gated path to baselining a WP's requirements, the only verb in this ... | yes | yes | no |
| `approve-plan` | Use to record a human's plan-approval decision for a `ready` WP — the reusable human gate `prepare-wp` calls into once its definition-of-ready check is green and a pla... | yes | yes | no |
| `ba-code-surface-scan` | Internal sub-skill of ba-onboard: lists every backend route and frontend UI action of one code area deterministically, without interpreting meaning. | yes | yes | no |
| `ba-init` | Create the BA canon of a NEW project: the machine files, folders and a draft vision. | yes | yes | no |
| `ba-jira-status` | Read-only BA/Jira status for an Epic (canonical stories, superseded, handoff). | yes | yes | yes |
| `ba-lint` | Use after any write to the canon — runs machine validation via the packaged praxis-ba CLI in the required order. | yes | yes | no |
| `ba-onboard` | Brings an existing codebase onto the BA canon: reverses project context (data model, integrations, RBAC, NFRs, glossary, AS-IS map) from the code, then picks the first... | yes | yes | no |
| `ba-plan-slice` | The slicing gate inside grill-cr: splits a change request into separate user stories (one per requirement), separates rules and NFRs, and shows the plan to a human bef... | yes | yes | no |
| `ba-scaffold` | Once per project: lays out the BA documentation layer around the canon (project.md, glossary, inputs, shared, diagrams, meetings, tasks, archive) from templates. | yes | yes | no |
| `capture-bug` | Use when a client reports a bug against a shipped FR/NFR/BR — mints the bug directly from its template, recording repro/expected/actual and which requirement it violates. | yes | yes | no |
| `capture-cr` | Use when a change request comes in. | yes | yes | no |
| `change-request` | Handle a change to an application that already exists: a new feature in it, a behaviour change, an extension, a fix, or a technical change across services. | yes | yes | yes |
| `confirm-vision` | Use at the start of a new product or a vision-level change request — turns client prose into a confirmed vision.md, the human gate that unblocks every downstream CR/FR... | yes | yes | no |
| `goals` | Use when shaping or reviewing requirements against product goals — authors goal pages, links FR/NFR/BR via goal_ids, and runs goals status / check-goals for unclosed g... | yes | yes | no |
| `grill-cr` | Relentless product-level interview over a captured CR — one question at a time, each with a recommended answer — ending at the single human gate that confirms the CR's... | yes | yes | no |
| `jira-analyze-epic` | Analyze a Jira Epic key, create/update Stories with AC, write Architect handoff. | yes | yes | no |
| `jira-epic-analysis` | Analyze a Jira Epic, prepare BA stories and Architect handoff. | yes | yes | yes |
| `local-workflow` | Start or resume BA requirements from a local business request, markdown, or repository without Jira. | yes | yes | yes |
| `one-pager` | Builds a client one-pager from a live canonical requirement; fails if its purpose or acceptance criteria are missing. | yes | yes | no |
| `prepare-wp` | Use once a CR's impact set is realized and the FR/NFR/BR slice it produced is ready to hand off — authors the WP folder (`wp/{id}/index.md`) directly from its template... | yes | yes | no |
| `present-plan` | Show the user the exact BA action (preview) before any protected BA write, then let them approve or reject it in the MCP client. | yes | yes | no |
| `prototype` | Build and refine an interactive HTML prototype on mock data before any detailed story, using the application's real styles. | yes | yes | yes |
| `requirements-review` | Review requirements and acceptance criteria with the user in a standard HTML page, one criterion at a time. | yes | yes | yes |
| `resume-ba-work` | Resume BA work on an Epic from remote Jira + local proposal. | yes | yes | yes |
| `resume-work` | Continue work in a new chat. | yes | yes | yes |
| `session-start` | Use at the start of a BA session — runs the session bootstrap script (role ba, stage research) so project config and applicable knowledge rules are loaded before other... | yes | yes | no |
| `shape-requirement` | Use once a CR's entry point is confirmed and its impact set names an FR, NFR, or BR — authors a brand-new draft requirement for a `spawns` impact, or amends an already... | yes | yes | no |
| `status` | Use at any point to see where the product canon currently stands — vision confirmed or not, open/confirmed CRs, active vs. | yes | yes | no |
| `stories-review` | Write detailed User Stories from the agreed plan and review them with the user in HTML with a checkbox for every criterion, step, rule and expected result. | yes | yes | yes |
| `story-plan` | Write a short story plan before any detailed story: one line per story with what is built, what the user gets, data, prototype parts, requirements, repositories and de... | yes | yes | yes |
<!-- skills:end -->

## What's here

- **`skills/`** — the skills above.
- **`templates/`** — the 10 page skeletons (vision, fr, nfr, br, cr, wp, bug, epic-index, goal, one-pager) and **`templates/layer/`**, 10 skeletons for the project layer.
- **`bin/praxis-ba.cjs`** (Marketplace plugin) / **`tools/praxis-ba.cjs`** (full Desktop ZIP) — the self-contained CLI (`@praxis-ba/canon-graph` bundled into one file; no build, no `node_modules`, no Python).

## The v3 model in brief

- **CR flow:** capture (`capture-cr`, client's words verbatim, no product judgment yet) → grill (`grill-cr`, a product-only interview, one question at a time with a recommended answer) → **one human gate**: `praxis-ba cr confirm --entry vision|requirement --impacts-file <path>` — confirms both the entry point AND the full impact set (an array of `{amends: <FR/NFR/BR id>}` and/or `{spawns: fr|nfr|br, epic: <E#>}` entries) in a single transactional write.
- **Shaping executes the confirmed impact set** (`shape-requirement`), one entry at a time:
  - a `spawns` entry is realized via `praxis-ba cr realize --cr <id> --spawn <E#>:<fr|nfr|br> --id <new-id>` — mints the new requirement and stamps the CR's own record of what it spawned;
  - an `amends` entry is realized via `praxis-ba req edit --req <id> --body-file <path> --cr <cr-id> [--activate]` — this **bumps the target's `version`** and prepends a `### v{N} — {date} — {cr-id}` entry under `## History` (the prior body archived verbatim underneath, heading levels demoted so nested History from an earlier bump never collides). A confirmed `--cr` is required for every bump now — v3 makes the CR citation universal, not just for baselined items.
- **CRs auto-resolve on full delivery** — during `accept`, a CR with a non-empty `impacts` set resolves once every entry is provably delivered (each `amends` target `baselined` with a `## History` citation back to this CR; each `spawns` target `realized` and itself `baselined`, with `traces_to` citing this CR back). No manual "close the CR" step.
- **WP = a folder**, not a flat file: `wp/<id>/index.md` (frontmatter + goal) **co-located** with `wp/<id>/plan.md` (the approved plan). A WP carries no FR/NFR/BR scope in frontmatter at all — it lives entirely in the `## Scope` section (`### Change requests` / `### Delivers` / `### Constraints`), plain markdown links (`- [<id>[ vN]](<path>[#anchor])`) that are the **machine-readable refs** `wp prepare`'s link-integrity gate reads and `wp approve-plan`/`accept` re-check. `plan.md` is a canon **attachment**, not a discoverable canon node — excluded from canon-wide scans (see `.ba/config.yaml` below) so it never gets treated as an untyped page.
- **Dev-harness-agnostic (permanent):** nothing in this plugin's skills or templates may name a specific downstream development harness, workflow-plugin convention, dev-loop file layout, or model vendor. A plan-approved WP folder is the complete handoff — what happens after that is entirely the host repo's own process, described in the host repo's own docs (e.g. its `CLAUDE.md`), never here.

## The canon

A canon root (created by `praxis-ba init`) is a directory holding `.ba/{config,counters}.yaml`, `vision.md`, `epics/E#-*/`, `br/`, `cr/`, `wp/`, `bugs/`, `baselines/BL-*/`. Requirements are markdown (machine frontmatter + human body); traceability is typed frontmatter refs (`traces_to` / `enforces` / `references_nfr` / `fr_ids`); registers + backlinks + RTM are generated views (e.g. VitePress data loaders in a host repo's own docs site).

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

`init [--dry-run] [--product <name>] [--epic <title>]` · `id next` · `fmt` · `validate [--check]` · `vision confirm` · `cr confirm --entry vision|requirement --impacts-file <path>` · `cr realize` · `req edit|retire` · `epic add` · `wp prepare|approve-plan|abandon` · `bug capture|resolve` · `accept` · `status` · `render` (alias `export`) · `migrate` · `migrate-v3`.

Retired (no longer real dispatch verbs — replaced by the hybrid `id next` + direct `Write` pattern): `cr capture`, `req add`, `wp author`.

Every verb takes `--repo <canon-dir>`.

## Hybrid write-path

Skills `Write` canon md **directly** (`id next` → author from a template → `fmt` → `validate --check`); the CLI is reserved for transactional ops (`req edit` on a baselined item, `cr confirm`, `accept`, gates, reads). The human gates — confirm vision, confirm CR entry point + impact set (`grill-cr`), approve plan, accept/baseline — go through a real prompt (`AskUserQuestion`); machines write `VERIFY-OK`/`VERIFY-FAIL`, never `PASS`.

## Start a new project

In an empty project directory (Claude Code or Cowork; the CLI is a local command). The plugin is all you need: no source checkout, no `node_modules`.

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/praxis-ba.cjs init --repo . --dry-run   # preview: lists what would be created, writes nothing
node ${CLAUDE_PLUGIN_ROOT}/bin/praxis-ba.cjs init --repo . --product "My product" --epic "First epic"
node ${CLAUDE_PLUGIN_ROOT}/bin/praxis-ba.cjs status --repo .           # VERIFY-OK
```

(In the full Desktop ZIP the CLI is `tools/praxis-ba.cjs`.) `init` creates `.ba/config.yaml`, `.ba/counters.yaml`, the folders `epics/ br/ cr/ wp/ bugs/ baselines/`, a **draft** `vision.md`, and, with `--epic`, a first epic. It never overwrites: a second run creates nothing, an invalid existing `.ba/config.yaml` is refused (never repaired), and nothing outside `--repo` is touched. The skill `ba-init` runs it with a preview and asks the user first.

Then, in order:

1. `confirm-vision`: write the vision and have a human confirm it (`praxis-ba vision confirm`; only that verb sets `status: confirmed`).
2. `ba-scaffold` (optional): the project documentation layer (project.md, glossary, inputs, shared). `init` does not create it.
3. `capture-cr`, then `grill-cr`, `shape-requirement`, `prepare-wp`.

Any other canon command in a directory without a canon stops with `no canon here: run praxis-ba init --repo <dir>`.

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
