---
name: present-plan
description: Build and display an exact Praxis action plan before any protected BA mutation. Presenting the plan in Claude is UX only; authorization requires the independent broker.
---

# Present plan (BA)

Before `praxis_ba_apply`, story confirmation, or any issue-tracker write:

1. Build a `praxis.action.plan` with `decisionKind` set to the real decision type (`requirement_acceptance`, `story_behavior`, or `issue_tracker_mutation`).
2. Show the human the rendered plan (summary, provider, instance, stories, operations, risks).
3. Submit the plan to the broker inbox (`praxis-broker.mjs propose`).
4. Wait for broker approval. Do not treat a Claude "yes", tool hook, or JSON approval file as authorization.
5. Execute only with the signed broker token through the privileged executor / secure mutation path.

Architectural approvals must never set `confirmedBehavior`. Use `story_behavior` and the exact Story revision fingerprint for Story confirmation.
