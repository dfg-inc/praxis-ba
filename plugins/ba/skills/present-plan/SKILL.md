---
name: present-plan
description: Show the user the exact BA action (preview) before any protected BA write, then let them approve or reject it in the client's own approval dialog. Praxis never treats the agent's own "yes" as the user's decision.
---

# Present plan (BA)

Action, preview, the user approves or rejects, execute, result.

Before `praxis_ba_apply`, story confirmation (`confirm-story`), or any issue-tracker write:

1. Preview with `praxis_ba_preview` or `praxis_workflow_preview`. The plan names the stories, provider, instance, operations and risks.
2. Show the user that plan, then apply (see below).
3. Confirming a Story is the user's act, not yours. Use the exact revision and `contentFingerprint` from `praxis_workflow_inspect` (`view=stories`); architectural approvals never set `confirmedBehavior`. Use `story_behavior` for Story confirmation.

Approval works the same way everywhere:

- **Preview, then ask.** Call the matching preview tool and show the user what it returned: the exact plan, nothing summarized away. Then call the apply tool with `confirmation=YES` and the `previewFingerprint` from that preview. `confirmation=YES` only says you want to apply what was previewed; it is **not** the user's approval. Praxis asks the user itself and runs the action only if they approve. To show the user exactly what they will be asked, call `praxis_approval_plan` (read-only) with the apply tool's name and arguments; nothing you pass back from it approves anything.
- **Where the user is asked: only in the client's own approval dialog.** `praxis_doctor` reports `approval.mode`: `client-ui` (the dialog works, for example the Claude Code CLI in a terminal) or `no-dialog`. `no-dialog` covers Claude Desktop Chat and Cowork (no dialog), the Desktop Code tab (it answers the dialog by itself) and a dialog that a setting answers automatically (listed in `approval.dialogAutomation`). There, protected actions are not executed: previews, reviews and read-only tools keep working, and the user applies protected actions from the Claude Code CLI in a terminal. No page, standing permission or setting replaces the dialog.
- **What an approval proves.** A dialog answer is a client response. Praxis records which channel answered (`data.approval[].decidedBy`: `client-dialog` or `terminal-prompt`) with `personVerified: false`. It is not independently authenticated human authorization; never present it as proof that a person approved.
- **Read the result code. Each one means exactly one thing:**
  - success: it was approved in the client's dialog. Say what ran and that it was approved there.
  - `APPROVAL_REJECTED`: it was rejected in the client's dialog. Say so, and ask what they want instead. Do not apply the same plan again.
  - `APPROVAL_DISMISSED`: the user closed the dialog without deciding. It is not a rejection: ask whether to try again.
  - `APPROVAL_TIMED_OUT` or `APPROVAL_EXPIRED`: nobody answered in time. Not a rejection: apply again only if the user wants to.
  - `APPROVAL_CLIENT_UI_REQUIRED`: Praxis could not ask the user here (`data.outcome`: `unavailable`, or `auto-answered` when the client answered its own dialog in milliseconds; the reason names a hook or setting when one answers the dialog automatically). Nothing ran and **nobody rejected it**. Show the user the preview (`data.preview`), say plainly that it was not applied and why, and do not try the same route again: it gives the same answer. Do not ask the user to type "yes" as a substitute. It can be applied from a client whose dialog is shown, such as the Claude Code CLI in a terminal, with nothing configured to answer the dialog.
  - `APPROVAL_WITHDRAWN`: you passed `confirmation=NO`. It is your withdrawal, not the user's decision.
- **Never attribute a decision to the user without evidence.** Only an answer from the client's dialog counts as the user's decision, and even then Praxis records `personVerified: false`. A refusal, a timeout, a client's automatic answer or your own `confirmation=NO` is not the user's decision; never call it "rejected by the user", in chat, in workflow records, notes or handoffs.
- **If the user tells you in chat that they do not want it**, do not apply it. `confirmation=NO` withdraws a pending request; it is recorded as your withdrawal, never as their rejection.
- **Review decisions** (accepting requirements, the prototype, the plan or stories, and the user's remarks on them) are the user's own. In the HTML review page (`praxis_review_render`) the user presses **Send for approval**, which records nothing. Then call `praxis_review_apply` with `fromPage: true` and the `view`: the client's dialog shows exactly those decisions, and only the user's approval there records them. A decisions file or pasted JSON (`file`, `submission`) goes the same way. Without a dialog (`APPROVAL_CLIENT_UI_REQUIRED`) nothing is recorded: say so, and the user applies the review from the CLI.
- **Your "yes" is not theirs.** Never write approval files, settings, hooks, tokens or approval-looking arguments. Never answer a dialog yourself, configure anything that answers it (a Claude Code `Elicitation` hook, for example), start a client of your own to answer it, or operate a review page. None of it authorizes anything, and Praxis refuses a dialog that is configured to be answered automatically.
- **A changed plan needs a new preview and a new approval.** An approval covers one action and exactly the content that was shown.
- **Earlier records.** An older Praxis may have recorded the agent's `confirmation=NO`, or a client's automatic decline, as the user's rejection. `praxis_approval_journal` lists such entries; with `amend=true` and `confirmation=YES` it appends a correction for each after the user approves that list. It never changes an existing line.
- **Removed in 0.1.0-alpha.49.2:** `planText`, the host-permission and Trusted Client modes, and the approval page. If the user asks for them, explain that a setting an agent or a repository can write cannot stand in for their approval.
- **Since 0.1.0-alpha.49.3,** an acceptance in the Work Item file counts only when Praxis's decision record (outside the repository) backs it. `praxis_workflow_status` and `praxis_workflow_inspect` show `unverified` or `invalid` for one that is not: accepted before the update, on another computer, or written into the file. Never edit the file to restore it, and never report it as accepted: ask the user to accept it again in the review, where the client's dialog shows exactly what they accept.
