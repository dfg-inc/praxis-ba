---
id: ba-ac-gherkin
title: Acceptance criteria in Gherkin form
roles: [ba]
stages: [research, plan, implement, verify]
severity: mandatory
overridable: true
---

# Acceptance criteria in Gherkin form

Every FR Acceptance Criteria line must be verifiable: contain **given / when / then**
(English) or **Дано / Когда / Тогда** (Russian). Unverifiable ACs fail readiness
and are reported under rule id `ba-ac-gherkin`.
