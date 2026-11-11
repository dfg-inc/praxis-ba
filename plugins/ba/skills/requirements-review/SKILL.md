---
name: requirements-review
description: "Review requirements and acceptance criteria with the user in a standard HTML page, one criterion at a time. Use when requirements exist and the user must accept, reject, edit, defer or remove them. The user decides in the page; you never record their acceptance yourself."
---

# Requirements review (HTML)

If `praxis_doctor` is not available: stop with `PRAXIS_RUNTIME_UNAVAILABLE`.

Stage: `requirements_review`. Role: BA.

## Flow

1. `praxis_workflow_status`. Read `phase`, `next` and `briefing`. If several Work Items exist and none is selected, ask which one.
2. Make sure every in-scope requirement has acceptance criteria. Add missing ones with `add-requirement` / `review-requirements` (edits are yours to make).
3. Call `praxis_review_render` with `view: "requirements"`. The Runtime opens the page in the user's browser (`openedInBrowser: true`); the address in the result is not a link you can use or share. If it could not open a browser, give the user the offline `file` and use step 5. Say what the page offers: a control for every criterion (accept / reject / comment), edit a requirement or a criterion by its id, add or remove criteria, move a requirement to *deferred* or *out of scope*, accept everything still undecided.
4. Wait for the user to press **Send for approval** in the page. That records nothing: it hands the decisions to you. Then call `praxis_review_apply` with `fromPage: true` and `view: "requirements"`. The client's dialog shows exactly those decisions, and only the user's approval there records them; when every criterion is accepted the review counts as accepted. Without a dialog (`APPROVAL_CLIENT_UI_REQUIRED`, Claude Desktop) nothing is recorded: say so, and the user applies the review from the Claude Code CLI. Do not tell the user their decisions were recorded until `praxis_workflow_status` shows them.
5. If the page could not send (no live connection), the user copies or downloads the decisions. Call `praxis_review_apply` with the JSON (`submission`) or the file path (`file`); the dialog asks the same way.
6. Read the result: `conflicts` lists items that changed after the page was rendered and were skipped. Tell the user and offer a fresh page (`praxis_review_render` again).
7. Rejected criteria and comments are your next work: reword a criterion with `revise-acceptance` (`edits: [{id, statement}]`; the user approves the wording in the client's dialog); `review-requirements` is for `addAcceptance`, `removeAcceptance`, `scope` and remarks. Then render again. A changed criterion is a new revision and is pending again; marks on other criteria stay.
8. When every in-scope criterion is accepted, `advance-phase` to `prototype`. A gate error names what is missing; do not work around it.

## Rules

- JSON stays internal. Never ask the user to read or edit JSON, and never paste it into the chat unless something failed.
- You cannot accept, reject or mark anything for the user. `accept-requirements` and marks sent through `praxis_workflow_apply` are refused with `USER_DECISION_REQUIRED`.
- The HTML file is a view, not a source of truth. Decisions exist only once `praxis_review_apply` recorded them after the user's approval in the dialog.
- Taking a requirement out of scope removes its stories and plan lines from what must be covered and stales earlier acceptances; say so.
- Requirement ids are stable. Never renumber.
