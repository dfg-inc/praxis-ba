import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse as yamlParse, stringify as yamlStringify } from 'yaml'
import { describe, it, expect, afterEach } from 'vitest'
import { accept, pendingMarkerPath, retireRequirement } from '../src/writer'
import { reconcileCrs } from '../src/reconcile'
import { parseFile } from '../src/parse'
import { readCounters, type Counters } from '../src/ids'
import { baselineManifestSchema } from '../src/schema'
import type { VerifyEvidence } from '../src/gates'

// ---- fixture repo helpers — a temp dir per test, never the real `product/`
// (per the task's global constraint). Mirrors writer.test.ts's makeRepo/seed*
// conventions exactly, extended with seedNfr/seedBr/seedWp/seedVision. ----

const tempDirs: string[] = []

function baseCounters(): Counters {
  return { product: { epic: 0, cr: 0, wp: 0, bug: 0, baselineSeq: {} }, epics: {}, retired: [] }
}

function makeRepo(counters: Counters = baseCounters()): string {
  const dir = mkdtempSync(join(tmpdir(), 'canon-accept-'))
  mkdirSync(join(dir, '.ba'), { recursive: true })
  writeFileSync(join(dir, '.ba', 'counters.yaml'), yamlStringify(counters), 'utf8')
  tempDirs.push(dir)
  return dir
}

function seedRaw(repo: string, relPath: string, raw: string): string {
  const path = join(repo, relPath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, raw, 'utf8')
  return path
}

function seedFr(
  repo: string,
  id: string,
  epic: string,
  opts: {
    status?: string
    version?: number
    baseline?: string
    body?: string
    tracesTo?: string[]
    enforces?: string[]
    referencesNfr?: string[]
  } = {}
): string {
  const lines = [
    '---',
    `id: ${id}`,
    'type: fr',
    `epic: ${epic}`,
    `status: ${opts.status ?? 'draft'}`,
    `version: ${opts.version ?? 1}`,
    `traces_to: [${(opts.tracesTo ?? []).join(', ')}]`,
    `enforces: [${(opts.enforces ?? []).join(', ')}]`,
    `references_nfr: [${(opts.referencesNfr ?? []).join(', ')}]`,
    'related: []',
  ]
  if (opts.baseline) lines.push(`baseline: ${opts.baseline}`)
  lines.push(
    '---',
    '',
    opts.body ?? 'Story body.\n\n## Acceptance Criteria\n- AC-1: given a starting state, when the user acts, then an observable outcome.',
    ''
  )
  return seedRaw(repo, join('epics', `${epic}-x`, `${id}.md`), lines.join('\n'))
}

function seedNfr(
  repo: string,
  id: string,
  epic: string,
  opts: { status?: string; version?: number; baseline?: string; tracesTo?: string[]; body?: string } = {}
): string {
  const lines = [
    '---',
    `id: ${id}`,
    'type: nfr',
    `epic: ${epic}`,
    `status: ${opts.status ?? 'draft'}`,
    `version: ${opts.version ?? 1}`,
    `traces_to: [${(opts.tracesTo ?? []).join(', ')}]`,
    'verified_by: []',
    'related: []',
  ]
  if (opts.baseline) lines.push(`baseline: ${opts.baseline}`)
  lines.push('---', '', opts.body ?? 'A Planguage constraint.', '')
  return seedRaw(repo, join('epics', `${epic}-x`, `${id}.md`), lines.join('\n'))
}

function seedBr(
  repo: string,
  id: string,
  epic: string,
  opts: { status?: string; version?: number; baseline?: string; body?: string } = {}
): string {
  const lines = [
    '---',
    `id: ${id}`,
    'type: br',
    `epic: ${epic}`,
    'kind: operative',
    'enforcement: advisory',
    `status: ${opts.status ?? 'draft'}`,
    `version: ${opts.version ?? 1}`,
  ]
  if (opts.baseline) lines.push(`baseline: ${opts.baseline}`)
  lines.push('---', '', opts.body ?? 'A rule sentence.', '')
  return seedRaw(repo, join('br', `${id}.md`), lines.join('\n'))
}

// v3 (Task 6): a CR's typed `impacts` set (schema.ts's `CrImpact`) is what
// `reconcileCrs` now resolves off — `opts.impacts` renders it as a YAML
// block sequence (matching writer.test.ts's own raw-fixture convention for
// this field); omitted entirely (not even an empty key) when absent, so a
// bare `seedCr(repo, id, status)` call still produces a CR with NO
// `impacts` field at all — the "never auto-resolves" v3 case.
type CrImpactFixture = { amends: string } | { spawns: 'fr' | 'nfr' | 'br'; epic: string; realized?: string }

function seedCr(
  repo: string,
  id: string,
  status: 'captured' | 'confirmed' | 'resolved',
  opts: { impacts?: CrImpactFixture[]; provenance?: 'backfilled' } = {}
): string {
  const lines = ['---', `id: ${id}`, 'type: cr', `status: ${status}`]
  if (opts.impacts && opts.impacts.length > 0) {
    lines.push('impacts:')
    for (const impact of opts.impacts) {
      if ('amends' in impact) {
        lines.push(`  - amends: ${impact.amends}`)
      } else {
        lines.push(`  - spawns: ${impact.spawns}`, `    epic: ${impact.epic}`)
        if (impact.realized) lines.push(`    realized: ${impact.realized}`)
      }
    }
  }
  if (opts.provenance) lines.push(`provenance: ${opts.provenance}`)
  lines.push('---', '', 'Captured idea.', '')
  return seedRaw(repo, join('cr', `${id}.md`), lines.join('\n'))
}

// v3 (Task 4): a WP's FR/NFR/BR scope lives in the body's `## Scope` section
// (scopelinks.ts's `parseScope`), not frontmatter — `fr_ids`/`extra_brs`/
// `extra_nfrs` are retired from wpSchema entirely. `opts.frIds` renders as
// `### Delivers` links; `opts.extraBrs`/`opts.extraNfrs` render as
// `### Constraints` links — same call-site shape every test already uses.
// v3 (Task 5): the WP page itself lives at `wp/<id>/index.md` (folder-per-
// item, matching `epics/E{n}-slug/index.md`), not a flat `wp/<id>.md` file —
// mirrors `writer.ts`'s exported `wpPath`.
function seedWp(
  repo: string,
  id: string,
  opts: { status?: string; frIds?: string[]; extraBrs?: string[]; extraNfrs?: string[] } = {}
): string {
  const deliversLines = (opts.frIds ?? []).map((fr) => `- [${fr}](epics/x/${fr}.md)`).join('\n')
  const constraintsLines = [...(opts.extraBrs ?? []), ...(opts.extraNfrs ?? [])]
    .map((cid) => `- [${cid}](epics/x/${cid}.md)`)
    .join('\n')
  const lines = [
    '---',
    `id: ${id}`,
    'type: wp',
    'role: developer',
    `status: ${opts.status ?? 'plan-approved'}`,
    '---',
    '',
    'A work package.',
    '',
    '## Scope',
    '',
    '### Delivers',
    '',
    deliversLines,
  ]
  if (constraintsLines !== '') lines.push('', '### Constraints', '', constraintsLines)
  lines.push('')
  return seedRaw(repo, join('wp', id, 'index.md'), lines.join('\n'))
}

function seedVision(repo: string, status: 'draft' | 'confirmed' = 'confirmed'): string {
  return seedRaw(repo, 'vision.md', `---\ntype: vision\nstatus: ${status}\n---\n\nProduct vision text.\n`)
}

function readFm(repo: string, relPath: string, type: 'fr' | 'nfr' | 'br' | 'cr' | 'wp'): Record<string, unknown> {
  const result = parseFile(join(repo, relPath), type)
  if ('error' in result) throw new Error(`fixture read failed: ${result.error}`)
  return result.frontmatter as Record<string, unknown>
}

function readBody(repo: string, relPath: string, type: 'fr' | 'nfr' | 'br' | 'cr' | 'wp'): string {
  const result = parseFile(join(repo, relPath), type)
  if ('error' in result) throw new Error(`fixture read failed: ${result.error}`)
  return result.body
}

function evidenceFor(wpId: string, commit = 'abc123def'): VerifyEvidence {
  return {
    wpId,
    commit,
    testRunHashes: ['hash1'],
    suites: ['unit'],
    producedAt: '2026-01-01T00:00:00Z',
    producedBy: 'alex',
    toolVersion: '0.0.1',
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

// ==========================================================================
// accept — the happy path
// ==========================================================================

describe('accept — happy path', () => {
  it('baselines only the delivered (batched) set, writes the baseline dir + manifest, resolves the CR, accepts the WP', async () => {
    const repo = makeRepo()
    seedVision(repo)
    // v3: CR-001 resolves off its own `impacts` set (a spawned FR + a spawned
    // NFR, both realized against the ids seeded below) — not off a derived
    // reverse-walk.
    seedCr(repo, 'CR-001', 'confirmed', {
      impacts: [
        { spawns: 'fr', epic: 'E1', realized: 'E1-FR1' },
        { spawns: 'nfr', epic: 'E1', realized: 'E1-NFR1' },
      ],
    })
    seedBr(repo, 'E1-BR1', 'E1', { status: 'active' })
    seedNfr(repo, 'E1-NFR1', 'E1', { status: 'batched', tracesTo: ['CR-001'] })
    seedFr(repo, 'E1-FR1', 'E1', {
      status: 'batched',
      tracesTo: ['CR-001'],
      enforces: ['E1-BR1'],
      referencesNfr: ['E1-NFR1'],
    })
    seedWp(repo, 'WP-20260101-001', { status: 'plan-approved', frIds: ['E1-FR1'] })

    const v = await accept(repo, 'WP-20260101-001', evidenceFor('WP-20260101-001'), '20260101', 'abc123def')
    expect(v.verdict).toBe('VERIFY-OK')

    const frFm = readFm(repo, 'epics/E1-x/E1-FR1.md', 'fr')
    expect(frFm).toMatchObject({ status: 'baselined', version: 1 })
    expect(typeof frFm.baseline).toBe('string')
    const blId = frFm.baseline as string
    expect(blId.startsWith('BL-20260101')).toBe(true)

    const nfrFm = readFm(repo, 'epics/E1-x/E1-NFR1.md', 'nfr')
    expect(nfrFm).toMatchObject({ status: 'baselined', baseline: blId, version: 1 })

    // E1-BR1 is `enforces`d by the FR but was NOT `batched` (still `active`)
    // — it is not part of the delivered set (`wp prepare` never flipped it),
    // so accept must not touch it either.
    const brFm = readFm(repo, 'br/E1-BR1.md', 'br')
    expect(brFm).toMatchObject({ status: 'active', version: 1 })
    expect(brFm.baseline).toBeUndefined()

    // frozen full-content copies exist for the delivered items only
    expect(existsSync(join(repo, 'baselines', blId, 'E1-FR1.md'))).toBe(true)
    expect(existsSync(join(repo, 'baselines', blId, 'E1-NFR1.md'))).toBe(true)
    expect(existsSync(join(repo, 'baselines', blId, 'E1-BR1.md'))).toBe(false)

    const manifestRaw = readFileSync(join(repo, 'baselines', blId, 'manifest.yaml'), 'utf8')
    const manifest = baselineManifestSchema.parse(yamlParse(manifestRaw))
    expect(manifest.id).toBe(blId)
    expect(manifest.triggered_by).toBe('WP-20260101-001')
    expect(manifest.wp_ids).toEqual(['WP-20260101-001'])
    expect(manifest.items.map((i) => i.id).sort()).toEqual(['E1-FR1', 'E1-NFR1'])
    for (const item of manifest.items) {
      expect(item.version).toBe(1)
      expect(item.content_hash.length).toBeGreaterThan(0)
    }

    expect(readFm(repo, 'cr/CR-001.md', 'cr')).toMatchObject({ status: 'resolved' })
    expect(readFm(repo, 'wp/WP-20260101-001/index.md', 'wp')).toMatchObject({ status: 'accepted' })

    // A committed accept leaves NO pending marker (its absence is the "done"
    // proof that the crash-resume protocol relies on).
    expect(existsSync(pendingMarkerPath(repo, 'WP-20260101-001'))).toBe(false)
  })
})

// ==========================================================================
// dedup + exclusion rules
// ==========================================================================

describe('accept — delivered-set dedup and exclusion', () => {
  it('does not re-bump a shared item that is already baselined under a different id', async () => {
    const repo = makeRepo()
    seedVision(repo)
    seedCr(repo, 'CR-001', 'confirmed')
    seedBr(repo, 'E1-BR1', 'E1', { status: 'baselined', version: 1, baseline: 'BL-20251231' })
    seedFr(repo, 'E1-FR1', 'E1', { status: 'batched', tracesTo: ['CR-001'], enforces: ['E1-BR1'] })
    seedWp(repo, 'WP-20260101-001', { status: 'plan-approved', frIds: ['E1-FR1'] })

    const v = await accept(repo, 'WP-20260101-001', evidenceFor('WP-20260101-001'), '20260101', 'abc123def')
    expect(v.verdict).toBe('VERIFY-OK')

    const brFm = readFm(repo, 'br/E1-BR1.md', 'br')
    expect(brFm).toEqual({ id: 'E1-BR1', type: 'br', epic: 'E1', kind: 'operative', enforcement: 'advisory', status: 'baselined', version: 1, baseline: 'BL-20251231' })

    const frFm = readFm(repo, 'epics/E1-x/E1-FR1.md', 'fr')
    const blId = frFm.baseline as string
    expect(blId).not.toBe('BL-20251231')

    // the shared BR must not appear in the NEW baseline at all
    expect(existsSync(join(repo, 'baselines', blId, 'E1-BR1.md'))).toBe(false)
    const manifestRaw = readFileSync(join(repo, 'baselines', blId, 'manifest.yaml'), 'utf8')
    const manifest = baselineManifestSchema.parse(yamlParse(manifestRaw))
    expect(manifest.items.map((i) => i.id)).not.toContain('E1-BR1')
  })

  it('does not double-process a WP whose fr_ids literally repeats an id', async () => {
    const repo = makeRepo()
    seedVision(repo)
    seedCr(repo, 'CR-001', 'confirmed')
    seedFr(repo, 'E1-FR1', 'E1', { status: 'batched', tracesTo: ['CR-001'] })
    seedWp(repo, 'WP-20260101-001', { status: 'plan-approved', frIds: ['E1-FR1', 'E1-FR1'] })

    const v = await accept(repo, 'WP-20260101-001', evidenceFor('WP-20260101-001'), '20260101', 'abc123def')
    expect(v.verdict).toBe('VERIFY-OK')

    const frFm = readFm(repo, 'epics/E1-x/E1-FR1.md', 'fr')
    const blId = frFm.baseline as string
    const manifestRaw = readFileSync(join(repo, 'baselines', blId, 'manifest.yaml'), 'utf8')
    const manifest = baselineManifestSchema.parse(yamlParse(manifestRaw))
    expect(manifest.items.filter((i) => i.id === 'E1-FR1')).toHaveLength(1)
  })

  it('leaves a CR unresolved when only some of its derived spawned items are baselined', async () => {
    const repo = makeRepo()
    seedVision(repo)
    // v3: CR-001's impacts name BOTH E1-FR1 and E1-FR2 as spawns — E1-FR2
    // stays `active` (not delivered), so the "every impact delivered" check
    // fails even after this accept baselines E1-FR1.
    seedCr(repo, 'CR-001', 'confirmed', {
      impacts: [
        { spawns: 'fr', epic: 'E1', realized: 'E1-FR1' },
        { spawns: 'fr', epic: 'E1', realized: 'E1-FR2' },
      ],
    })
    // E1-FR2 also traces to CR-001 but is NOT part of this WP's closure and
    // stays `active` (not delivered) — CR-001's impact set is therefore not
    // fully baselined by this accept.
    seedFr(repo, 'E1-FR2', 'E1', { status: 'active', tracesTo: ['CR-001'] })
    seedFr(repo, 'E1-FR1', 'E1', { status: 'batched', tracesTo: ['CR-001'] })
    seedWp(repo, 'WP-20260101-001', { status: 'plan-approved', frIds: ['E1-FR1'] })

    const v = await accept(repo, 'WP-20260101-001', evidenceFor('WP-20260101-001'), '20260101', 'abc123def')
    expect(v.verdict).toBe('VERIFY-OK')
    expect(readFm(repo, 'epics/E1-x/E1-FR1.md', 'fr')).toMatchObject({ status: 'baselined' })
    expect(readFm(repo, 'cr/CR-001.md', 'cr')).toMatchObject({ status: 'confirmed' })
  })
})

// ==========================================================================
// v3 (Task 5): a delivered BR's amending CR(s) — recovered from its own
// `## History` (BRs have no `traces_to` field at all).
// ==========================================================================

describe('accept — BR History-derived CR contribution', () => {
  it('accept collects amending CRs from delivered BR History refs (a BR has no traces_to to carry them)', async () => {
    const repo = makeRepo()
    seedVision(repo)
    // CR-002 is only reachable via E1-BR1's own `## History` (simulating a
    // prior CR-driven `editRequirement` bump of this BR while it was
    // `active`) — it is deliberately left `confirmed`, not `resolved`, even
    // though its ONE OTHER spawned item (E1-FR9, traced via a real FR) is
    // already `baselined` from an earlier, unrelated baseline: this fixture
    // state isolates the point — nothing in THIS accept's own delivered set
    // traces to CR-002 via `traces_to`, so CR-002 only gets reconciled at all
    // if the BR's History contribution reaches `affectedCrIds`.
    // v3: CR-002's impacts are an `amends` of E1-BR1 (the CR-driven bump this
    // BR's own History entry, below, records) plus a `spawns` realized as
    // the unrelated, already-baselined E1-FR9.
    seedCr(repo, 'CR-002', 'confirmed', {
      impacts: [{ amends: 'E1-BR1' }, { spawns: 'fr', epic: 'E1', realized: 'E1-FR9' }],
    })
    seedFr(repo, 'E1-FR9', 'E1', { status: 'baselined', baseline: 'BL-20251231', tracesTo: ['CR-002'] })
    seedBr(repo, 'E1-BR1', 'E1', {
      status: 'batched',
      body: 'Rule text.\n\n## History\n\n### v1 — 20260101 — CR-002\n\nOld rule text.\n',
    })
    // The WP delivers no FR at all — only the BR, via `### Constraints`.
    seedWp(repo, 'WP-20260101-001', { status: 'plan-approved', frIds: [], extraBrs: ['E1-BR1'] })

    const v = await accept(repo, 'WP-20260101-001', evidenceFor('WP-20260101-001'), '20260101', 'abc123def')
    expect(v.verdict).toBe('VERIFY-OK')
    expect(readFm(repo, 'br/E1-BR1.md', 'br')).toMatchObject({ status: 'baselined' })
    // CR-002 flips to resolved ONLY because accept folded the BR's History
    // ref into affectedCrIds and handed it to reconcileCrs, which then found
    // its (unrelated, already-baselined) derived spawned set fully baselined.
    expect(readFm(repo, 'cr/CR-002.md', 'cr')).toMatchObject({ status: 'resolved' })
  })
})

// ==========================================================================
// gate failure — writes nothing
// ==========================================================================

describe('accept — gate failure', () => {
  it('returns VERIFY-FAIL and writes nothing when the WP is not plan-approved', async () => {
    const repo = makeRepo()
    seedVision(repo)
    seedCr(repo, 'CR-001', 'confirmed')
    seedFr(repo, 'E1-FR1', 'E1', { status: 'batched', tracesTo: ['CR-001'] })
    seedWp(repo, 'WP-20260101-001', { status: 'ready', frIds: ['E1-FR1'] })

    const v = await accept(repo, 'WP-20260101-001', evidenceFor('WP-20260101-001'), '20260101', 'abc123def')
    expect(v.verdict).toBe('VERIFY-FAIL')

    expect(readFm(repo, 'epics/E1-x/E1-FR1.md', 'fr')).toMatchObject({ status: 'batched' })
    expect(readFm(repo, 'wp/WP-20260101-001/index.md', 'wp')).toMatchObject({ status: 'ready' })
    expect(existsSync(join(repo, 'baselines'))).toBe(false)
  })

  it('rejects a malformed date upfront, before any write (including on what would otherwise be a resume path)', async () => {
    const repo = makeRepo()
    seedVision(repo)
    seedCr(repo, 'CR-001', 'confirmed')
    seedFr(repo, 'E1-FR1', 'E1', { status: 'batched', tracesTo: ['CR-001'] })
    seedWp(repo, 'WP-20260101-001', { status: 'plan-approved', frIds: ['E1-FR1'] })

    await expect(
      accept(repo, 'WP-20260101-001', evidenceFor('WP-20260101-001'), '2026-01-01', 'abc123def')
    ).rejects.toThrow(/YYYYMMDD/)

    expect(readFm(repo, 'epics/E1-x/E1-FR1.md', 'fr')).toMatchObject({ status: 'batched' })
    expect(existsSync(join(repo, 'baselines'))).toBe(false)
  })
})

// ==========================================================================
// idempotency + crash-safety
// ==========================================================================

describe('accept — idempotency and crash-safety', () => {
  it('re-running accept on an already-accepted WP is a no-op (no double History, nothing rewritten)', async () => {
    const repo = makeRepo()
    seedVision(repo)
    seedCr(repo, 'CR-001', 'confirmed', { impacts: [{ spawns: 'fr', epic: 'E1', realized: 'E1-FR1' }] })
    seedFr(repo, 'E1-FR1', 'E1', { status: 'batched', tracesTo: ['CR-001'] })
    seedWp(repo, 'WP-20260101-001', { status: 'plan-approved', frIds: ['E1-FR1'] })
    const evidence = evidenceFor('WP-20260101-001')

    const first = await accept(repo, 'WP-20260101-001', evidence, '20260101', 'abc123def')
    expect(first.verdict).toBe('VERIFY-OK')
    const afterFirst = readFm(repo, 'epics/E1-x/E1-FR1.md', 'fr')
    const bodyAfterFirst = readBody(repo, 'epics/E1-x/E1-FR1.md', 'fr')

    const second = await accept(repo, 'WP-20260101-001', evidence, '20260101', 'abc123def')
    expect(second.verdict).toBe('VERIFY-OK')
    expect(second.checks.some((c) => c.name === 'already-accepted')).toBe(true)

    expect(readFm(repo, 'epics/E1-x/E1-FR1.md', 'fr')).toEqual(afterFirst)
    expect(readBody(repo, 'epics/E1-x/E1-FR1.md', 'fr')).toBe(bodyAfterFirst)
    expect(bodyAfterFirst).not.toContain('## History')
    expect(readFm(repo, 'cr/CR-001.md', 'cr')).toMatchObject({ status: 'resolved' })
    expect(readFm(repo, 'wp/WP-20260101-001/index.md', 'wp')).toMatchObject({ status: 'accepted' })
  })

  it('a manifest.yaml deleted after a complete accept leaves the state detectably partial (validate\'s job, Task 12) — accept itself treats the already-accepted WP as done and does not silently restore it', async () => {
    const repo = makeRepo()
    seedVision(repo)
    seedCr(repo, 'CR-001', 'confirmed')
    seedFr(repo, 'E1-FR1', 'E1', { status: 'batched', tracesTo: ['CR-001'] })
    seedWp(repo, 'WP-20260101-001', { status: 'plan-approved', frIds: ['E1-FR1'] })
    const evidence = evidenceFor('WP-20260101-001')

    await accept(repo, 'WP-20260101-001', evidence, '20260101', 'abc123def')
    const blId = readFm(repo, 'epics/E1-x/E1-FR1.md', 'fr').baseline as string
    const manifestPath = join(repo, 'baselines', blId, 'manifest.yaml')
    expect(existsSync(manifestPath)).toBe(true)

    unlinkSync(manifestPath)

    // Detectably partial: the item still claims `baseline: blId`, but that
    // baseline's manifest is gone — exactly spec §8a's partial-state
    // predicate, which `validate` (Task 12) is the one to flag.
    expect(existsSync(manifestPath)).toBe(false)
    expect(readFm(repo, 'epics/E1-x/E1-FR1.md', 'fr').baseline).toBe(blId)

    // accept() on the now-`accepted` WP (marker already deleted on the first
    // accept's completion) is a no-op via the "no marker + WP accepted" path —
    // it does NOT self-heal post-completion tampering with an already-committed
    // baseline (that's `validate`'s detection job, Task 12). A GENUINE crash
    // (WP never reached `accepted`, marker still present) IS resumed — proven
    // by the crash-window tests below.
    const again = await accept(repo, 'WP-20260101-001', evidence, '20260101', 'abc123def')
    expect(again.verdict).toBe('VERIFY-OK')
    expect(again.checks.some((c) => c.name === 'already-accepted')).toBe(true)
    expect(existsSync(manifestPath)).toBe(false)
  })

  it('writes the durable pending marker BEFORE any item/baseline write, and deletes it on completion', async () => {
    const repo = makeRepo()
    seedVision(repo)
    seedCr(repo, 'CR-001', 'confirmed')
    seedFr(repo, 'E1-FR1', 'E1', { status: 'batched', tracesTo: ['CR-001'] })
    seedWp(repo, 'WP-20260101-001', { status: 'plan-approved', frIds: ['E1-FR1'] })
    const evidence = evidenceFor('WP-20260101-001')
    const markerPath = pendingMarkerPath(repo, 'WP-20260101-001')

    // crashAfter:'marker' throws right after the marker write — proving it
    // lands before ANY item flip or baseline-dir write.
    await expect(
      accept(repo, 'WP-20260101-001', evidence, '20260101', 'abc123def', { crashAfter: 'marker' })
    ).rejects.toThrow(/TEST-ONLY crash after marker/)
    expect(existsSync(markerPath)).toBe(true)
    expect(existsSync(join(repo, 'baselines'))).toBe(false)
    expect(readFm(repo, 'epics/E1-x/E1-FR1.md', 'fr')).toMatchObject({ status: 'batched' })
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
    expect(marker).toMatchObject({
      wpId: 'WP-20260101-001',
      baselineId: 'BL-20260101',
      deliveredIds: ['E1-FR1'],
      date: '20260101',
      headCommit: 'abc123def',
    })

    // Resume completes the transaction and deletes the marker.
    const resumed = await accept(repo, 'WP-20260101-001', evidence, '20260101', 'abc123def')
    expect(resumed.verdict).toBe('VERIFY-OK')
    expect(resumed.checks.some((c) => c.name === 'resumed-from-pending-marker')).toBe(true)
    expect(existsSync(markerPath)).toBe(false)
    expect(readFm(repo, 'wp/WP-20260101-001/index.md', 'wp')).toMatchObject({ status: 'accepted' })
  })

  it('[Critical] crash AFTER the manifest write, before reconcile/setWpAccepted → resume unsticks the CR + accepts the WP, no duplicate baseline', async () => {
    const repo = makeRepo()
    seedVision(repo)
    seedCr(repo, 'CR-001', 'confirmed', { impacts: [{ spawns: 'fr', epic: 'E1', realized: 'E1-FR1' }] })
    seedFr(repo, 'E1-FR1', 'E1', { status: 'batched', tracesTo: ['CR-001'] })
    seedWp(repo, 'WP-20260101-001', { status: 'plan-approved', frIds: ['E1-FR1'] })
    const evidence = evidenceFor('WP-20260101-001')

    await expect(
      accept(repo, 'WP-20260101-001', evidence, '20260101', 'abc123def', { crashAfter: 'manifest' })
    ).rejects.toThrow(/TEST-ONLY crash after manifest/)

    // Post-crash: baseline dir + manifest + baselined item all written, but the
    // CR is STILL stuck (`confirmed`) and the WP STILL `plan-approved` — with
    // the durable marker still present.
    const blId = readFm(repo, 'epics/E1-x/E1-FR1.md', 'fr').baseline as string
    expect(existsSync(join(repo, 'baselines', blId, 'manifest.yaml'))).toBe(true)
    expect(readFm(repo, 'cr/CR-001.md', 'cr')).toMatchObject({ status: 'confirmed' })
    expect(readFm(repo, 'wp/WP-20260101-001/index.md', 'wp')).toMatchObject({ status: 'plan-approved' })
    expect(existsSync(pendingMarkerPath(repo, 'WP-20260101-001'))).toBe(true)

    // Re-invoke → resume runs the final two steps + deletes the marker.
    const resumed = await accept(repo, 'WP-20260101-001', evidence, '20260101', 'abc123def')
    expect(resumed.verdict).toBe('VERIFY-OK')
    expect(readFm(repo, 'cr/CR-001.md', 'cr')).toMatchObject({ status: 'resolved' })
    expect(readFm(repo, 'wp/WP-20260101-001/index.md', 'wp')).toMatchObject({ status: 'accepted' })
    expect(existsSync(pendingMarkerPath(repo, 'WP-20260101-001'))).toBe(false)

    // Exactly ONE baseline dir for the date — no fresh empty baseline minted.
    const blDirs = readdirSync(join(repo, 'baselines')).filter((n) => n.startsWith('BL-20260101'))
    expect(blDirs).toEqual([blId])
  })

  it('[Major] crash between an item live-write and its frozen-write → resume re-writes ALL frozen pages + a complete manifest, no dropped item', async () => {
    const repo = makeRepo()
    seedVision(repo)
    seedCr(repo, 'CR-001', 'confirmed', {
      impacts: [
        { spawns: 'fr', epic: 'E1', realized: 'E1-FR1' },
        { spawns: 'fr', epic: 'E1', realized: 'E1-FR2' },
      ],
    })
    seedFr(repo, 'E1-FR1', 'E1', { status: 'batched', tracesTo: ['CR-001'] })
    seedFr(repo, 'E1-FR2', 'E1', { status: 'batched', tracesTo: ['CR-001'] })
    seedWp(repo, 'WP-20260101-001', { status: 'plan-approved', frIds: ['E1-FR1', 'E1-FR2'] })
    const evidence = evidenceFor('WP-20260101-001')

    await expect(
      accept(repo, 'WP-20260101-001', evidence, '20260101', 'abc123def', { crashAfter: 'firstItemLive' })
    ).rejects.toThrow(/TEST-ONLY crash after first item live-write/)

    const blId = readFm(repo, 'epics/E1-x/E1-FR1.md', 'fr').baseline as string
    // First item flipped live but its frozen page NOT written; second item
    // still batched; no manifest; marker present naming BOTH delivered ids.
    expect(readFm(repo, 'epics/E1-x/E1-FR1.md', 'fr')).toMatchObject({ status: 'baselined', baseline: blId })
    expect(existsSync(join(repo, 'baselines', blId, 'E1-FR1.md'))).toBe(false)
    expect(readFm(repo, 'epics/E1-x/E1-FR2.md', 'fr')).toMatchObject({ status: 'batched' })
    expect(existsSync(join(repo, 'baselines', blId, 'manifest.yaml'))).toBe(false)
    const marker = JSON.parse(readFileSync(pendingMarkerPath(repo, 'WP-20260101-001'), 'utf8'))
    expect(marker.deliveredIds.sort()).toEqual(['E1-FR1', 'E1-FR2'])

    // Re-invoke → resume re-derives everything from the marker's deliveredIds.
    const resumed = await accept(repo, 'WP-20260101-001', evidence, '20260101', 'abc123def')
    expect(resumed.verdict).toBe('VERIFY-OK')
    expect(existsSync(join(repo, 'baselines', blId, 'E1-FR1.md'))).toBe(true)
    expect(existsSync(join(repo, 'baselines', blId, 'E1-FR2.md'))).toBe(true)
    const manifest = baselineManifestSchema.parse(
      yamlParse(readFileSync(join(repo, 'baselines', blId, 'manifest.yaml'), 'utf8'))
    )
    expect(manifest.items.map((i) => i.id).sort()).toEqual(['E1-FR1', 'E1-FR2'])
    expect(readFm(repo, 'epics/E1-x/E1-FR2.md', 'fr')).toMatchObject({ status: 'baselined', baseline: blId })
    expect(readFm(repo, 'cr/CR-001.md', 'cr')).toMatchObject({ status: 'resolved' })
    expect(readFm(repo, 'wp/WP-20260101-001/index.md', 'wp')).toMatchObject({ status: 'accepted' })
    expect(existsSync(pendingMarkerPath(repo, 'WP-20260101-001'))).toBe(false)
  })

  it('[Major regression] resume does NOT resurrect an item legally retired out-of-band during the crash window — it is excluded, the rest complete', async () => {
    const repo = makeRepo()
    seedVision(repo)
    seedCr(repo, 'CR-001', 'confirmed', { impacts: [{ spawns: 'fr', epic: 'E1', realized: 'E1-FR1' }] })
    seedCr(repo, 'CR-002', 'confirmed', { impacts: [{ spawns: 'fr', epic: 'E1', realized: 'E1-FR2' }] })
    // Two delivered FRs tracing to DIFFERENT CRs (so CR-001 can resolve off
    // E1-FR1 alone while E1-FR2's CR-002 stays open once E1-FR2 is retired).
    seedFr(repo, 'E1-FR1', 'E1', { status: 'batched', tracesTo: ['CR-001'] })
    seedFr(repo, 'E1-FR2', 'E1', { status: 'batched', tracesTo: ['CR-002'] })
    seedWp(repo, 'WP-20260101-001', { status: 'plan-approved', frIds: ['E1-FR1', 'E1-FR2'] })
    const evidence = evidenceFor('WP-20260101-001')

    // Crash after the FIRST item's live-write (E1-FR1 → baselined; E1-FR2 still
    // batched).
    await expect(
      accept(repo, 'WP-20260101-001', evidence, '20260101', 'abc123def', { crashAfter: 'firstItemLive' })
    ).rejects.toThrow(/TEST-ONLY crash after first item live-write/)
    const blId = readFm(repo, 'epics/E1-x/E1-FR1.md', 'fr').baseline as string

    // Out-of-band during the crash-to-resume window: E1-FR2 (still batched) is
    // legally soft-retired (batched → retired is a legal transition).
    await retireRequirement(repo, 'E1-FR2')
    expect(readFm(repo, 'epics/E1-x/E1-FR2.md', 'fr')).toMatchObject({ status: 'retired' })

    // Resume recomputes the delivered set from CURRENT status: E1-FR2 is
    // neither `batched` nor `baselined@target`, so it is EXCLUDED — not flipped
    // back to `baselined`.
    const resumed = await accept(repo, 'WP-20260101-001', evidence, '20260101', 'abc123def')
    expect(resumed.verdict).toBe('VERIFY-OK')

    // The retired item stays retired, has NO frozen page, and is absent from
    // the manifest.
    expect(readFm(repo, 'epics/E1-x/E1-FR2.md', 'fr')).toMatchObject({ status: 'retired' })
    expect(readFm(repo, 'epics/E1-x/E1-FR2.md', 'fr').baseline).toBeUndefined()
    expect(existsSync(join(repo, 'baselines', blId, 'E1-FR2.md'))).toBe(false)
    const manifest = baselineManifestSchema.parse(
      yamlParse(readFileSync(join(repo, 'baselines', blId, 'manifest.yaml'), 'utf8'))
    )
    expect(manifest.items.map((i) => i.id)).toEqual(['E1-FR1'])

    // The rest completes: E1-FR1 baselined + frozen, its CR resolved, WP accepted.
    expect(readFm(repo, 'epics/E1-x/E1-FR1.md', 'fr')).toMatchObject({ status: 'baselined', baseline: blId })
    expect(existsSync(join(repo, 'baselines', blId, 'E1-FR1.md'))).toBe(true)
    expect(readFm(repo, 'cr/CR-001.md', 'cr')).toMatchObject({ status: 'resolved' })
    // E1-FR2's CR-002 is never delivered, so it stays open.
    expect(readFm(repo, 'cr/CR-002.md', 'cr')).toMatchObject({ status: 'confirmed' })
    expect(readFm(repo, 'wp/WP-20260101-001/index.md', 'wp')).toMatchObject({ status: 'accepted' })
    expect(existsSync(pendingMarkerPath(repo, 'WP-20260101-001'))).toBe(false)
  })

  it('resumes from the crashAfter:\'items\' window (all items flipped + frozen, manifest not yet written)', async () => {
    const repo = makeRepo()
    seedVision(repo)
    seedCr(repo, 'CR-001', 'confirmed', {
      impacts: [
        { spawns: 'fr', epic: 'E1', realized: 'E1-FR1' },
        { spawns: 'fr', epic: 'E1', realized: 'E1-FR2' },
      ],
    })
    seedFr(repo, 'E1-FR1', 'E1', { status: 'batched', tracesTo: ['CR-001'] })
    seedFr(repo, 'E1-FR2', 'E1', { status: 'batched', tracesTo: ['CR-001'] })
    seedWp(repo, 'WP-20260101-001', { status: 'plan-approved', frIds: ['E1-FR1', 'E1-FR2'] })
    const evidence = evidenceFor('WP-20260101-001')

    await expect(
      accept(repo, 'WP-20260101-001', evidence, '20260101', 'abc123def', { crashAfter: 'items' })
    ).rejects.toThrow(/TEST-ONLY crash after all item\/frozen writes/)
    const blId = readFm(repo, 'epics/E1-x/E1-FR1.md', 'fr').baseline as string

    // Post-crash: BOTH items flipped + their frozen pages written, but NO
    // manifest, marker present, CR still confirmed, WP still plan-approved.
    expect(readFm(repo, 'epics/E1-x/E1-FR1.md', 'fr')).toMatchObject({ status: 'baselined', baseline: blId })
    expect(readFm(repo, 'epics/E1-x/E1-FR2.md', 'fr')).toMatchObject({ status: 'baselined', baseline: blId })
    expect(existsSync(join(repo, 'baselines', blId, 'E1-FR1.md'))).toBe(true)
    expect(existsSync(join(repo, 'baselines', blId, 'E1-FR2.md'))).toBe(true)
    expect(existsSync(join(repo, 'baselines', blId, 'manifest.yaml'))).toBe(false)
    expect(readFm(repo, 'cr/CR-001.md', 'cr')).toMatchObject({ status: 'confirmed' })
    expect(existsSync(pendingMarkerPath(repo, 'WP-20260101-001'))).toBe(true)

    // Resume writes the manifest + reconciles + accepts + deletes the marker.
    const resumed = await accept(repo, 'WP-20260101-001', evidence, '20260101', 'abc123def')
    expect(resumed.verdict).toBe('VERIFY-OK')
    const manifest = baselineManifestSchema.parse(
      yamlParse(readFileSync(join(repo, 'baselines', blId, 'manifest.yaml'), 'utf8'))
    )
    expect(manifest.items.map((i) => i.id).sort()).toEqual(['E1-FR1', 'E1-FR2'])
    expect(readFm(repo, 'cr/CR-001.md', 'cr')).toMatchObject({ status: 'resolved' })
    expect(readFm(repo, 'wp/WP-20260101-001/index.md', 'wp')).toMatchObject({ status: 'accepted' })
    expect(existsSync(pendingMarkerPath(repo, 'WP-20260101-001'))).toBe(false)
  })

  it('[Minor] a marker whose body names a DIFFERENT wpId is rejected (never drives the wrong WP)', async () => {
    const repo = makeRepo()
    seedVision(repo)
    seedCr(repo, 'CR-001', 'confirmed')
    seedFr(repo, 'E1-FR1', 'E1', { status: 'batched', tracesTo: ['CR-001'] })
    seedWp(repo, 'WP-20260101-001', { status: 'plan-approved', frIds: ['E1-FR1'] })
    // A marker filed under WP-...-001 but whose body claims WP-...-999.
    const markerPath = pendingMarkerPath(repo, 'WP-20260101-001')
    mkdirSync(dirname(markerPath), { recursive: true })
    writeFileSync(
      markerPath,
      JSON.stringify({
        wpId: 'WP-20260101-999',
        baselineId: 'BL-20260101',
        deliveredIds: ['E1-FR1'],
        date: '20260101',
        headCommit: 'abc123def',
        verifyEvidenceRef: '.ba/cache/verify-WP-20260101-999.json',
      }),
      'utf8'
    )
    await expect(
      accept(repo, 'WP-20260101-001', evidenceFor('WP-20260101-001'), '20260101', 'abc123def')
    ).rejects.toThrow(/is for WP-20260101-999, not WP-20260101-001/)
  })

  it('[Major] a COMMITTED baseline whose manifest.yaml was deleted is NOT adopted/overwritten by an unrelated WP\'s accept (no matching marker)', async () => {
    const repo = makeRepo()
    seedVision(repo)
    seedCr(repo, 'CR-001', 'confirmed')
    seedCr(repo, 'CR-002', 'confirmed')
    seedFr(repo, 'E1-FR1', 'E1', { status: 'batched', tracesTo: ['CR-001'] })
    seedFr(repo, 'E1-FR2', 'E1', { status: 'batched', tracesTo: ['CR-002'] })
    seedWp(repo, 'WP-20260101-001', { status: 'plan-approved', frIds: ['E1-FR1'] })
    seedWp(repo, 'WP-20260101-002', { status: 'plan-approved', frIds: ['E1-FR2'] })

    // WP-001 commits fully (marker deleted); then its manifest is tampered away.
    await accept(repo, 'WP-20260101-001', evidenceFor('WP-20260101-001'), '20260101', 'abc123def')
    const firstBlId = readFm(repo, 'epics/E1-x/E1-FR1.md', 'fr').baseline as string
    expect(firstBlId).toBe('BL-20260101')
    expect(existsSync(pendingMarkerPath(repo, 'WP-20260101-001'))).toBe(false)
    unlinkSync(join(repo, 'baselines', firstBlId, 'manifest.yaml'))
    const firstFrozenBefore = readFileSync(join(repo, 'baselines', firstBlId, 'E1-FR1.md'), 'utf8')

    // Unrelated WP-002 accepts on the same date. No marker exists for WP-002,
    // so the manifest-less BL-20260101 dir is NEVER adopted — WP-002 mints its
    // own id and leaves the old dir untouched.
    const second = await accept(repo, 'WP-20260101-002', evidenceFor('WP-20260101-002'), '20260101', 'abc123def')
    expect(second.verdict).toBe('VERIFY-OK')
    const secondBlId = readFm(repo, 'epics/E1-x/E1-FR2.md', 'fr').baseline as string
    expect(secondBlId).toBe('BL-20260101-2')
    expect(secondBlId).not.toBe(firstBlId)

    // Old tampered baseline dir untouched: frozen page byte-identical, manifest
    // NOT recreated. WP-002's own baseline is complete.
    expect(readFileSync(join(repo, 'baselines', firstBlId, 'E1-FR1.md'), 'utf8')).toBe(firstFrozenBefore)
    expect(existsSync(join(repo, 'baselines', firstBlId, 'manifest.yaml'))).toBe(false)
    expect(existsSync(join(repo, 'baselines', secondBlId, 'manifest.yaml'))).toBe(true)
  })

  it('two different WPs accepted on the same date mint distinct ids — a prior, COMPLETE same-date baseline is correctly skipped as not resumable', async () => {
    const repo = makeRepo()
    seedVision(repo)
    seedCr(repo, 'CR-001', 'confirmed')
    seedCr(repo, 'CR-002', 'confirmed')
    seedFr(repo, 'E1-FR1', 'E1', { status: 'batched', tracesTo: ['CR-001'] })
    seedFr(repo, 'E1-FR2', 'E1', { status: 'batched', tracesTo: ['CR-002'] })
    seedWp(repo, 'WP-20260101-001', { status: 'plan-approved', frIds: ['E1-FR1'] })
    seedWp(repo, 'WP-20260101-002', { status: 'plan-approved', frIds: ['E1-FR2'] })

    const first = await accept(repo, 'WP-20260101-001', evidenceFor('WP-20260101-001'), '20260101', 'abc123def')
    expect(first.verdict).toBe('VERIFY-OK')
    const firstBlId = readFm(repo, 'epics/E1-x/E1-FR1.md', 'fr').baseline as string
    expect(firstBlId).toBe('BL-20260101')

    const second = await accept(repo, 'WP-20260101-002', evidenceFor('WP-20260101-002'), '20260101', 'abc123def')
    expect(second.verdict).toBe('VERIFY-OK')
    const secondBlId = readFm(repo, 'epics/E1-x/E1-FR2.md', 'fr').baseline as string
    expect(secondBlId).toBe('BL-20260101-2')
    expect(secondBlId).not.toBe(firstBlId)

    expect(readCounters(repo).product.baselineSeq['20260101']).toBe(2)
    expect(existsSync(join(repo, 'baselines', 'BL-20260101', 'manifest.yaml'))).toBe(true)
    expect(existsSync(join(repo, 'baselines', 'BL-20260101-2', 'manifest.yaml'))).toBe(true)
  })

  it('throws (never silently coerces) on a corrupt or schema-invalid pending marker', async () => {
    const repo = makeRepo()
    seedVision(repo)
    seedCr(repo, 'CR-001', 'confirmed')
    seedFr(repo, 'E1-FR1', 'E1', { status: 'batched', tracesTo: ['CR-001'] })
    seedWp(repo, 'WP-20260101-001', { status: 'plan-approved', frIds: ['E1-FR1'] })
    const markerPath = pendingMarkerPath(repo, 'WP-20260101-001')
    mkdirSync(dirname(markerPath), { recursive: true })

    writeFileSync(markerPath, '{ not valid json', 'utf8')
    await expect(
      accept(repo, 'WP-20260101-001', evidenceFor('WP-20260101-001'), '20260101', 'abc123def')
    ).rejects.toThrow(/not valid JSON/)

    writeFileSync(markerPath, JSON.stringify({ wpId: 'WP-20260101-001' }), 'utf8')
    await expect(
      accept(repo, 'WP-20260101-001', evidenceFor('WP-20260101-001'), '20260101', 'abc123def')
    ).rejects.toThrow(/failed validation/)
  })

  it('throws before writing any marker or page when the closure has no batched items (nothing to baseline)', async () => {
    const repo = makeRepo()
    seedVision(repo)
    seedCr(repo, 'CR-001', 'confirmed')
    // The WP's only FR is already baselined (a shared item) — the delivered
    // set (closure ∩ batched) is empty, so there is nothing to freeze.
    seedFr(repo, 'E1-FR1', 'E1', { status: 'baselined', baseline: 'BL-20250101', tracesTo: ['CR-001'] })
    seedWp(repo, 'WP-20260101-001', { status: 'plan-approved', frIds: ['E1-FR1'] })

    await expect(
      accept(repo, 'WP-20260101-001', evidenceFor('WP-20260101-001'), '20260101', 'abc123def')
    ).rejects.toThrow(/nothing to baseline/)
    expect(existsSync(pendingMarkerPath(repo, 'WP-20260101-001'))).toBe(false)
    expect(existsSync(join(repo, 'baselines'))).toBe(false)
    expect(readCounters(repo).product.baselineSeq['20260101']).toBeUndefined()
  })
})

// ==========================================================================
// reconcileCrs — direct unit tests (v3: impact-based resolution, Task 6)
// ==========================================================================

describe('reconcileCrs', () => {
  it('resolves a CR whose spawn impact is realized + baselined + traces_to it', () => {
    const repo = makeRepo()
    seedCr(repo, 'CR-001', 'confirmed', { impacts: [{ spawns: 'fr', epic: 'E1', realized: 'E1-FR1' }] })
    seedFr(repo, 'E1-FR1', 'E1', { status: 'baselined', baseline: 'BL-20250101', tracesTo: ['CR-001'] })
    reconcileCrs(repo, ['CR-001'], '20260101')
    expect(readFm(repo, 'cr/CR-001.md', 'cr')).toMatchObject({ status: 'resolved' })
  })

  it('leaves a CR alone when not every impact is delivered (one spawn target still active)', () => {
    const repo = makeRepo()
    seedCr(repo, 'CR-001', 'confirmed', {
      impacts: [
        { spawns: 'fr', epic: 'E1', realized: 'E1-FR1' },
        { spawns: 'fr', epic: 'E1', realized: 'E1-FR2' },
      ],
    })
    seedFr(repo, 'E1-FR1', 'E1', { status: 'baselined', baseline: 'BL-20250101', tracesTo: ['CR-001'] })
    seedFr(repo, 'E1-FR2', 'E1', { status: 'active', tracesTo: ['CR-001'] })
    reconcileCrs(repo, ['CR-001'], '20260101')
    expect(readFm(repo, 'cr/CR-001.md', 'cr')).toMatchObject({ status: 'confirmed' })
  })

  it('is a no-op on a CR with no impacts declared', () => {
    const repo = makeRepo()
    seedCr(repo, 'CR-001', 'confirmed')
    reconcileCrs(repo, ['CR-001'], '20260101')
    expect(readFm(repo, 'cr/CR-001.md', 'cr')).toMatchObject({ status: 'confirmed' })
  })

  it('is a no-op on an already-resolved CR', () => {
    const repo = makeRepo()
    seedCr(repo, 'CR-001', 'resolved')
    seedFr(repo, 'E1-FR1', 'E1', { status: 'active', tracesTo: ['CR-001'] })
    reconcileCrs(repo, ['CR-001'], '20260101')
    expect(readFm(repo, 'cr/CR-001.md', 'cr')).toMatchObject({ status: 'resolved' })
  })

  it('is a no-op given an empty affectedCrIds list', () => {
    const repo = makeRepo()
    seedCr(repo, 'CR-001', 'confirmed')
    expect(() => reconcileCrs(repo, [], '20260101')).not.toThrow()
    expect(readFm(repo, 'cr/CR-001.md', 'cr')).toMatchObject({ status: 'confirmed' })
  })

  it('rejects a malformed date', () => {
    const repo = makeRepo()
    expect(() => reconcileCrs(repo, ['CR-001'], '2026-01-01')).toThrow(/YYYYMMDD/)
  })
})

// ==========================================================================
// reconcile v3 — impact-based CR resolution (Task 6)
//
// The resolution predicate is built off a CR's OWN typed `impacts` set
// (schema.ts's `CrImpact`), not a reverse-walked derived set: an `amends`
// entry is delivered when its target exists, is `baselined`, and its own
// `## History` cites this CR (`history.ts`'s `historyCrRefs`); a `spawns`
// entry is delivered when its `realized` id has been stamped, resolves to a
// real page that is `baselined`, and — for a FR/NFR only, a BR has no
// `traces_to` field to check — that page's `traces_to` includes this CR. A
// CR with an empty (or absent) `impacts` array never auto-resolves.
// ==========================================================================

describe('reconcile v3', () => {
  it('resolves only once BOTH an amends impact (History cites the CR) and a spawn impact (realized + baselined + traces_to) are satisfied', () => {
    const repo = makeRepo()
    seedCr(repo, 'CR-003', 'confirmed', {
      impacts: [{ amends: 'E1-FR1' }, { spawns: 'fr', epic: 'E1', realized: 'E1-FR2' }],
    })
    seedFr(repo, 'E1-FR1', 'E1', { status: 'active' })
    seedFr(repo, 'E1-FR2', 'E1', { status: 'active', tracesTo: ['CR-003'] })

    reconcileCrs(repo, ['CR-003'], '20260101')
    expect(readFm(repo, 'cr/CR-003.md', 'cr')).toMatchObject({ status: 'confirmed' })

    // Only the amends target lands (baselined + its History cites the CR) —
    // the spawn target is still active: the CR must stay unresolved.
    seedFr(repo, 'E1-FR1', 'E1', {
      status: 'baselined',
      baseline: 'BL-20251231',
      body: 'Story body.\n\n## History\n\n### v1 — 20260101 — CR-003\n\nOld body.\n',
    })
    reconcileCrs(repo, ['CR-003'], '20260101')
    expect(readFm(repo, 'cr/CR-003.md', 'cr')).toMatchObject({ status: 'confirmed' })

    // Now the spawn target also lands (baselined + traces_to includes the
    // CR) — both impacts are delivered, the CR resolves.
    seedFr(repo, 'E1-FR2', 'E1', { status: 'baselined', baseline: 'BL-20251231', tracesTo: ['CR-003'] })
    reconcileCrs(repo, ['CR-003'], '20260101')
    expect(readFm(repo, 'cr/CR-003.md', 'cr')).toMatchObject({ status: 'resolved' })
  })

  it('blocks when a spawn impact has no realized id stamped, even though a real FR separately traces to and baselines under this CR', () => {
    const repo = makeRepo()
    seedCr(repo, 'CR-004', 'confirmed', { impacts: [{ spawns: 'fr', epic: 'E1' }] })
    // E1-FR3 traces to CR-004 and IS baselined, but the CR's own impact entry
    // was never stamped `realized` (`realizeCrSpawn` never ran) — the
    // predicate reads the impact's OWN realized id, it never re-derives one
    // from traces_to.
    seedFr(repo, 'E1-FR3', 'E1', { status: 'baselined', baseline: 'BL-20251231', tracesTo: ['CR-004'] })
    reconcileCrs(repo, ['CR-004'], '20260101')
    expect(readFm(repo, 'cr/CR-004.md', 'cr')).toMatchObject({ status: 'confirmed' })
  })

  it("blocks when a spawn impact's realized target is baselined but its traces_to omits the CR", () => {
    const repo = makeRepo()
    seedCr(repo, 'CR-005', 'confirmed', { impacts: [{ spawns: 'fr', epic: 'E1', realized: 'E1-FR4' }] })
    seedFr(repo, 'E1-FR4', 'E1', { status: 'baselined', baseline: 'BL-20251231', tracesTo: [] })
    reconcileCrs(repo, ['CR-005'], '20260101')
    expect(readFm(repo, 'cr/CR-005.md', 'cr')).toMatchObject({ status: 'confirmed' })
  })

  it('resolves a BR spawn impact off realized + baselined alone — a BR has no traces_to field to check', () => {
    const repo = makeRepo()
    seedCr(repo, 'CR-006', 'confirmed', { impacts: [{ spawns: 'br', epic: 'E1', realized: 'E1-BR2' }] })
    seedBr(repo, 'E1-BR2', 'E1', { status: 'baselined', baseline: 'BL-20251231' })
    reconcileCrs(repo, ['CR-006'], '20260101')
    expect(readFm(repo, 'cr/CR-006.md', 'cr')).toMatchObject({ status: 'resolved' })
  })

  it('blocks an amends impact whose target is baselined but whose History does not cite the CR', () => {
    const repo = makeRepo()
    seedCr(repo, 'CR-007', 'confirmed', { impacts: [{ amends: 'E1-FR5' }] })
    seedFr(repo, 'E1-FR5', 'E1', {
      status: 'baselined',
      baseline: 'BL-20251231',
      body: 'Story body only, no History section.',
    })
    reconcileCrs(repo, ['CR-007'], '20260101')
    expect(readFm(repo, 'cr/CR-007.md', 'cr')).toMatchObject({ status: 'confirmed' })
  })

  it('never auto-resolves a CR with no impacts declared, even when a real FR traces to it and is fully baselined (unchanged v2 posture)', () => {
    const repo = makeRepo()
    seedCr(repo, 'CR-008', 'confirmed') // no impacts field at all
    seedFr(repo, 'E1-FR6', 'E1', { status: 'baselined', baseline: 'BL-20251231', tracesTo: ['CR-008'] })
    reconcileCrs(repo, ['CR-008'], '20260101')
    expect(readFm(repo, 'cr/CR-008.md', 'cr')).toMatchObject({ status: 'confirmed' })
  })

  it('blocks an amends impact whose target id does not resolve to a real page at all', () => {
    const repo = makeRepo()
    seedCr(repo, 'CR-009', 'confirmed', { impacts: [{ amends: 'E1-FR99' }] })
    reconcileCrs(repo, ['CR-009'], '20260101')
    expect(readFm(repo, 'cr/CR-009.md', 'cr')).toMatchObject({ status: 'confirmed' })
  })
})

// ==========================================================================
// reconcile v3 — provenance-gated backfill relaxation (Task 9b)
//
// A CR migrated with `provenance: backfilled` carries a factually
// reconstructed `impacts` set but, by explicit design, no fabricated
// `## History` citation on an amended target and no retroactive `traces_to`
// addition on a spawned target's `traces_to`. `crImpactsDelivered` skips
// exactly those two evidentiary checks when `backfilled` is true — the
// `baselined`-status requirement is never skipped, for either branch, since
// it's read live off the target rather than something the migration would
// have had to fabricate.
// ==========================================================================

describe('reconcile v3 — provenance-gated backfill relaxation (Task 9b)', () => {
  it('resolves a backfilled CR whose amends target is baselined with NO History citation', () => {
    const repo = makeRepo()
    seedCr(repo, 'CR-010', 'confirmed', { impacts: [{ amends: 'E1-FR10' }], provenance: 'backfilled' })
    seedFr(repo, 'E1-FR10', 'E1', {
      status: 'baselined',
      baseline: 'BL-20251231',
      body: 'Story body only, no History section.',
    })
    reconcileCrs(repo, ['CR-010'], '20260101')
    expect(readFm(repo, 'cr/CR-010.md', 'cr')).toMatchObject({ status: 'resolved' })
  })

  it('is provenance-gated: the identical shape WITHOUT provenance: backfilled stays confirmed', () => {
    const repo = makeRepo()
    seedCr(repo, 'CR-011', 'confirmed', { impacts: [{ amends: 'E1-FR11' }] })
    seedFr(repo, 'E1-FR11', 'E1', {
      status: 'baselined',
      baseline: 'BL-20251231',
      body: 'Story body only, no History section.',
    })
    reconcileCrs(repo, ['CR-011'], '20260101')
    expect(readFm(repo, 'cr/CR-011.md', 'cr')).toMatchObject({ status: 'confirmed' })
  })

  it('resolves a backfilled CR whose realized spawn is baselined but whose traces_to omits the CR', () => {
    const repo = makeRepo()
    seedCr(repo, 'CR-012', 'confirmed', {
      impacts: [{ spawns: 'fr', epic: 'E1', realized: 'E1-FR12' }],
      provenance: 'backfilled',
    })
    seedFr(repo, 'E1-FR12', 'E1', { status: 'baselined', baseline: 'BL-20251231', tracesTo: [] })
    reconcileCrs(repo, ['CR-012'], '20260101')
    expect(readFm(repo, 'cr/CR-012.md', 'cr')).toMatchObject({ status: 'resolved' })
  })

  it('leaves a backfilled CR alone when its amends target is still active — the baselined-status requirement survives the relaxation', () => {
    const repo = makeRepo()
    seedCr(repo, 'CR-013', 'confirmed', { impacts: [{ amends: 'E1-FR13' }], provenance: 'backfilled' })
    seedFr(repo, 'E1-FR13', 'E1', { status: 'active' })
    reconcileCrs(repo, ['CR-013'], '20260101')
    expect(readFm(repo, 'cr/CR-013.md', 'cr')).toMatchObject({ status: 'confirmed' })
  })
})
