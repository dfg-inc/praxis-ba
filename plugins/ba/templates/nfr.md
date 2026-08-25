---
id: E1-NFR1
type: nfr
epic: E1
status: draft
version: 1
traces_to: []
verified_by: []
related: []
---

<!-- TEMPLATE (Task 17): `id`/`epic` above are FORMAT-VALID SENTINELS
(E1-NFR1 / E1) — replace both with the id returned by `praxis-ba id next --scope nfr:E1` (minted+persisted; the hybrid direct-Write contract, not a `req add` call).
`traces_to` must resolve to a `confirmed` CR before `wp prepare` will pass
definition-of-ready (§8b) — NFRs are gated like FRs, not exempt. `verified_by`
is the (typed) list of what proves the Goal below is met — a test suite id,
a benchmark, a monitoring dashboard; leave `[]` until known. -->

## Planguage

- Tag: <a short, stable name for the quality attribute this NFR pins down>
- Scale: <the unit/dimension it is measured in, e.g. milliseconds, % of requests, bits of entropy>
- Meter: <how/where it is measured — the instrument or process, not just the number>
- Goal: <the target value on that Scale that counts as met>

## Rationale

Explain why this quality attribute matters now and how it protects the
vision — the human-judgment narrative behind the machine trace above.
