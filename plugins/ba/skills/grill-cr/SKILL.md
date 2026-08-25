---
name: grill-cr
description: Relentless product-level interview over a captured CR — one question at a time, each with a recommended answer — ending at the single human gate that confirms the CR's entry point and impact set. Runs after capture-cr, before shape-requirement.
---

<!-- Vendored per the v3 no-external-dependency mandate from the owner's
grilling skill at ~/.claude/skills/grilling/SKILL.md (and its /grill-me
wrapper), adapted from plan/design grilling to BA change-request grilling.
Original interview discipline preserved verbatim where possible. -->

Interview the client relentlessly about every aspect of this change request
until we reach a shared understanding. Walk down each branch of the ask,
resolving dependencies between decisions one-by-one. For each question,
provide your recommended answer.

Ask the questions one at a time, waiting for feedback on each question
before continuing. Asking multiple questions at once is bewildering.

If a *fact* can be found in the canon (vision, epics, FR/NFR/BR pages,
prior CRs, bugs), look it up rather than asking. The *decisions* are the
client's — put each one to them and wait for the answer.

**Scope discipline — product only.** Every question is about the product:
user value, observable behavior, business rules, edge cases, what
"done" looks like to the client. NEVER ask about (or record) architecture,
components, libraries, code, or how development will build it — solution
detail belongs downstream of the BA harness entirely.

Flow:
1. Read the captured CR (`<repo>/cr/<id>.md`) and the canon it touches.
2. Grill. As answers land, append them to the CR body as a dated digest
   (`### Grill — YYYY-MM-DD`, question → answer bullets) via Write, then
   `praxis-ba fmt <file> --repo <repo>`.
3. Draft the candidate impact set: which existing FR/NFR/BR pages this CR
   AMENDS, and which new requirements it SPAWNS (type + epic). Derive it via
   the `ba-plan-slice` skill — the slice-planning gate: it splits the scope
   into one-story-per-`fr` slices, separates business rules and NFRs, checks
   each story against the glued-together test, and hands back the very
   `--impacts-file` step 4 applies. Without that step the impact set is a
   by-product of how many paragraphs the interview happened to produce.
4. The human gate (AskUserQuestion): present entry point (vision |
   requirement) + the impact set in one decision. On confirmation run
   `praxis-ba cr confirm --repo <repo> --cr <id> --entry <level> --impacts-file <tmp.json>`
   then `praxis-ba validate --check --repo <repo>`.

Done when: the CR is `confirmed` with a non-empty, human-confirmed impact
set (requirement entry) or `entry: vision`, and validate --check is green.
Only then may `shape-requirement` execute the impact set.
