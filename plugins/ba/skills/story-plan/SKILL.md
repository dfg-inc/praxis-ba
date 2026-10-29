---
name: story-plan
description: "Write a short story plan before any detailed story: one line per story with what is built, what the user gets, data, prototype parts, requirements, repositories and dependencies. Use after the prototype is accepted. Do not write dozens of detailed stories before the plan is agreed."
---

# Story plan

If `praxis_doctor` is not available: stop with `PRAXIS_RUNTIME_UNAVAILABLE`.

Stage: `story_plan`. Role: BA.

## Flow

1. Read the accepted requirements and the prototype (`praxis_workflow_inspect`, `praxis_workflow_status`).
2. Decompose into stories that each deliver something the user can see: split by user outcome and screen, not by technical layer. Check the list against what a feature needs: viewing, searching and filtering, creating, editing, deleting, validation and error cases, permissions, empty/loading/error states. Missing ones are gaps.
3. `set-story-plan` with one entry per story: `id` (`US-...`), `title`, `implementation` (what is built), `userGets`, `data`, `screenRefs` (`screen` or `screen#element`), `requirementIds`, `acIds`, `repositoryIds` / `serviceIds`, `dependsOn`, `capabilities`.
4. `praxis_review_render` with `view: "story-plan"` (the Runtime opens it in the user's browser). The user can edit a line, accept or reject it, exclude it with a reason, and agree the plan.
5. Change lines with `update-story-plan` (`add`, `update`, `exclude`, `restore`). Render again after changes.
6. When the plan is agreed, write the detailed stories with `add-story`, one per plan line (see `stories-review`). When every line is detailed, `advance-phase` to `stories_review`.

## Rules

- `add-story` is refused in guided mode for a story that is not in the agreed plan (`STORY_PLAN_NOT_AGREED`, `STORY_NOT_IN_PLAN`). Do not skip the plan.
- A plan that does not cover what the requirements imply is refused (`coverage gaps`): add the story, or, if the user agrees the gap is intended, they waive it with a reason (in the Story Plan review page there is a "waive" control per gap; or a `waivers` entry handed over through `praxis_review_apply`; `waive-coverage` from you is refused). Waivers are applied before the agreement, so one Save can waive and agree.
- Required capabilities come from what the requirement STATEMENT says a user can do and from what the prototype and endpoints built for it do; each gap names what asked for it. Wording inside the acceptance criteria only produces non-blocking suggestions (with the phrase that fired). Status values, quoted labels and parameter names are data, not operations. Capability inference reads English: for other languages declare `capabilities` on the plan lines.
- You cannot mark the plan agreed for the user.
