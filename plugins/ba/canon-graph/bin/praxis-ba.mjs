#!/usr/bin/env node
// ---- bin/praxis-ba.mjs: the thin CLI entrypoint (design spec §4.2) ----
//
// Zero flow/judgment lives here — every verb's logic is in `../src/cli.ts`'s
// `runCli`. This file's only job is: read argv, call `runCli`, print the
// result the way `--json` asks for, set the process exit code.
//
// **Runtime note (packaging, design spec §13):** this imports the COMPILED
// `../dist/cli.js`, not the TypeScript source — `src/cli.ts` (and its
// siblings) import each other with `.js` specifiers (`./ac.js`, `./ids.js`,
// …) written for real ESM/Node resolution post-build, not for Node's
// `--experimental-strip-types` (which does NOT rewrite `.js` -> `.ts`, so
// running this file straight against `src/` throws `ERR_MODULE_NOT_FOUND`
// looking for a `src/ac.js` that never exists). `pnpm --filter
// @praxis-ba/canon-graph build` (`tsc -p tsconfig.build.json`, `module`/
// `moduleResolution: nodenext` so those `.js` specifiers resolve correctly)
// must run before this file works — `test/bin.test.ts` builds `dist/` itself
// and spawns this exact file as a regression guard so a broken build/bin
// pairing can never go green silently again.
import { runCli } from '../dist/cli.js'

const argv = process.argv.slice(2)
const wantsJson = argv.includes('--json')

const { code, json } = await runCli(argv)

if (wantsJson) {
  console.log(JSON.stringify(json))
} else if (json.checks.length === 1 && ['prd', 'rtm', 'backlog', 'code-surface-scan'].includes(json.checks[0].name)) {
  // render/export: print the raw derived view, not the {verdict,checks} envelope.
  console.log(json.checks[0].reason)
} else {
  console.log(json.verdict)
  for (const c of json.checks) {
    console.log(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}: ${c.reason}`)
  }
  if (json.id) console.log(`id: ${json.id}`)
  if (json.path) console.log(`path: ${json.path}`)
  if (json.handoffPath) console.log(`handoffPath: ${json.handoffPath}`)
}

process.exitCode = code
