---
id: E1-FR1
type: fr
epic: E1
status: draft
version: 1
traces_to: []
enforces: []
references_nfr: []
related: []
---

<!-- TEMPLATE (Task 17): `id`/`epic` above are FORMAT-VALID SENTINELS
(E1-FR1 / E1) — replace both with the id returned by `praxis-ba id next --scope fr:E1`
(never hand-mint an id; `allocateId` is the single writer, design §10, minted+persisted via `id next` under the hybrid direct-Write contract).
`traces_to` must resolve to a `confirmed` CR before `wp prepare` will pass
definition-of-ready (§8b) — fill it in as soon as the CR is known, e.g.
`traces_to: [CR-001]`. `enforces`/`references_nfr` are the BR/NFR ids this
FR is responsible for upholding/depends on; leave `[]` if none apply.
Optional `goal_ids: [G1]` links this FR to the goals layer (WBS 1.11). -->

As a <role>, I want <capability>, so that <benefit>.

## Acceptance Criteria

- AC-1: given <a starting state>, when <the user/system does something>, then <the observable, verifiable outcome>.
- AC-2: given <a starting state>, when <the user/system does something>, then <the observable, verifiable outcome>.

## Rationale

Explain why this FR is prioritized now and how it advances the vision —
the human-judgment narrative behind the machine trace above (`traces_to`/
`enforces`/`references_nfr` are the trace; this section is the "why").

<!-- `## History` is NOT part of this template: it is appended automatically
by the writer the first time this FR is edited after being `baselined`
(design §8a) — never hand-author it. -->
