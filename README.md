# praxis-ba

Independent Praxis BA Skills plugin. Distribution: **`praxis-ba.zip`**.

Requires shared Runtime (`praxis-runtime.mcpb`). This repo does not ship an MCPB.

## Development / test / release

```bash
npm ci
npm run verify   # validate + BA acceptance + ZIP
```

- Artifact: `dist/claude-plugins/<version>/praxis-ba.zip`
- Core pins: tracked `vendor/*.tgz` (plugin-sdk, knowledge, project-config)
- Docs: `praxis-docs` → `docs/user/plugins/ba.md`
- Install: [GitLab Releases](https://gl.jetru.by/engineering/ai-tooling/praxis-ba/-/releases) (`praxis-ba.zip` + `release-meta.json`)
- CI: `validate`, `acceptance`, `pack_zip`; on tag `v$version` → `publish_release` (Generic Package Registry + Release)

