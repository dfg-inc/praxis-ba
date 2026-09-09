---
name: one-pager
description: Build a client one-pager from a live canonical FR (WBS 1.14). Fails if purpose/назначение or Acceptance Criteria is missing.
---

# One-pager

## When to use

After a capability/FR has purpose and acceptance criteria and you need a client-facing page without re-entry.

## Steps

```bash
node ${CLAUDE_PLUGIN_ROOT}/tools/one-pager.mjs --repo <canon-dir> --id <FR-id> [--out path]
```

Equivalent CLI (same live-FR resolver):

```bash
praxis-ba one-pager --repo <canon-dir> --id <FR-id> [--out path]
```

## Done when

- Exit 0 and file written under `one-pagers/<id>.md` (or `--out`).
- Page contains Назначение, пользовательская ценность (optional), условия готовности copied from the FR's Acceptance Criteria.
- Source FR is unchanged.

## Failure modes

- Unknown id, non-FR id, missing назначение/purpose, or missing Acceptance Criteria → exit 1, page **not** written; fix the live FR then retry.
- Frozen copies under `baselines/` are never used as the source.
