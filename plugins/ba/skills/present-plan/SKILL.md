---
name: present-plan
description: Show the user the exact BA action (preview) before any protected BA write, then let them approve or reject it in the MCP client. Praxis never treats the agent's own "yes" as the user's decision.
---

# Present plan (BA)

Action, preview, the user approves or rejects, execute, result.

Before `praxis_ba_apply`, story confirmation (`confirm-story`), or any issue-tracker write:

1. Preview with `praxis_ba_preview` or `praxis_workflow_preview`. The plan names the stories, provider, instance, operations and risks.
2. Show the user that plan, then apply (see below).
3. Confirming a Story is the user's act, not yours. Use the exact revision and `contentFingerprint` from `praxis_workflow_inspect` (`view=stories`); architectural approvals never set `confirmedBehavior`. Use `story_behavior` for Story confirmation.

Approval works the same way everywhere:

- **Preview, then ask.** Call the matching preview tool and show the user what it returned: the exact plan, nothing summarized away. Then call the apply tool with `confirmation=YES` and the `previewFingerprint` from that preview. Praxis asks the user in the MCP client's own approval dialog, which shows the same plan. **Approve** runs exactly that action. **Reject** or dismissing the dialog runs nothing and the tool returns `APPROVAL_REJECTED`.
- **A client without that dialog.** `praxis_doctor` reports `approval.mode`. When it is `unverified-fallback`, ask the user in chat and call apply with `confirmation=YES` only after they said yes; if they said no, call it with `confirmation=NO` (it records the rejection and runs nothing). Praxis marks such an approval `unverified` and says so in the result: repeat that in your report, never present it as verified.
- **Your "yes" is not theirs.** Never write approval files, tokens or approval-looking arguments, and never answer a dialog yourself: they authorize nothing.
- **A changed plan needs a new preview and a new approval.** An approval covers one action and exactly the content that was shown.
