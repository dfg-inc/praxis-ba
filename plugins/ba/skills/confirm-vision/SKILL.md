---
name: confirm-vision
description: Use at the start of a new product or a vision-level change request — turns client prose into a confirmed vision.md, the human gate that unblocks every downstream CR/FR/WP. Read-mostly; the only durable write is the human-gated `praxis-ba vision confirm`.
---

# Confirm Vision

Vision is the root of the canon graph: `definitionOfReady` (blocks `wp prepare`) and `acceptGate` (blocks `accept`) both hard-require `vision.md`'s `status == confirmed`. Nothing downstream — no CR, no FR/NFR/BR, no WP — can ever be batched or baselined while the vision is `draft`. Confirming it is a human-only action (CLAUDE.md: "Human-only actions: confirm vision …").

## When to use

- A brand-new product/domain: no `vision.md` yet, or one still `status: draft`.
- A vision-level change request (`grill-cr`'s entry-point confirmation lands at "vision", not at a single FR) — re-run this skill to re-validate and re-confirm.

## What happens

1. **Read** `<repo>/vision.md` (`--repo` is the canon root, `product/` in this monorepo). If it doesn't exist yet, `Write` it from `.claude/plugins/praxis-ba/templates/vision.md` (`status: draft`) with the drafted vision prose — one or two paragraphs stating what the product is for and the outcome it exists to produce, per the template's own body comment. This is the ONE non-gated step here; there is no `vision capture` verb in the CLI at all — vision is a singleton file, not an id-minted entity (`id next` has no `vision` scope).
2. **Summarize** the drafted/existing vision back to the human: objective, scope, non-goals, and whether a future FR/NFR/BR would obviously belong or not. When outcomes are clear enough to name, draft candidate **goals** (`templates/goal.md` / skill `goals`) after confirmation — vision is the root; goals are the measurable layer requirements will cite via `goal_ids`.
3. Where the objective is unmeasurable or the scope is blurry, surface it as an explicit open question rather than inventing a value — never guess an answer that has no source.
4. **Human gate.** Use **AskUserQuestion** to get the human's explicit confirmation: "Confirm this vision as written?" (confirm / needs changes / open question needs a decision first). Only a human answer here counts — an agent never self-confirms a vision. On "needs changes", loop back to steps 1–2 before asking again.
5. On confirmation, run:
   ```
   praxis-ba vision confirm --repo <canon-dir> --by "<human name>" --date <YYYYMMDD>
   ```
   (`--by`/`--date` are optional — omit them to let the CLI default to the current user/today; pass them explicitly for a reproducible, dated record.) This is the ONLY writer of `status: confirmed` / `confirmed_at` / `confirmed_by`, and it rejects re-confirming an already-confirmed vision.
6. Run `praxis-ba validate --check --repo <canon-dir>` to confirm the corpus is still schema-valid after the write.

## Done when

`vision.md` has `status: confirmed`, the human explicitly said so (never inferred from silence), and `praxis-ba validate --check` is green. Only then can `capture-cr` / `grill-cr` / `shape-requirement` / `prepare-wp` proceed — their gates all read this flag.

## CLI invocation note

`praxis-ba` is this plugin's CLI, **vendored self-contained** at the plugin's `bin/praxis-ba.cjs` — a single bundled file (the whole `@praxis-ba/canon-graph` engine + its deps inlined; source vendored at this repo's `canon-graph/`). No build, no `node_modules`, no `npm install`. `--repo` is the canon root — the directory that directly contains `.ba/`, `vision.md`, `epics/`, `cr/`, `wp/`, `bugs/`. `praxis-ba` is not on `PATH` — every `praxis-ba <verb> …` shown in this plugin's skills is shorthand for:

```
node <plugin-dir>/bin/praxis-ba.cjs <verb> …
```

where `<plugin-dir>` is this plugin's install directory (the folder holding `bin/`, `skills/`, `templates/`). This same note applies to every other skill in this plugin.
