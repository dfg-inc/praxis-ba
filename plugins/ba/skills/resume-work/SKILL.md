---
name: resume-work
description: "Continue work in a new chat. Use when the user says to continue the task, pick up where it stopped, or resume. Finds the current Work Item, loads its saved state, tells the user where it stands and proposes the next step. Asks which one when several are candidates. Never claims to remember the earlier conversation."
---

# Resume work

If `praxis_doctor` is not available: stop with `PRAXIS_RUNTIME_UNAVAILABLE`.

1. `praxis_session_start` with `role: "ba"` (or `praxis_workflow_status`). Read `resume` / `briefing`.
2. If `selectionRequired` or `resume.choose` is set: list the Work Items (id, title, phase) and ask which to continue. Select it (`select-work-item`) or pass `workItemId` from then on. Never guess between candidates.
3. Tell the user, from the briefing only: the Work Item, its stage, what is accepted and what is pending (criteria, prototype, plan, stories), decisions, open questions, repositories, and the last session note.
4. Say plainly that the earlier chat is not restored: what was recorded in Praxis is available; anything that was only said in chat must be repeated.
5. Propose `next.summary` as the next step, using `next.skills`. Let the user confirm or change direction. Record what you did at the end of the session with `log-session` (summary and `nextAction`) so the next chat starts from it.

If there is no Work Item, start one (`local-workflow`).
