// ---- migrate.test.ts: v1 JSON->md codemod + parity checker (Task 13) ----
//
// The fixture (`test/fixtures/product.snapshot.json`) is a curated, faithful
// subset of a real v1 `product/` corpus (mirrors the real field names of
// `product.json` / `br-registry.json` / `cr/*.json` / `baselines/*.json` /
// `work-packages/WP-*.{json,md}` — verified against the actual repo's files
// during this task). `writeV1Corpus` below explodes that single JSON blob
// into an on-disk directory laid out exactly like the real `product/` tree,
// so `migrate(v1Dir, outDir)` operates on the same directory/file shapes it
// will see in the real migration (Plan 2) — this task only proves the codemod
// + parity checker against a small, readable snapshot, never touches the
// real `product/` tree.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { parse as yamlParse } from 'yaml'
import { describe, it, expect, afterEach } from 'vitest'
import { migrate, verifyParity } from '../src/migrate'
import { parseFile } from '../src/parse'
import { loadGraph } from '../src/writer'
import { runCli } from '../src/cli'

// ---- fixture explosion ----

type V1Snapshot = {
  product: unknown
  brRegistry: unknown
  crs: Array<{ id: string } & Record<string, unknown>>
  baselines: Array<{ baseline_id: string } & Record<string, unknown>>
  workPackages: Array<
    | { kind: 'json'; filename: string; data: Record<string, unknown> }
    | { kind: 'md'; filename: string; frontmatter: Record<string, unknown>; body: string }
  >
}

function loadSnapshot(): V1Snapshot {
  const raw = readFileSync(join(__dirname, 'fixtures', 'product.snapshot.json'), 'utf8')
  return JSON.parse(raw) as V1Snapshot
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

function frontmatterBlock(fm: Record<string, unknown>): string {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
  return lines.join('\n')
}

/** Writes the curated snapshot out as a real v1 directory tree — the same
 * shape `migrate`/`verifyParity` will read from a real `product/` dir. */
function writeV1Corpus(snapshot: V1Snapshot): string {
  const dir = makeTempDir('canon-migrate-v1-')
  writeJson(join(dir, 'product.json'), snapshot.product)
  writeJson(join(dir, 'br-registry.json'), snapshot.brRegistry)
  for (const cr of snapshot.crs) writeJson(join(dir, 'cr', `${cr.id}.json`), cr)
  for (const baseline of snapshot.baselines) {
    writeJson(join(dir, 'baselines', `${baseline.baseline_id}.json`), baseline)
  }
  for (const wp of snapshot.workPackages) {
    const path = join(dir, 'work-packages', wp.filename)
    mkdirSync(join(dir, 'work-packages'), { recursive: true })
    if (wp.kind === 'json') {
      writeFileSync(path, `${JSON.stringify(wp.data, null, 2)}\n`, 'utf8')
    } else {
      writeFileSync(path, `---\n${frontmatterBlock(wp.frontmatter)}\n---\n\n${wp.body}`, 'utf8')
    }
  }
  return dir
}

function makeOutDir(): string {
  return makeTempDir('canon-migrate-out-')
}

// ==========================================================================
// Step 1 (TDD RED): the brief's minimum test matrix.
// ==========================================================================

describe('migrate', () => {
  it('emits an md page for every FR/NFR/BR/CR/baseline id in the v1 JSON', () => {
    const v1Dir = writeV1Corpus(loadSnapshot())
    const outDir = makeOutDir()

    const { written } = migrate(v1Dir, outDir)

    const expectedPaths = [
      join(outDir, 'epics', 'E1-foundation-access', 'E1-FR1.md'),
      join(outDir, 'epics', 'E1-foundation-access', 'E1-FR2.md'),
      join(outDir, 'epics', 'E1-foundation-access', 'E1-NFR1.md'),
      join(outDir, 'br', 'E1-BR1.md'),
      join(outDir, 'cr', 'CR-001.md'),
      join(outDir, 'wp', 'WP-20260708-002.md'),
      join(outDir, 'wp', 'WP-20260711-005.md'),
      join(outDir, 'baselines', 'BL-20260708', 'manifest.yaml'),
    ]
    for (const path of expectedPaths) {
      expect(written).toContain(path)
      expect(existsSync(path)).toBe(true)
    }
  })

  it('seeds .ba/counters.yaml from v1 _counters', () => {
    const v1Dir = writeV1Corpus(loadSnapshot())
    const outDir = makeOutDir()

    migrate(v1Dir, outDir)

    const countersPath = join(outDir, '.ba', 'counters.yaml')
    expect(existsSync(countersPath)).toBe(true)
    const raw = readFileSync(countersPath, 'utf8')
    expect(raw).toContain('epic: 1')
    expect(raw).toContain('wp: 5')
  })

  it('seeds .ba/config.yaml whose canon_roots cover every emitted canon page (canon-path scoping)', () => {
    const v1Dir = writeV1Corpus(loadSnapshot())
    const outDir = makeOutDir()

    const { written } = migrate(v1Dir, outDir)

    const configPath = join(outDir, '.ba', 'config.yaml')
    expect(existsSync(configPath)).toBe(true)
    const config = yamlParse(readFileSync(configPath, 'utf8')) as { canon_roots: string[] }
    expect(Array.isArray(config.canon_roots)).toBe(true)

    // Every emitted PAGE (excluding the two machine ledgers themselves,
    // .ba/counters.yaml and .ba/config.yaml, and the baseline manifest,
    // which is deliberately NOT a scannable canon root — see migrate.ts's
    // `MIGRATED_CANON_ROOTS` comment) must fall under one of the seeded
    // roots — proving the config is a genuine covering set for what this
    // run actually wrote, not just a guess.
    const coveredExtensions = ['.ba/counters.yaml', '.ba/config.yaml']
    const isUnderARoot = (relPath: string): boolean =>
      config.canon_roots.some((root) => relPath === root.replace(/\/$/, '') || relPath.startsWith(root.replace(/\/$/, '') + '/'))
    for (const path of written) {
      const relPath = relative(outDir, path).split('\\').join('/')
      if (coveredExtensions.includes(relPath)) continue
      if (relPath.startsWith('baselines/')) continue // frozen manifests: never a canon root, by design
      expect(isUnderARoot(relPath)).toBe(true)
    }

    // And the standard canon locations this particular fixture run doesn't
    // populate (this snapshot's v1 dir has no vision.md, and v1 has no
    // bug-tracking concept at all) are still listed, so the CLI's own
    // `bug capture`/`vision confirm` are scoped correctly without a
    // follow-up config edit.
    expect(config.canon_roots).toContain('vision.md')
    expect(config.canon_roots).toContain('bugs/')
    expect(config.canon_roots).not.toContain('baselines/')
  })

  it('backfills a derivable CR trace directly into traces_to, with no provenance stamp', () => {
    const v1Dir = writeV1Corpus(loadSnapshot())
    const outDir = makeOutDir()
    migrate(v1Dir, outDir)

    const parsed = parseFile(join(outDir, 'epics', 'E1-foundation-access', 'E1-FR1.md'), 'fr')
    if ('error' in parsed) throw new Error(`fixture FR failed to parse: ${parsed.error}`)
    const fm = parsed.frontmatter as { traces_to: string[]; provenance?: string; status: string; baseline?: string }
    expect(fm.traces_to).toEqual(['CR-001'])
    expect(fm.provenance).toBeUndefined()
    expect(fm.status).toBe('baselined')
    expect(fm.baseline).toBe('BL-20260708')
  })

  it('stamps provenance: migrated on a FR whose goal-trace is prose-only (no structured CR ref)', () => {
    const v1Dir = writeV1Corpus(loadSnapshot())
    const outDir = makeOutDir()
    migrate(v1Dir, outDir)

    const parsed = parseFile(join(outDir, 'epics', 'E1-foundation-access', 'E1-FR2.md'), 'fr')
    if ('error' in parsed) throw new Error(`fixture FR failed to parse: ${parsed.error}`)
    const fm = parsed.frontmatter as { traces_to: string[]; provenance?: string }
    expect(fm.traces_to).toEqual([])
    expect(fm.provenance).toBe('migrated')
  })

  it('numbers v1 acceptance_criteria into the AC-N grammar in order', () => {
    const v1Dir = writeV1Corpus(loadSnapshot())
    const outDir = makeOutDir()
    migrate(v1Dir, outDir)

    const parsed = parseFile(join(outDir, 'epics', 'E1-foundation-access', 'E1-FR1.md'), 'fr')
    if ('error' in parsed) throw new Error(`fixture FR failed to parse: ${parsed.error}`)
    expect(parsed.acs.map((ac) => ac.acId)).toEqual([1, 2])
    expect(parsed.acs[0]?.text).toContain('argon2id-hashed')
  })

  it('transcribes WP fr_ids 1:1 from both the older sibling-.json style and the newer frontmatter style', () => {
    const v1Dir = writeV1Corpus(loadSnapshot())
    const outDir = makeOutDir()
    migrate(v1Dir, outDir)

    // v3 (Task 4): a migrated WP's FR scope lives in the body's `## Scope` /
    // `### Delivers` link list (scopelinks.ts's `parseScope`), not
    // frontmatter — read it via `graph.wpDelivers`, not `.frontmatter.fr_ids`
    // (which no longer exists on wpSchema at all).
    const graph = loadGraph(outDir)
    expect(graph.wpDelivers('WP-20260708-002')).toEqual(['E1-FR1'])
    expect(graph.wpDelivers('WP-20260711-005')).toEqual(['E1-FR2'])
  })

  // ------------------------------------------------------------------------
  // readWps real-data bug (caught running migrate on the real product/):
  // every WP with BOTH a .json and a .md sibling was being read from BOTH
  // (double-counted), and a v1 `ba-flow` frontmatter defect in a real WP .md
  // (an unquoted colon inside a free-text field — `prepared_for: amount
  // card: inline arithmetic + full field set (M1)`) crashes the strict
  // eemeli YAML parser and fails the WHOLE migration. Fix: key by WP id,
  // prefer the clean, authoritative .json sibling when one exists (never
  // even attempting to parse the .md in that case), falling back to the .md
  // frontmatter only for ids with no .json sibling at all.
  // ------------------------------------------------------------------------

  it('prefers the .json sibling over a malformed .md frontmatter, instead of crashing the whole migration', () => {
    const v1Dir = writeV1Corpus(loadSnapshot())
    const outDir = makeOutDir()

    // A real v1 defect: an unquoted colon inside `prepared_for`'s value
    // makes the strict eemeli YAML parser see a nested (compact) mapping
    // and throw — this .md must never be parsed when its .json sibling
    // already carries everything a v2 WP page needs.
    writeFileSync(
      join(v1Dir, 'work-packages', 'WP-20260709-004.md'),
      '---\nwp_id: WP-20260709-004\nrole: developer\nprepared_for: amount card: inline arithmetic + full field set (M1)\nfr_ids:\n  - E1-FR2\n---\n\nBody.\n',
      'utf8'
    )
    writeJson(join(v1Dir, 'work-packages', 'WP-20260709-004.json'), {
      wp_id: 'WP-20260709-004',
      role: 'developer',
      prepared_date: '2026-07-09',
      fr_ids: ['E1-FR1'],
    })

    const { written } = migrate(v1Dir, outDir) // must not throw

    const wpPath = join(outDir, 'wp', 'WP-20260709-004.md')
    expect(written.filter((p) => p === wpPath)).toHaveLength(1)
    const parsed = parseFile(wpPath, 'wp')
    if ('error' in parsed) throw new Error(parsed.error)
    // fr_ids come from the .json (E1-FR1), never the malformed-but-unparsed
    // .md (which — had it been read — would have said E1-FR2). Read via the
    // Scope-body `wpDelivers` query (v3, Task 4), not frontmatter.
    expect(loadGraph(outDir).wpDelivers('WP-20260709-004')).toEqual(['E1-FR1'])

    const verdict = verifyParity(v1Dir, outDir)
    expect(verdict.verdict).toBe('VERIFY-OK')
  })

  it('dedupes a WP present as both .json and a well-formed .md, emitting it exactly once (.json wins)', () => {
    const v1Dir = writeV1Corpus(loadSnapshot())
    const outDir = makeOutDir()

    writeJson(join(v1Dir, 'work-packages', 'WP-20260710-003.json'), {
      wp_id: 'WP-20260710-003',
      role: 'developer',
      prepared_date: '2026-07-10',
      fr_ids: ['E1-FR1'],
    })
    writeFileSync(
      join(v1Dir, 'work-packages', 'WP-20260710-003.md'),
      `---\n${frontmatterBlock({
        wp_id: 'WP-20260710-003',
        role: 'developer',
        prepared_date: '2026-07-10',
        product_id: 'PRODUCT-001',
        fr_ids: ['E1-FR2'], // deliberately different from the .json, to prove precedence
        status: 'draft',
      })}\n---\n\nBody.\n`,
      'utf8'
    )

    const { written } = migrate(v1Dir, outDir)

    const wpPath = join(outDir, 'wp', 'WP-20260710-003.md')
    expect(written.filter((p) => p === wpPath)).toHaveLength(1) // not pushed/written twice
    const parsed = parseFile(wpPath, 'wp')
    if ('error' in parsed) throw new Error(parsed.error)
    expect(loadGraph(outDir).wpDelivers('WP-20260710-003')).toEqual(['E1-FR1']) // .json wins over .md

    const verdict = verifyParity(v1Dir, outDir)
    expect(verdict.verdict).toBe('VERIFY-OK')
  })

  it('still reads a .md-only WP (no .json sibling) from its frontmatter', () => {
    const v1Dir = writeV1Corpus(loadSnapshot())
    const outDir = makeOutDir()

    writeFileSync(
      join(v1Dir, 'work-packages', 'WP-20260712-006.md'),
      `---\n${frontmatterBlock({
        wp_id: 'WP-20260712-006',
        role: 'qa',
        prepared_date: '2026-07-12',
        product_id: 'PRODUCT-001',
        fr_ids: ['E1-FR1'],
        status: 'draft',
      })}\n---\n\nBody.\n`,
      'utf8'
    )

    const { written } = migrate(v1Dir, outDir)

    const wpPath = join(outDir, 'wp', 'WP-20260712-006.md')
    expect(written.filter((p) => p === wpPath)).toHaveLength(1)
    const parsed = parseFile(wpPath, 'wp')
    if ('error' in parsed) throw new Error(parsed.error)
    expect(loadGraph(outDir).wpDelivers('WP-20260712-006')).toEqual(['E1-FR1'])
    expect((parsed.frontmatter as { role: string }).role).toBe('qa')
  })

  it('skips a br-typed duplicate entry in requirement_db (authoritative BR content comes from br-registry.json only)', () => {
    const snapshot = loadSnapshot()
    const product = snapshot.product as { requirement_db: Array<Record<string, unknown>> }
    // Real v1 data anomaly (seen on the actual product/product.json): every
    // BR also has a redundant `type: 'br'` entry duplicated into
    // `requirement_db`, alongside its authoritative definition in
    // br-registry.json. That duplicate has NO `kind`/`enforcement` (those
    // fields only ever exist on br-registry.json's own `V1Rule` shape) —
    // the fr/nfr emit loop's only two branches (fr vs "everything else")
    // would misbuild it as an nfr-shaped frontmatter still tagged
    // `type: 'br'`, which then fails brSchema's required fields.
    product.requirement_db.push({
      id: 'E1-BR1',
      type: 'br',
      epic_id: 'E1',
      status: 'active',
      current: {
        version: 'v1',
        text: 'duplicate br text from requirement_db — must never be emitted',
        acceptance_criteria: [],
        date: '2026-07-08',
        cr_ref: null,
      },
      past: [],
      baseline_ref: null,
      cr_refs: [],
    })

    const v1Dir = writeV1Corpus(snapshot)
    const outDir = makeOutDir()

    const { written } = migrate(v1Dir, outDir) // must not throw

    const brPath = join(outDir, 'br', 'E1-BR1.md')
    expect(written.filter((p) => p === brPath)).toHaveLength(1) // emitted once, by br-registry.json's rule only
    const parsed = parseFile(brPath, 'br')
    if ('error' in parsed) throw new Error(parsed.error)
    expect(parsed.body).not.toContain('duplicate br text') // never sourced from the requirement_db duplicate

    const verdict = verifyParity(v1Dir, outDir)
    expect(verdict.verdict).toBe('VERIFY-OK')
  })

  it("reconciles a same-day baseline-id collision by recovering an item's own baseline_ref even when the baseline file's frozen_requirement_ids was clobbered", () => {
    const snapshot = loadSnapshot()
    const product = snapshot.product as { requirement_db: Array<Record<string, unknown>> }
    // Real v1 defect, traced to ba-flow.js's `accept()` handler: the
    // baseline id is minted as a plain calendar-date string
    // (`BL-${today()}`, no per-accept sequence) and each accept
    // unconditionally overwrites `baselines/<id>.json` with THAT accept's
    // own `frozen_requirement_ids`. Two DIFFERENT WPs accepted on the SAME
    // day collide onto the same baseline id, and the later accept's write
    // clobbers the earlier one's item list in the FILE — but every
    // requirement's own `baseline_ref` is stamped unconditionally,
    // per-item, and survives. Here `E1-FR9` reproduces the "earlier,
    // clobbered" accept: its `baseline_ref` names `BL-20260708` (the
    // fixture's existing baseline), but that baseline's own
    // `frozen_requirement_ids` (see the fixture) lists only `E1-FR1` — the
    // winner of the collision.
    product.requirement_db.push({
      id: 'E1-FR9',
      type: 'fr',
      epic_id: 'E1',
      status: 'baseline',
      current: {
        version: 'v1',
        text: 'a requirement frozen by an earlier same-day accept whose baseline file entry got clobbered',
        acceptance_criteria: [],
        date: '2026-07-08',
        cr_ref: null,
      },
      past: [],
      baseline_ref: 'BL-20260708', // collides with the fixture's existing baseline id
      cr_refs: [],
    })

    const v1Dir = writeV1Corpus(snapshot)
    const outDir = makeOutDir()

    migrate(v1Dir, outDir)

    const manifestPath = join(outDir, 'baselines', 'BL-20260708', 'manifest.yaml')
    const manifest = yamlParse(readFileSync(manifestPath, 'utf8')) as { items: Array<{ id: string }> }
    // Recovers E1-FR9 even though BL-20260708.json's own frozen_requirement_ids
    // never listed it — reconciled from E1-FR9's own baseline_ref stamp.
    expect(manifest.items.map((i) => i.id).sort()).toEqual(['E1-FR1', 'E1-FR9'])

    const verdict = verifyParity(v1Dir, outDir)
    expect(verdict.verdict).toBe('VERIFY-OK')
  })
})

// ==========================================================================
// vision emission (gap fix): `migrate` seeds `.ba/config.yaml`'s
// `canon_roots` with `vision.md`, but never actually emitted one — so a
// pre-existing v1 `product/vision.md` (v1 frontmatter: status/created/
// confirmed/confirmed_by/cr/confirm_with_kate, no `type` field at all)
// survived migration completely untouched and then HARD-failed
// `validate`'s `schema-valid` check (`visionSchema` requires
// `type: z.literal('vision')`, which a v1 file never has). Reproduced here
// with the real corpus's own field shape (see product/vision.md).
// ==========================================================================

describe('migrate — vision emission (gap fix)', () => {
  const V1_VISION_BODY = [
    '# Vision — budget-scout',
    '',
    '**Objective.** Ship the EU market drag-and-drop personal-finance tracker.',
    '',
    '## Acceptance criteria',
    '',
    '- **AC1** — median app-open→saved-transaction ≤3s (p50).',
    '',
  ].join('\n')

  function writeV1VisionMd(v1Dir: string): void {
    const frontmatter = [
      '---',
      'status: confirmed',
      'created: 2026-07-08',
      'confirmed: 2026-07-08',
      'confirmed_by: Alex (product owner) — grill interview + explicit "Confirm", session 1',
      'cr: CR-001',
      'confirm_with_kate: true',
      '---',
    ].join('\n')
    // Fence, then a blank line, then the body — exactly the real corpus's
    // own `product/vision.md` layout (see the file's own frontmatter/body
    // split): gray-matter's `content` keeps that blank line as part of the
    // (opaque) body.
    writeFileSync(join(v1Dir, 'vision.md'), `${frontmatter}\n\n${V1_VISION_BODY}`, 'utf8')
  }

  it('emits <out>/vision.md as a valid v2 vision page, body preserved verbatim, when v1Dir has a vision.md', async () => {
    const v1Dir = writeV1Corpus(loadSnapshot())
    writeV1VisionMd(v1Dir)
    const outDir = makeOutDir()

    const { written } = migrate(v1Dir, outDir)

    const visionPath = join(outDir, 'vision.md')
    expect(written).toContain(visionPath)
    expect(existsSync(visionPath)).toBe(true)

    const parsed = parseFile(visionPath, 'vision')
    if ('error' in parsed) throw new Error(`migrated vision failed to parse: ${parsed.error}`)
    // v1-only fields (created/confirmed/confirmed_by/cr/confirm_with_kate)
    // are dropped, not fabricated into v2 fields that don't exist —
    // v2's minimal vision schema is just {type, status}.
    expect(parsed.frontmatter).toEqual({ type: 'vision', status: 'confirmed' })
    // Body carried over verbatim (gray-matter's content includes the blank
    // line right after the closing frontmatter fence — never reflowed).
    expect(parsed.body).toBe(`\n${V1_VISION_BODY}`)

    // validate (over the whole out dir, not just this one file) must not
    // reject the migrated vision — this is the exact real-corpus failure
    // this fix closes (`schema-valid` HARD-failing on an un-typed vision.md).
    const result = await runCli(['validate'], { repo: outDir })
    const schemaValid = result.json.checks.find((c) => c.name === 'schema-valid')
    expect(schemaValid?.ok).toBe(true)
    expect(schemaValid?.reason ?? '').not.toContain('vision.md')

    // loadGraph (the other consumer named in the task) must not throw either.
    expect(() => loadGraph(outDir)).not.toThrow()
  })

  it('maps an unrecognized/missing v1 vision status to confirmed (never silently drafts a settled vision)', () => {
    const v1Dir = writeV1Corpus(loadSnapshot())
    writeFileSync(
      join(v1Dir, 'vision.md'),
      '---\nstatus: something-v1-specific\n---\n\n# Vision — x\n\nBody.\n',
      'utf8'
    )
    const outDir = makeOutDir()

    migrate(v1Dir, outDir)

    const parsed = parseFile(join(outDir, 'vision.md'), 'vision')
    if ('error' in parsed) throw new Error(parsed.error)
    expect((parsed.frontmatter as { status: string }).status).toBe('confirmed')
  })

  it('passes a v1 draft status through unchanged', () => {
    const v1Dir = writeV1Corpus(loadSnapshot())
    writeFileSync(join(v1Dir, 'vision.md'), '---\nstatus: draft\n---\n\n# Vision — x\n\nBody.\n', 'utf8')
    const outDir = makeOutDir()

    migrate(v1Dir, outDir)

    const parsed = parseFile(join(outDir, 'vision.md'), 'vision')
    if ('error' in parsed) throw new Error(parsed.error)
    expect((parsed.frontmatter as { status: string }).status).toBe('draft')
  })

  it('skips vision emission (not a failure) when v1Dir has no vision.md at all', () => {
    const v1Dir = writeV1Corpus(loadSnapshot()) // snapshot fixture never writes vision.md
    const outDir = makeOutDir()

    const { written } = migrate(v1Dir, outDir) // must not throw

    expect(existsSync(join(outDir, 'vision.md'))).toBe(false)
    expect(written).not.toContain(join(outDir, 'vision.md'))
  })

  it('is safe in-place (v1Dir === outDir): reads the v1 vision before overwriting it with the v2 page', () => {
    const dir = writeV1Corpus(loadSnapshot())
    writeV1VisionMd(dir)

    const { written } = migrate(dir, dir)

    const visionPath = join(dir, 'vision.md')
    expect(written).toContain(visionPath)
    const parsed = parseFile(visionPath, 'vision')
    if ('error' in parsed) throw new Error(`migrated vision failed to parse: ${parsed.error}`)
    expect(parsed.frontmatter).toEqual({ type: 'vision', status: 'confirmed' })
    expect(parsed.body).toBe(`\n${V1_VISION_BODY}`)
  })

  it('does not affect verifyParity (vision is not in its id-set/content-hash checks) — stays VERIFY-OK', () => {
    const v1Dir = writeV1Corpus(loadSnapshot())
    writeV1VisionMd(v1Dir)
    const outDir = makeOutDir()

    migrate(v1Dir, outDir)

    const verdict = verifyParity(v1Dir, outDir)
    expect(verdict.verdict).toBe('VERIFY-OK')
  })
})

describe('verifyParity', () => {
  it('returns VERIFY-OK on a clean migration', () => {
    const v1Dir = writeV1Corpus(loadSnapshot())
    const outDir = makeOutDir()
    migrate(v1Dir, outDir)

    const verdict = verifyParity(v1Dir, outDir)

    expect(verdict.verdict).toBe('VERIFY-OK')
    expect(verdict.checks.every((c) => c.ok)).toBe(true)
  })

  it('returns VERIFY-FAIL when an emitted FR statement is reworded post-migration (content-hash catch)', () => {
    const v1Dir = writeV1Corpus(loadSnapshot())
    const outDir = makeOutDir()
    migrate(v1Dir, outDir)

    const frPath = join(outDir, 'epics', 'E1-foundation-access', 'E1-FR2.md')
    const original = readFileSync(frPath, 'utf8')
    const reworded = original.replace('privacy-conscious new user', 'somewhat-different reworded user')
    expect(reworded).not.toBe(original)
    writeFileSync(frPath, reworded, 'utf8')

    const verdict = verifyParity(v1Dir, outDir)

    expect(verdict.verdict).toBe('VERIFY-FAIL')
    const failing = verdict.checks.find((c) => !c.ok)
    expect(failing).toBeDefined()
    expect(failing?.name).toBe('fr-content-hash')
    expect(failing?.reason).toContain('E1-FR2')
  })

  it('fails id set-equality when a page is missing from the output', () => {
    const v1Dir = writeV1Corpus(loadSnapshot())
    const outDir = makeOutDir()
    migrate(v1Dir, outDir)

    rmSync(join(outDir, 'br', 'E1-BR1.md'))

    const verdict = verifyParity(v1Dir, outDir)

    expect(verdict.verdict).toBe('VERIFY-FAIL')
    const brCheck = verdict.checks.find((c) => c.name === 'br-ids')
    expect(brCheck?.ok).toBe(false)
    expect(brCheck?.reason).toContain('E1-BR1')
  })

  it('fails the baseline-frozen-ids check when the manifest is missing an item', () => {
    const v1Dir = writeV1Corpus(loadSnapshot())
    const outDir = makeOutDir()
    migrate(v1Dir, outDir)

    // A schema-VALID manifest (`items` needs >=1 element) whose one item
    // doesn't name the id v1's baseline actually froze — exercises the
    // frozen-id-list MISMATCH path distinctly from a missing/malformed file.
    const manifestPath = join(outDir, 'baselines', 'BL-20260708', 'manifest.yaml')
    writeFileSync(
      manifestPath,
      `id: BL-20260708\ndate: '20260708'\nwp_ids: [WP-20260708-002]\ntriggered_by: WP-20260708-002\nitems:\n  - id: E1-FR2\n    version: 1\n    content_hash: deadbeef\naccepted_by: migrated-from-v1\nverify_evidence_ref: migrated-from-v1\n`,
      'utf8'
    )

    const verdict = verifyParity(v1Dir, outDir)

    expect(verdict.verdict).toBe('VERIFY-FAIL')
    const baselineCheck = verdict.checks.find((c) => c.name === 'baseline-frozen-ids')
    expect(baselineCheck?.ok).toBe(false)
  })

  it('fails the wp-fr-ids check when a migrated WP fr_ids no longer matches v1', () => {
    const v1Dir = writeV1Corpus(loadSnapshot())
    const outDir = makeOutDir()
    migrate(v1Dir, outDir)

    const parsed = parseFile(join(outDir, 'wp', 'WP-20260708-002.md'), 'wp')
    if ('error' in parsed) throw new Error(parsed.error)
    // Overwrite with fr_ids emptied out — a structural drift verifyParity must catch.
    writeFileSync(
      join(outDir, 'wp', 'WP-20260708-002.md'),
      '---\nid: WP-20260708-002\ntype: wp\nrole: developer\nstatus: accepted\nfr_ids: []\n---\n\nDrifted.\n',
      'utf8'
    )

    const verdict = verifyParity(v1Dir, outDir)

    expect(verdict.verdict).toBe('VERIFY-FAIL')
    const wpCheck = verdict.checks.find((c) => c.name === 'wp-fr-ids')
    expect(wpCheck?.ok).toBe(false)
  })

  it('fails id set-equality when an extra epic exists in the md canon (epic-ids)', () => {
    const v1Dir = writeV1Corpus(loadSnapshot())
    const outDir = makeOutDir()
    migrate(v1Dir, outDir)

    // v1's fixture has only E1 — an extra `E9` epic index page in the md
    // canon (with no corresponding v1 epic) must be caught the same way an
    // extra fr/nfr/br/cr/baseline id already is.
    const extraDir = join(outDir, 'epics', 'E9-extra')
    mkdirSync(extraDir, { recursive: true })
    writeFileSync(join(extraDir, 'index.md'), '---\nid: E9\ntype: epic\ntitle: Extra\nstatus: active\n---\n\n', 'utf8')

    const verdict = verifyParity(v1Dir, outDir)

    expect(verdict.verdict).toBe('VERIFY-FAIL')
    const epicCheck = verdict.checks.find((c) => c.name === 'epic-ids')
    expect(epicCheck).toBeDefined()
    expect(epicCheck?.ok).toBe(false)
    expect(epicCheck?.reason).toContain('E9')
  })

  it('fails id set-equality when a v1 epic is missing from the md canon (epic-ids)', () => {
    const v1Dir = writeV1Corpus(loadSnapshot())
    const outDir = makeOutDir()
    migrate(v1Dir, outDir)

    rmSync(join(outDir, 'epics', 'E1-foundation-access', 'index.md'))

    const verdict = verifyParity(v1Dir, outDir)

    expect(verdict.verdict).toBe('VERIFY-FAIL')
    const epicCheck = verdict.checks.find((c) => c.name === 'epic-ids')
    expect(epicCheck).toBeDefined()
    expect(epicCheck?.ok).toBe(false)
    expect(epicCheck?.reason).toContain('E1')
  })

  it('fails id set-equality when an extra WP exists in the md canon (wp-ids)', () => {
    const v1Dir = writeV1Corpus(loadSnapshot())
    const outDir = makeOutDir()
    migrate(v1Dir, outDir)

    // v1's fixture only has WP-20260708-002 and WP-20260711-005 — an extra
    // md WP page with no corresponding v1 WP must be caught. `wp-fr-ids`
    // (above) only iterates v1 WPs, so it would never notice this extra page.
    // Schema-VALID v3 shape (no `fr_ids` — wpSchema is `.strict()`, Task 5; a
    // page still carrying it would fail to parse and be silently excluded
    // from the graph entirely, defeating the point of this fixture).
    writeFileSync(
      join(outDir, 'wp', 'WP-20260713-999.md'),
      '---\nid: WP-20260713-999\ntype: wp\nrole: developer\nstatus: draft\n---\n\nExtra.\n',
      'utf8'
    )

    const verdict = verifyParity(v1Dir, outDir)

    expect(verdict.verdict).toBe('VERIFY-FAIL')
    const wpCheck = verdict.checks.find((c) => c.name === 'wp-ids')
    expect(wpCheck).toBeDefined()
    expect(wpCheck?.ok).toBe(false)
    expect(wpCheck?.reason).toContain('WP-20260713-999')
  })

  it('confirmed CR round-trips its entry-point fields (entry_point + entry_point_confirmed)', () => {
    const v1Dir = writeV1Corpus(loadSnapshot())
    const outDir = makeOutDir()
    migrate(v1Dir, outDir)

    const parsed = parseFile(join(outDir, 'cr', 'CR-001.md'), 'cr')
    if ('error' in parsed) throw new Error(`fixture CR failed to parse: ${parsed.error}`)
    const fm = parsed.frontmatter as { entry_point?: string; entry_point_confirmed?: boolean }
    // Fixture CR-001 is `status: confirmed` with `entry_point_confirmed: "vision"`.
    expect(fm.entry_point).toBe('vision')
    expect(fm.entry_point_confirmed).toBe(true)
  })
})
