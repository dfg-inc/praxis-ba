# praxis-ba

Independent Praxis BA Skills plugin. Distribution: **`praxis-ba.zip`**.

Requires shared Runtime ([`praxis-runtime.mcpb`](https://github.com/dfg-inc/praxis-runtime/releases)). This repo does not ship an MCPB.

## Clone / develop

```bash
git clone https://github.com/dfg-inc/praxis-ba.git
cd praxis-ba
npm ci
npm run verify   # validate + BA acceptance + ZIP
```

## Install

Download from [Releases](https://github.com/dfg-inc/praxis-ba/releases): `praxis-ba.zip` + `release-meta.json`.

## Release

- Artifact: `dist/claude-plugins/<version>/praxis-ba.zip`
- Core pins: tracked `vendor/*.tgz`. Update them only when this plugin needs a newer Core: `node tools/scripts/set-ecosystem-version.mjs --vendor <core-version>`.
- This plugin's version is independent of Core, Runtime, and the other role plugins. `ecosystem.json` records it (`policy: independent`).
- Tag `v$version` on GitLab first. After that tag pipeline passes, GitHub Actions publishes the ZIP.
