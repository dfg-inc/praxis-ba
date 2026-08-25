---
name: goals
description: Use when shaping or reviewing requirements against product goals — authors goal pages, links FR/NFR/BR via goal_ids, and runs goals status / check-goals for unclosed goals and requirements without a goal.
---

# Goals

The goals layer (WBS 1.11 / 1.16) sits between confirmed vision and shaped requirements. A goal is a measurable product outcome; requirements cite it via optional `goal_ids` on FR/NFR/BR frontmatter. Backlinks (which requirements advance a goal) are reverse-walked — never stored on the goal page.

## When to use

- After `confirm-vision`, before or while running `shape-requirement`.
- When `praxis-ba status` reports `missing:requirement-without-goal` or `missing:goal-without-requirements`.
- Before handing a slice to `prepare-wp` if the product expects goal coverage.

## What happens

1. **Author** (if needed) `goals/G{n}.md` from `.claude/plugins/praxis-ba/templates/goal.md` (or this plugin's `templates/goal.md`): pick the next free `G{n}`, set `title` and `status: draft|active`, fill Outcome + Success signal.
2. On each FR/NFR/BR that advances the goal, set `goal_ids: [G{n}]` (array; may list more than one). Prefer editing via `shape-requirement` / `req edit` so baselined pages bump correctly.
3. Run:
   ```
   praxis-ba goals status --repo <canon-dir>
   ```
   (alias: `praxis-ba check-goals --repo <canon-dir>`). Advisory exit 2 lists requirements without goals and goals with zero requirements.
4. `praxis-ba fmt` + `praxis-ba validate --check` after any write.

## Done when

Every open requirement that should advance a goal cites one, and every active goal has at least one citing requirement — or the human explicitly accepted gaps from `goals status`.
