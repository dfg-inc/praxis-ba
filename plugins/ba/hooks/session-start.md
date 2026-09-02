# Session-start hook (BA)

At the beginning of a BA session, run the bootstrap script so role/stage rules
and `.project` status are visible before other skills:

```
node ${CLAUDE_PLUGIN_ROOT}/tools/session-bootstrap.mjs
```

Equivalent skill: `session-start`. Role `ba`, stage `research`. Uses shared
`@praxis/plugin-sdk.bootstrapSession()` (bundled into `session-bootstrap.cjs` in
release artifacts). Does not invent a Knowledge path when `knowledge.path` is unset.
