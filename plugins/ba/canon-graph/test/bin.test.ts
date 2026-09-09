// ---- bin.test.ts: the ONE test that actually SPAWNS `bin/praxis-ba.mjs` as a
// real subprocess (execFileSync) — every other CLI test (`cli.test.ts`)
// calls `runCli()` in-process through vitest, which resolves `src/cli.ts`'s
// `.js` specifiers (`./ac.js`, `./ids.js`, …) down to their `.ts` siblings
// via vite-node's own resolver. That in-process path can never catch a
// packaging bug where the SHIPPED bin itself can't run: Node's
// `--experimental-strip-types` (the bin's old shebang) does NOT rewrite
// `.js` -> `.ts`, so spawning the real file looking for a `src/ac.js` that
// never exists threw `ERR_MODULE_NOT_FOUND` on literally the first command —
// invisible to every vitest-only suite in this package. This test builds
// `dist/` fresh (via the package's own `build` script, so it exercises the
// exact artifact a consumer would produce) and spawns the bin against it, so
// a future regression that breaks the build<->bin pairing fails LOUDLY here
// instead of shipping silently again.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const BIN_PATH = join(PACKAGE_ROOT, 'bin', 'praxis-ba.mjs')
const WORKSPACE_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const TSC_CANDIDATES = [
  join(PACKAGE_ROOT, "node_modules", ".bin", "tsc"),
  join(PACKAGE_ROOT, "..", "node_modules", ".bin", "tsc"),
  join(WORKSPACE_ROOT, "node_modules", ".bin", "tsc"),
]
const TSC_PATH = TSC_CANDIDATES.find((p) => existsSync(p))

let fixtureDir: string

// A build genuinely runs here (not skipped/mocked) so this test fails if the
// build itself breaks, not just if the bin's import path is wrong.
beforeAll(() => {
  if (!TSC_PATH) {
    throw new Error(
      `tsc not found in ${TSC_CANDIDATES.join(' or ')} — run npm install at workspace root`,
    )
  }
  execFileSync(TSC_PATH, ['-p', 'tsconfig.build.json'], { cwd: PACKAGE_ROOT, stdio: 'pipe' })

  // The smallest valid canon repo: just the `.ba/counters.yaml` ledger every
  // `loadGraph` call reads — mirrors cli.test.ts's own `makeRepo` fixture,
  // reproduced locally rather than imported (that helper lives in a
  // `../src`-importing test file; this file must stay fully decoupled from
  // in-process source imports to keep it an honest black-box subprocess
  // test).
  fixtureDir = mkdtempSync(join(tmpdir(), 'canon-bin-spawn-'))
  mkdirSync(join(fixtureDir, '.ba'), { recursive: true })
  writeFileSync(
    join(fixtureDir, '.ba', 'counters.yaml'),
    'product:\n  epic: 0\n  cr: 0\n  wp: 0\n  bug: 0\n  baselineSeq: {}\nepics: {}\nretired: []\n',
    'utf8'
  )
}, 60_000)

afterAll(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true })
})

describe('bin/praxis-ba.mjs spawned as a real subprocess against a freshly built dist/', () => {
  it('`status --repo <fixture>` exits 0 and prints a real VERIFY-OK Verdict', () => {
    const stdout = execFileSync('node', [BIN_PATH, 'status', '--repo', fixtureDir], { encoding: 'utf8' })
    expect(stdout).toContain('VERIFY-OK')
    expect(stdout).toMatch(/epics: 0 epic\(s\)/)
  })

  it('`validate --repo <fixture>` exits 0 on an empty-but-schema-valid repo', () => {
    const stdout = execFileSync('node', [BIN_PATH, 'validate', '--repo', fixtureDir], { encoding: 'utf8' })
    expect(stdout).toContain('VERIFY-OK')
    expect(stdout).toMatch(/schema-valid/)
  })

  it('an unknown command still exits non-zero (the bin surfaces a real VERIFY-FAIL, not a crash)', () => {
    expect(() => execFileSync('node', [BIN_PATH, 'bogus-verb', '--repo', fixtureDir], { encoding: 'utf8' })).toThrow()
  })
})
