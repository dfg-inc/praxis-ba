---
name: capture-cr
description: Use when a change request comes in. Records the client's words verbatim as a captured CR with separate Verbatim vs Interpretation sections (WBS 1.1). grill-cr follows before confirmation or shaping.
---

# Capture CR

A CR is captured BEFORE its entry point or impact set is judged — that judgment belongs to `grill-cr`. This skill's only job is getting the client's ask onto disk **verbatim**, with interpretation kept empty and separate.

## When to use

After intake, once vision is `confirmed` and a document/note resolved into "this is a CR" — not a bug alone (`capture-bug`).

## Steps (HYBRID: direct Write)

1. `praxis-ba id next --scope cr --repo <canon-dir>` (or `praxis-ba` alias) → next id (e.g. `CR-004`).
2. **Write** `<repo>/cr/<id>.md` from `templates/cr.md`:
   - Replace sentinel `id`.
   - Set `source` (email/ticket/channel) and `captured_at` (ISO date).
   - Put the client's text **only** under `## Verbatim` — no edits, no paraphrase.
   - Leave `## Interpretation` empty (or whitespace only).
3. `praxis-ba fmt <path> --repo <canon-dir>` then `praxis-ba validate --check --repo <canon-dir>`.

Do **not** run retired `cr capture`.

## Done when

- Page on disk; validate green.
- Verbatim holds raw ask; Interpretation empty.
- Next: `grill-cr`.

## Failure modes

- Interpretation filled at capture → rewrite; clear Interpretation.
- Verbatim paraphrased → restore original words from source.
- Mixed single body without sections → regenerate from template.
