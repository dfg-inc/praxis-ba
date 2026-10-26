---
name: ba-init
description: "Create the BA canon of a NEW project: the machine files, folders and a draft vision. Use when the project has no .ba/ folder yet, before capture-cr, confirm-vision or any other canon skill. Shows what will be created first and writes only after the user agrees; never overwrites anything."
---

# BA init: create the canon of a new project

If `praxis_doctor` is not available: stop with `PRAXIS_RUNTIME_UNAVAILABLE`.

The canon skills (`confirm-vision`, `capture-cr`, `status`, `id next`, ...) need a canon root: a directory with `.ba/config.yaml` and `.ba/counters.yaml`. A new project has neither, and without them every canon command fails with `no canon here`. This skill creates them. It only ever creates: anything that already exists is skipped, never overwritten or repaired.

## When to use

- A new project, an empty or non-BA directory, no `.ba/` folder.
- Any canon command answered `no canon here: run praxis-ba init`.

Not for a project that already has a canon (check with `status`), and not for the documentation layer around it (that is `ba-scaffold`, a separate optional step).

## Two ways, same files

- **Runtime tools (any host, including Claude Desktop Chat; no local command needed):** `praxis_canon_init_preview` (read-only plan) then `praxis_canon_init_apply` with `confirmation=YES`; the user approves exactly the listed paths in the client's dialog. Optional `product` sets the heading of the draft vision. It does not create the first epic.
- **The BA CLI (Claude Code or Cowork):** `node ${CLAUDE_PLUGIN_ROOT}/bin/praxis-ba.cjs init --repo . [--dry-run] [--product "<name>"] [--epic "<title>"]`; `--epic` also creates the first epic E1 when the canon has no epics yet.

Prefer the Runtime tools when the Praxis Runtime is available; use the CLI when you also want the first epic.

## Steps

1. **Preview, no writes:** `praxis_canon_init_preview` (or the CLI with `--dry-run`).
2. **Show the user** what will be created in plain words: `.ba/config.yaml` and `.ba/counters.yaml` (machine files, edited only by the tool), the folders `epics/ br/ cr/ wp/ bugs/ baselines/`, a draft `vision.md`; and what already exists and is left alone. Ask whether to go ahead. If it refuses (for example a symbolic link or a file where a folder belongs), show the message; do not repair anything for the user.
3. **Only after the user agrees:** `praxis_canon_init_apply` with `confirmation=YES` (or the CLI without `--dry-run`).
4. Check: the CLI `status --repo .` reports `VERIFY-OK` (where the CLI is available), or run `praxis_canon_init_preview` again: it must list nothing to create.
5. Tell the user what was created and what comes next: optional `ba-scaffold`, then `confirm-vision`, then `capture-cr`.

Running it again is safe: the second run creates nothing.

## Next steps

1. `confirm-vision`: write the vision into `vision.md` (it is created as a draft) and have the user confirm it. Only the human-gated `praxis-ba vision confirm` sets `status: confirmed`; init never does.
2. `ba-scaffold` (optional): the project documentation layer around the canon (project.md, glossary, inputs, shared). Init does not create it. For an existing codebase use `ba-onboard`, which calls `ba-scaffold` itself.
3. `capture-cr`: record the first change request once the vision is confirmed.

## Rules

- Preview first, write after the user's yes. Never run init without `--dry-run` before the user has seen the plan.
- Never create `.ba/` files by hand and never edit `.ba/counters.yaml`.
- Do not use init to "fix" a broken canon. An invalid config or ledger is reported, and the user decides.
