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

**Вход:** путь к канону (папка `canon/`) и `${CLAUDE_PLUGIN_ROOT}`.
**Выход:** отчёт по проходам. Ничего не исправляется молча.

<HARD-GATE>
(1) Порядок: структура → rules → body/link integrity (все через praxis-ba.cjs). (2) Если любая команда не запускается или возвращает ненулевой код — это **FAIL**, не «проверено вручную». (3) Не правь находки без решения человека.
</HARD-GATE>

## Проход 1 — структура канона

```
node ${CLAUDE_PLUGIN_ROOT}/bin/praxis-ba.cjs validate --repo <canon-dir>
```

Красное / non-zero exit — **стоп**.

## Проход 2 — правила как данные

```
node ${CLAUDE_PLUGIN_ROOT}/bin/praxis-ba.cjs rules-lint --repo <canon-dir>
```

## Проход 3 — handoff / plan readiness (optional explicit)

Before marking a WP `plan-approved`, also:

```
node ${CLAUDE_PLUGIN_ROOT}/bin/praxis-ba.cjs wp approve-plan --repo <canon-dir> --wp <id> --plan wp/<id>/plan.md
```

`wp approve-plan` itself re-runs structural validation and refuses approval on VERIFY-FAIL or if the CLI cannot execute checks.

## Триаж

Находки покажи по проходам: что нашли, чем грозит, что предлагаешь. Правка active/baselined — только через `req edit` с confirmed CR.

## Когда запускать

- после shape-requirement / перед prepare-wp
- после переименования файлов
- перед approve-plan / handoff
