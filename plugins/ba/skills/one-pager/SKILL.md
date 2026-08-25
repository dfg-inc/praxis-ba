---
name: one-pager
description: Build a client one-pager from a requirement (WBS 1.14). Fails if purpose/назначение is missing.
---

# One-pager

## When to use

After a capability/FR has purpose and acceptance criteria and you need a client-facing page without re-entry.

## Steps

```bash
node ${CLAUDE_PLUGIN_ROOT}/tools/one-pager.mjs --repo <canon-dir> --id <FR-id> [--out path]
```

## Done when

- Exit 0 and file written under `one-pagers/<id>.md` (or `--out`).
- Page contains Назначение, пользовательская ценность, условия готовности.

## Failure modes

- Missing назначение/purpose → exit 1, page **not** written; fix source FR then retry.
