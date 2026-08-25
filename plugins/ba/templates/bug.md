---
id: BUG-001
type: bug
status: open
severity: medium
affects:
  - E1-FR1
reported: 2026-01-01
reporter: client
---

<!-- TEMPLATE (Task 17): `id` above is a FORMAT-VALID SENTINEL (BUG-001) —
replace it with the id returned by `praxis-ba id next --scope bug`
(minted+persisted; the hybrid direct-Write contract, not a `bug capture`
call). `affects`
holds the FR/NFR/BR id(s) this bug is against — the sentinel `E1-FR1` here
is a placeholder only; swap it for the real affected id(s) (a typed ref +
derived backlink, §6.7). `severity`/`reported`/`reporter` are free-text
fields with no fixed enum — replace the placeholder values above with the
real severity label, the report date, and who reported it. `status` moves
`open -> fixed`, or the terminal `wontfix`/`duplicate` — set only via
`bug resolve`, never hand-edited. This canon is for CLIENT-REPORTED bugs
only (§6.7): a bug a developer finds mid-WP lives outside this canon, in
the repo's own engineering docs, not here — every bug id, canon or not,
mints via `praxis-ba id next --scope bug` (one shared number line), so ids
never collide across the two homes. Optional frontmatter this template
omits until known: `spawned_cr` (a CR-### id, only when this bug spawned a
change request). -->

**Repro:** the exact steps to reproduce, from a known starting state.

**Expected:** what should have happened.

**Actual:** what happened instead.
