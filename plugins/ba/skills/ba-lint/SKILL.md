---
name: ba-lint
description: Use after any write to the canon — runs machine validation via the packaged praxis-ba CLI in the required order. A failed or non-executable validator is a hard FAIL (never a manual best-effort PASS).
---

# BA Lint — machine validation (packaged CLI)

**Supported execution path (external install + monorepo):**

```
node ${CLAUDE_PLUGIN_ROOT}/bin/praxis-ba.cjs <verb> --repo <canon-dir>
```

Do **not** invent monorepo-relative paths (`plugins/ba/...`, workspace `node_modules/@praxis/...`). Do **not** treat a denied shell permission as a soft PASS — if the CLI cannot run, stop and report FAIL.

Do **not** invoke Python / `lint.py`. Semantic body checks run inside `praxis-ba validate` (Node-only).

**Вход:** путь к канону (папка с `.ba/` / `wp/` / `epics/` … — часто корень репозитория или `canon/`) и `${CLAUDE_PLUGIN_ROOT}`.
**Выход:** отчёт по проходам. Ничего не исправляется молча.

<HARD-GATE>
(1) Порядок: структура + семантика тела → rules (все через praxis-ba.cjs). (2) Если любая команда не запускается или возвращает VERIFY-FAIL — это **FAIL**, не «проверено вручную». (3) Не правь находки без решения человека.
</HARD-GATE>

## Проход 1 — структура + семантика канона

```
node ${CLAUDE_PLUGIN_ROOT}/bin/praxis-ba.cjs validate --repo <canon-dir>
```

Covers schema/graph/ids **and** semantic body checks:
- `[NEEDS CLARIFICATION]` left in an active-or-later requirement
- catalogue NFR id missing from `shared/nfr.md`
- tag outside `shared/taxonomy.md`
- child requirement ahead of its parent epic status
- broken relative Markdown links

Красное / VERIFY-FAIL / non-zero hard exit — **стоп**. WP must not be treated as Architect-ready.

## Проход 2 — правила как данные

```
node ${CLAUDE_PLUGIN_ROOT}/bin/praxis-ba.cjs rules-lint --repo <canon-dir>
```

## Проход 3 — handoff / plan readiness (optional explicit)

Before marking a WP `plan-approved`, also:

```
node ${CLAUDE_PLUGIN_ROOT}/bin/praxis-ba.cjs wp approve-plan --repo <canon-dir> --wp <id> --plan wp/<id>/plan.md
```

`wp approve-plan` itself re-runs validation (structural + semantic) and refuses approval on VERIFY-FAIL. On success it emits `wp/<id>/handoffs/ba-architect.handoff.json`.

## Триаж

Находки покажи по проходам: что нашли, чем грозит, что предлагаешь. Правка active/baselined — только через `req edit` с confirmed CR.

## Когда запускать

- после shape-requirement / перед prepare-wp
- после переименования файлов
- перед approve-plan / handoff
