---
id: WP-20260101-001
type: wp
role: developer
status: draft
---

<!-- TEMPLATE (Task 17, comment rewrite Task 12): `id` above is a
FORMAT-VALID SENTINEL (WP-20260101-001) — replace it with the id returned
by `praxis-ba id next --scope wp --date <YYYYMMDD>` (minted+persisted; the
hybrid direct-Write contract, not a `wp author` call — the `YYYYMMDD` is
only the informational creation date; the id's uniqueness comes from
`counters.product.wp`, a flat monotonic counter). This file lives at
`wp/<id>/index.md` — a FOLDER per WP, the same shape epics already use, not
a flat `wp/<id>.md` file.
`role` (`developer`|`qa`) is informational only — no gate depends on it.
`status` moves `draft -> ready -> plan-approved -> accepted` (or
`abandoned`); everything past `draft` is set by a verb (`wp prepare`,
`wp approve-plan`, `accept`), never hand-edited. `plan` (the canon-relative
path `wp/<id>/plan.md`) is stamped by `wp approve-plan` once a human
approves the plan living at that exact path — omit it here until then.
A WP carries NO FR/NFR/BR scope in frontmatter at all — it lives entirely
in the `## Scope` section below (scopelinks.ts's `parseScope` grammar),
the machine-readable input `wp prepare`'s link-integrity gate reads.
`### Delivers` is the grammar's one required subsection (>= 1 FR link,
shape `- [<id>[ vN]](<path>[#anchor])`); `### Change requests` (CR links)
is required IN PRACTICE — `wp prepare` hard-requires every Delivers FR's
`traces_to` to include at least one CR from this list
(frs-trace-to-scoped-cr) and every CR listed here to be `confirmed`
(wp-scope-crs-confirmed), so a WP without it cannot pass the gate. Only
`### Constraints` (NFR/BR links this WP touches without an FR already
carrying them) is genuinely optional. Every link's path must equal
a path **relative to this WP file** (e.g. `../../epics/E1-x/E1-FR1.md`); a version suffix (` vN`) is required
whenever the target is `baselined`. The sentinel links below are
FORMAT-VALID PLACEHOLDERS ONLY — `wp prepare` will fail its link-integrity
check until every one is swapped for a real ref. -->

State the short goal/intent this work package delivers — a sentence or two.

## Scope

### Change requests
- [CR-001](../../cr/CR-001.md)

### Delivers
- [E1-FR1 v1](../../epics/E1-template-epic/E1-FR1.md#acceptance-criteria)

### Constraints
- [E1-NFR1 v1](../../epics/E1-template-epic/E1-NFR1.md#planguage)
