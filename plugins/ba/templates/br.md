---
id: E1-BR1
type: br
epic: E1
kind: operative
enforcement: advisory
status: draft
version: 1
---

<!-- TEMPLATE (Task 17): `id`/`epic` above are FORMAT-VALID SENTINELS
(E1-BR1 / E1) — replace both with the id returned by `praxis-ba id next --scope br:E1` (minted+persisted; the hybrid direct-Write contract, not a `req add` call).
`kind` is `structural` (a constraint on the domain model/architecture) or
`operative` (a constraint on behavior/process) — pick whichever this rule
actually is. `enforcement` is `advisory` (should hold, flagged if violated)
or `hard` (a gate: violating it fails a check) — most BRs start advisory
and are promoted to hard once the enforcing FRs exist. This BR's own
lifecycle (draft -> active -> batched -> baselined) is the SAME unified
status enum as FR/NFR (§7) — an FR references this BR via its `enforces`
list; that "enforced-by" relationship is a derived backlink, never stored
here. -->

State the rule as one plain declarative sentence: the thing that must
always (or never) be true, independent of any single FR's wording.

**Example:** give a concrete, one-line example of the rule in effect (a
before/after, an accepted vs. rejected case) — enough for a reader to
recognize a violation without re-deriving the rule from first principles.

**Source:** where this rule comes from (a regulation, an ADR, a market-
research finding, an owner decision) — the citation a reviewer would ask for.
