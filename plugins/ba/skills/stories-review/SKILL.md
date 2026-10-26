---
name: stories-review
description: "Write detailed User Stories from the agreed plan and review them with the user in HTML with a checkbox for every criterion, step, rule and expected result. Use for creating, viewing, editing, splitting, merging, excluding or restoring stories. Stories are readable and changeable after creation, not only creatable."
---

# Stories and their review

Stage: `stories_review`. Role: BA.

## Write

Still in the `story_plan` stage, once the plan is agreed: for each plan line, `add-story`: `id`, `title`, `requirementIds`, `actor`, narrative `As a [role], I want [capability], so that [value].`, `objective`, `userValue`, `preconditions`, `happyPath` (steps), `alternatives`, `negative`, `edgeCases`, `businessRules`, Given/When/Then `acceptanceCriteria`, `expectedResults`, `screenRefs`, `repositoryIds`, `capabilities`. Keep each story small enough to implement and verify on its own.

Entering `stories_review` needs every planned story detailed. A story keeps the plan line's title, capabilities, screens and repositories unless you give others.

## Show

`praxis_review_render` with `view: "stories"` (the Runtime opens it in the user's browser). The page lists every story with a control for each acceptance criterion, step, alternative, negative case, edge case, rule and result. The user ticks accept or reject per item, comments, edits a story's text, excludes it or restores it. Use `praxis_workflow_inspect` (`view: "stories"`) when the user only wants to read them.

## Change

- `update-story` by id: patch fields, and add, set or remove acceptance criteria. The story gets a new revision; its marks start over, other stories' marks stay, earlier confirmations and Quality evidence for it become stale.
- `exclude-story` / `restore-story`, `split-story` (moves criteria into new stories), `merge-stories`.
- A requirement taken out of scope excludes its stories by itself.
- Coverage: `praxis_workflow_status` → `next` reports gaps (a requirement without a story, missing view/search/create/edit/delete/validation/error/permission/state stories). Fix them or waive with a reason.

## Confirm

Confirming a story's behavior (`confirm-story`) is the user's act: the client asks them to approve the exact content. Do not call it for them. When all items are accepted and coverage holds, `advance-phase` to `architecture` and hand off with `handoff` (story ids travel with it).

## Rules

- Never edit a story by recreating it under a new id; ids are stable.
- You cannot accept items or stories for the user. Anything marked through `praxis_workflow_apply` is refused with `USER_DECISION_REQUIRED`.
