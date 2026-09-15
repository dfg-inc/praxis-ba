Работаем через Praxis BA.

Epic:
{{EPIC}}

Repository:
{{REPO}}

Run:
- session-start;
- Jira Epic analysis;
- repository analysis;
- semantic requirements;
- User Stories;
- Acceptance Criteria;
- write `.praxis-jira/proposals/{{EPIC}}.json` (`contract: jira.ba.proposal`);
- machine preview (`make ba-preview`);
- human confirmation before writes;
- apply only with `--confirm YES`;
- BA → Architect handoff.

Do not invent Jira writes without approval.
Do not accept human product decisions yourself.
Ignore superseded duplicates except as audit.
