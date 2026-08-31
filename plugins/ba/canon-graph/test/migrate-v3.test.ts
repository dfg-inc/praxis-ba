// ---- migrate-v3.test.ts: the v2→v3 canon migration + parity verdict (Task 9)
// ----
//
// The fixture is a mini v2 canon replicating today's REAL `product/` shapes
// (verified against the repo's own `product/wp/*.md`/`product/cr/*.md` during
// this task): a flat `wp/<id>.md` page with `fr_ids`, a second one with
// `extra_brs` + a DANGLING `plan` reference, a `## Planguage`-anchored NFR, a
// `## Acceptance Criteria`-anchored FR, a `## History` section with a
// never-demoted nested `## History` block buried inside an entry, a
// `.ba/config.yaml` with no `link_root` yet, and `counters.yaml` seeded with
// `bug: 1` (the real corpus's own pre-migration value, per project memory —
// BUG-013 is open, so the migrated floor must be >= 13).
//
// `repoRoot` is a SEPARATE, git-initialized temp dir with `canonDir` as its
// `canon/` subdirectory — mirrors the real monorepo layout (`repoRoot` =
// budget-scout, `canonDir` = `product/`) closely enough for `git mv` to be
// exercised for real, matching `cli.ts`'s own `repo-root` default
// (`resolve(repo, '..')`).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { stringify as yamlStringify } from 'yaml'
import { describe, it, expect, afterEach } from 'vitest'
import { migrateV3, snapshotForParity, verifyParityV3, type BackfillMap, type ParitySnapshot } from '../src/migrate-v3'
import { parseFile } from '../src/parse'
import { loadGraph, crPath, wpPath } from '../src/writer'
import { readCounters, type Counters } from '../src/ids'
import { crImpactsDelivered, requirementNodeIndex } from '../src/reconcile'
import type { CrImpact } from '../src/schema'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function seedRaw(root: string, relPath: string, content: string): string {
  const path = join(root, relPath)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, 'utf8')
  return path
}

function baseCounters(overrides: Partial<Counters['product']> = {}): Counters {
  return {
    product: { epic: 1, cr: 2, wp: 2, bug: 1, baselineSeq: { '20260630': 1 }, ...overrides },
    epics: { E1: { fr: 3, nfr: 1, br: 2 } },
    retired: [],
  }
}

// ---- the "content between entry headings demotes; entry headings + a
// deliberately un-demoted NESTED `## History` block both get exercised" body
// for E1-FR3 (Task 9's own controller addendum requires the nested case). ----
const NESTED_HISTORY_BODY = [
  'Statement.',
  '',
  '## Acceptance Criteria',
  '',
  '- AC-1: something.',
  '',
  '## History',
  '',
  '### v2 — 20260610 — CR-050',
  '',
  '## Old Section',
  'Some reasoning that was never demoted.',
  '',
  '## History',
  'Old changelog notes that were embedded without demotion (legacy, pre-v3).',
  '',
  '### v1 — 20260601 — CR-040',
  '',
  'Oldest body text.',
  '',
].join('\n')

const NESTED_HISTORY_BODY_DEMOTED = [
  'Statement.',
  '',
  '## Acceptance Criteria',
  '',
  '- AC-1: something.',
  '',
  '## History',
  '',
  '### v2 — 20260610 — CR-050',
  '',
  '#### Old Section',
  'Some reasoning that was never demoted.',
  '',
  '#### History',
  'Old changelog notes that were embedded without demotion (legacy, pre-v3).',
  '',
  '### v1 — 20260601 — CR-040',
  '',
  'Oldest body text.',
  '',
].join('\n')

/** Builds the full mini v2 canon (see file header) under a fresh
 * `{repoRoot, canonDir}` pair, `git init`s + stages `repoRoot` so `git mv`
 * has real, tracked sources to move. Returns everything a test needs to
 * assert against, plus a ready-to-use `backfill` map (CR-001 covered,
 * CR-002 deliberately absent -> advisory). */
function seedV2Fixture(): { repoRoot: string; canonDir: string; backfill: BackfillMap } {
  const repoRoot = makeTempDir('canon-migrate-v3-root-')
  const canonDir = join(repoRoot, 'canon')

  // ---- machine state ----
  seedRaw(canonDir, join('.ba', 'counters.yaml'), yamlStringify(baseCounters()))
  seedRaw(
    canonDir,
    join('.ba', 'config.yaml'),
    yamlStringify({ canon_roots: ['vision.md', 'epics/', 'br/', 'cr/', 'wp/', 'bugs/'] })
  )

  // ---- epic ----
  seedRaw(canonDir, join('epics', 'E1-x', 'index.md'), '---\nid: E1\ntype: epic\ntitle: Epic One\nstatus: active\n---\n')

  // ---- E1-FR1: delivered by WP-001, baselined (so CR-001's backfilled spawn
  // impact can resolve), traces_to CR-001, enforces E1-BR1, references
  // E1-NFR1, carries a real `## Acceptance Criteria` anchor. ----
  seedRaw(
    canonDir,
    join('epics', 'E1-x', 'E1-FR1.md'),
    [
      '---',
      'id: E1-FR1',
      'type: fr',
      'epic: E1',
      'status: baselined',
      'version: 2',
      'traces_to:',
      '  - CR-001',
      'enforces:',
      '  - E1-BR1',
      'references_nfr:',
      '  - E1-NFR1',
      'related: []',
      'baseline: BL-20260630',
      '---',
      '',
      'As a user, I want X, so that Y.',
      '',
      '## Acceptance Criteria',
      '',
      '- AC-1: something observable happens.',
      '',
    ].join('\n')
  )

  // ---- E1-FR2: delivered by WP-002, no CR trace (so Change requests is
  // correctly OMITTED for that WP), no AC anchor (so the anchor is correctly
  // omitted from its Delivers link too). ----
  seedRaw(
    canonDir,
    join('epics', 'E1-x', 'E1-FR2.md'),
    ['---', 'id: E1-FR2', 'type: fr', 'epic: E1', 'status: active', 'version: 1', 'traces_to: []', 'enforces: []', 'references_nfr: []', 'related: []', '---', '', 'As a user, I want Z.', ''].join(
      '\n'
    )
  )

  // ---- E1-FR3: untouched by any WP — exists purely to exercise History
  // demotion (nested, never-demoted content). ----
  seedRaw(
    canonDir,
    join('epics', 'E1-x', 'E1-FR3.md'),
    ['---', 'id: E1-FR3', 'type: fr', 'epic: E1', 'status: active', 'version: 2', 'traces_to: []', 'enforces: []', 'references_nfr: []', 'related: []', '---', '', NESTED_HISTORY_BODY].join('\n')
  )

  // ---- E1-NFR1: `## Planguage`-anchored, referenced by E1-FR1. Its own
  // `traces_to: [CR-001]` matters to parity (review fix): snapshotForParity
  // records NFR->CR rtm edges too, so verifyParityV3's post-migration edge
  // reconstruction MUST rebuild them symmetrically or rtm-superset
  // false-fails on exactly this page shape (>=12 such NFRs in the real
  // corpus, e.g. E1-NFR5..11 -> CR-001). ----
  seedRaw(
    canonDir,
    join('epics', 'E1-x', 'E1-NFR1.md'),
    [
      '---',
      'id: E1-NFR1',
      'type: nfr',
      'epic: E1',
      'status: active',
      'version: 1',
      'traces_to:',
      '  - CR-001',
      'verified_by: []',
      'related: []',
      '---',
      '',
      '## Planguage',
      '',
      '- Tag: a constraint.',
      '- Scale: something measurable.',
      '- Meter: how it is measured.',
      '- Goal: the target.',
      '',
    ].join('\n')
  )

  // ---- E1-BR1 (enforced by E1-FR1), E1-BR2 (only via WP-002's extra_brs). ----
  seedRaw(
    canonDir,
    join('br', 'E1-BR1.md'),
    ['---', 'id: E1-BR1', 'type: br', 'epic: E1', 'kind: operative', 'enforcement: advisory', 'status: active', 'version: 1', '---', '', 'A rule.', ''].join('\n')
  )
  seedRaw(
    canonDir,
    join('br', 'E1-BR2.md'),
    ['---', 'id: E1-BR2', 'type: br', 'epic: E1', 'kind: operative', 'enforcement: advisory', 'status: active', 'version: 1', '---', '', 'Another rule.', ''].join('\n')
  )

  // ---- CR-001 (legacy `entry_point: solution`, covered by the backfill map
  // below) / CR-002 (same legacy shape, deliberately UNCOVERED -> advisory). ----
  seedRaw(
    canonDir,
    join('cr', 'CR-001.md'),
    ['---', 'id: CR-001', 'type: cr', 'status: confirmed', 'entry_point: solution', 'entry_point_confirmed: true', '---', '', 'Do the first thing.', ''].join('\n')
  )
  seedRaw(
    canonDir,
    join('cr', 'CR-002.md'),
    ['---', 'id: CR-002', 'type: cr', 'status: confirmed', 'entry_point: solution', 'entry_point_confirmed: true', '---', '', 'Do the second thing.', ''].join('\n')
  )

  // ---- the real plan file WP-001 references (repo-root-relative, legacy
  // `thoughts/shared/plans/` convention) — WP-002's plan reference is
  // deliberately DANGLING (no file ever created at that path). ----
  seedRaw(repoRoot, join('thoughts', 'shared', 'plans', '2026-plan-one.md'), '# Plan one\n\nDo the work.\n')

  // ---- legacy flat WPs ----
  seedRaw(
    canonDir,
    join('wp', 'WP-20260701-001.md'),
    [
      '---',
      'id: WP-20260701-001',
      'type: wp',
      'role: developer',
      'status: accepted',
      'fr_ids:',
      '  - E1-FR1',
      'plan: thoughts/shared/plans/2026-plan-one.md',
      '---',
      '',
      'Migrated from v1 WP-20260701-001 (role: developer). FR scope: E1-FR1.',
      '',
    ].join('\n')
  )
  seedRaw(
    canonDir,
    join('wp', 'WP-20260701-002.md'),
    [
      '---',
      'id: WP-20260701-002',
      'type: wp',
      'role: developer',
      'status: accepted',
      'fr_ids:',
      '  - E1-FR2',
      'extra_brs:',
      '  - E1-BR2',
      'plan: thoughts/shared/plans/missing-plan.md',
      '---',
      '',
      'Migrated from v1 WP-20260701-002 (role: developer). FR scope: E1-FR2.',
      '',
    ].join('\n')
  )

  // ---- git init + stage everything, so `git mv` has real tracked sources. ----
  execSync('git init -q', { cwd: repoRoot })
  execSync('git add -A', { cwd: repoRoot })

  const backfill: BackfillMap = {
    'CR-001': { impacts: [{ spawns: 'fr', epic: 'E1', realized: 'E1-FR1' }] },
  }

  return { repoRoot, canonDir, backfill }
}

function readFm(canonDir: string, relPath: string, type: 'fr' | 'nfr' | 'br' | 'cr' | 'wp'): Record<string, unknown> {
  const result = parseFile(join(canonDir, relPath), type)
  if ('error' in result) throw new Error(`fixture read failed: ${result.error}`)
  return result.frontmatter as Record<string, unknown>
}

function readBody(canonDir: string, relPath: string, type: 'fr' | 'nfr' | 'br' | 'cr' | 'wp'): string {
  const result = parseFile(join(canonDir, relPath), type)
  if ('error' in result) throw new Error(`fixture read failed: ${result.error}`)
  return result.body
}

// ==========================================================================
// migrateV3 — WP folder moves + Scope generation
// ==========================================================================

describe('migrateV3 — WP folder moves + Scope generation', () => {
  it('moves a legacy flat WP into folder form, moves its plan file via git mv, and generates the exact golden ## Scope section', () => {
    const { repoRoot, canonDir, backfill } = seedV2Fixture()
    const linkRoot = basename(canonDir)

    const result = migrateV3(canonDir, repoRoot, backfill, '20260718')

    // ---- folder move ----
    expect(existsSync(join(canonDir, 'wp', 'WP-20260701-001.md'))).toBe(false)
    expect(existsSync(wpPath(canonDir, 'WP-20260701-001'))).toBe(true)
    expect(result.moved).toContainEqual({ from: 'wp/WP-20260701-001.md', to: 'wp/WP-20260701-001/index.md' })

    // ---- plan move (git mv, tracked source) ----
    expect(existsSync(join(repoRoot, 'thoughts', 'shared', 'plans', '2026-plan-one.md'))).toBe(false)
    const newPlanPath = join(canonDir, 'wp', 'WP-20260701-001', 'plan.md')
    expect(existsSync(newPlanPath)).toBe(true)
    expect(readFileSync(newPlanPath, 'utf8')).toBe('# Plan one\n\nDo the work.\n')
    expect(result.moved).toContainEqual({ from: 'thoughts/shared/plans/2026-plan-one.md', to: 'wp/WP-20260701-001/plan.md' })

    // ---- frontmatter: slim v3 shape, plan rewritten to the new convention ----
    const fm = readFm(canonDir, 'wp/WP-20260701-001/index.md', 'wp')
    expect(fm).toEqual({
      id: 'WP-20260701-001',
      type: 'wp',
      role: 'developer',
      status: 'accepted',
      plan: 'wp/WP-20260701-001/plan.md',
    })

    // ---- golden-string Scope body ----
    const expectedBody = [
      'Migrated from v1 WP-20260701-001 (role: developer). FR scope: E1-FR1.',
      '',
      '## Scope',
      '',
      '### Change requests',
      `- [CR-001](../../cr/CR-001.md)`,
      '',
      '### Delivers',
      `- [E1-FR1 v2](../../epics/E1-x/E1-FR1.md#acceptance-criteria)`,
      '',
      '### Constraints',
      `- [E1-BR1 v1](../../br/E1-BR1.md)`,
      `- [E1-NFR1 v1](../../epics/E1-x/E1-NFR1.md#planguage)`,
    ].join('\n')
    expect(readBody(canonDir, 'wp/WP-20260701-001/index.md', 'wp').trim()).toBe(expectedBody.trim())
  })

  it('unions extra_brs into Constraints, omits an empty Change requests section, and advises (without moving/rewriting) a dangling plan reference', () => {
    const { repoRoot, canonDir, backfill } = seedV2Fixture()
    const linkRoot = basename(canonDir)

    const result = migrateV3(canonDir, repoRoot, backfill, '20260718')

    const body = readBody(canonDir, 'wp/WP-20260701-002/index.md', 'wp')
    expect(body).not.toContain('### Change requests') // E1-FR2 traces to no CR
    expect(body).toContain(`- [E1-FR2 v1](../../epics/E1-x/E1-FR2.md)`) // no AC anchor on E1-FR2
    expect(body).toContain(`- [E1-BR2 v1](../../br/E1-BR2.md)`) // extra_brs flowed through

    // dangling plan: left unchanged, no move attempted
    const fm = readFm(canonDir, 'wp/WP-20260701-002/index.md', 'wp')
    expect(fm.plan).toBe('thoughts/shared/plans/missing-plan.md')
    expect(existsSync(join(canonDir, 'wp', 'WP-20260701-002', 'plan.md'))).toBe(false)
    expect(result.advisories.some((a) => a.includes('WP-20260701-002') && a.includes('missing-plan.md'))).toBe(true)
  })

  it('falls back to rename + best-effort git add when repoRoot is not a git repo at all', () => {
    const repoRoot = makeTempDir('canon-migrate-v3-nogit-')
    const canonDir = join(repoRoot, 'canon')
    seedRaw(canonDir, join('.ba', 'counters.yaml'), yamlStringify(baseCounters({ wp: 1, cr: 0 })))
    seedRaw(canonDir, join('.ba', 'config.yaml'), yamlStringify({ canon_roots: ['epics/', 'br/', 'cr/', 'wp/'] }))
    seedRaw(canonDir, join('epics', 'E1-x', 'index.md'), '---\nid: E1\ntype: epic\ntitle: Epic One\nstatus: active\n---\n')
    seedRaw(
      canonDir,
      join('epics', 'E1-x', 'E1-FR1.md'),
      ['---', 'id: E1-FR1', 'type: fr', 'epic: E1', 'status: active', 'version: 1', 'traces_to: []', 'enforces: []', 'references_nfr: []', 'related: []', '---', '', 'Story.', ''].join('\n')
    )
    seedRaw(repoRoot, join('thoughts', 'plan.md'), '# A plan\n')
    seedRaw(
      canonDir,
      join('wp', 'WP-20260701-001.md'),
      ['---', 'id: WP-20260701-001', 'type: wp', 'role: developer', 'status: draft', 'fr_ids:', '  - E1-FR1', 'plan: thoughts/plan.md', '---', '', 'Goal sentence.', ''].join('\n')
    )
    // deliberately NO `git init` here.

    const result = migrateV3(canonDir, repoRoot, {}, '20260718')

    expect(existsSync(join(canonDir, 'wp', 'WP-20260701-001.md'))).toBe(false)
    expect(existsSync(wpPath(canonDir, 'WP-20260701-001'))).toBe(true)
    expect(existsSync(join(canonDir, 'wp', 'WP-20260701-001', 'plan.md'))).toBe(true)
    expect(readFileSync(join(canonDir, 'wp', 'WP-20260701-001', 'plan.md'), 'utf8')).toBe('# A plan\n')
    expect(result.moved.length).toBe(2)
  })
})

// ==========================================================================
// migrateV3 — CR transform (entry_point + backfill)
// ==========================================================================

describe('migrateV3 — CR transform', () => {
  it("maps legacy entry_point:'solution' -> 'requirement', applies the backfill map + provenance, and advises a confirmed CR the map doesn't cover", () => {
    const { repoRoot, canonDir, backfill } = seedV2Fixture()
    const result = migrateV3(canonDir, repoRoot, backfill, '20260718')

    const cr1 = readFm(canonDir, 'cr/CR-001.md', 'cr')
    expect(cr1.entry_point).toBe('requirement')
    expect(cr1.impacts).toEqual([{ spawns: 'fr', epic: 'E1', realized: 'E1-FR1' }])
    expect(cr1.provenance).toBe('backfilled')
    // The backfilled impact set is fully delivered (E1-FR1 baselined + traces
    // to CR-001) — the final reconcile step resolves it in this same run.
    expect(cr1.status).toBe('resolved')

    const cr2 = readFm(canonDir, 'cr/CR-002.md', 'cr')
    expect(cr2.entry_point).toBe('requirement')
    expect(cr2.impacts ?? []).toEqual([])
    expect(cr2.status).toBe('confirmed') // never auto-resolves with no impacts
    expect(result.advisories.some((a) => a.includes('CR-002') && a.includes('no backfill entry'))).toBe(true)
  })

  it('applies the backfill map to an already-RESOLVED CR too (real-canon defect: CR-005/CR-010 are `resolved` and were silently skipped when the backfill step only looked at confirmed CRs)', () => {
    const { repoRoot, canonDir, backfill } = seedV2Fixture()

    // Extra fixture: a legacy v2 CR that is ALREADY `resolved` (not
    // `confirmed`), with a backfill entry — a spawn realized against an
    // already-baselined FR, exactly the shape CR-005/CR-010 have on the real
    // canon.
    seedRaw(
      canonDir,
      join('epics', 'E1-x', 'E1-FR4.md'),
      [
        '---',
        'id: E1-FR4',
        'type: fr',
        'epic: E1',
        'status: baselined',
        'version: 1',
        'traces_to:',
        '  - CR-003',
        'enforces: []',
        'references_nfr: []',
        'related: []',
        'baseline: BL-20260630',
        '---',
        '',
        'As a user, I want W.',
        '',
      ].join('\n')
    )
    seedRaw(
      canonDir,
      join('cr', 'CR-003.md'),
      ['---', 'id: CR-003', 'type: cr', 'status: resolved', 'entry_point: solution', 'entry_point_confirmed: true', '---', '', 'Do the third thing.', ''].join('\n')
    )
    const fullBackfill: BackfillMap = { ...backfill, 'CR-003': { impacts: [{ spawns: 'fr', epic: 'E1', realized: 'E1-FR4' }] } }

    migrateV3(canonDir, repoRoot, fullBackfill, '20260718')

    const cr3 = readFm(canonDir, 'cr/CR-003.md', 'cr')
    expect(cr3.entry_point).toBe('requirement')
    expect(cr3.impacts).toEqual([{ spawns: 'fr', epic: 'E1', realized: 'E1-FR4' }])
    expect(cr3.provenance).toBe('backfilled')
    expect(cr3.status).toBe('resolved') // unchanged — already resolved pre-migration

    // The `cr-impacts-consistent` predicate (validate's hard gate) must now
    // find CR-003's impacts provably delivered, not empty.
    const graph = loadGraph(canonDir)
    const nodeOf = requirementNodeIndex(graph)
    expect(crImpactsDelivered(nodeOf, 'CR-003', cr3.impacts as CrImpact[], true)).toBe(true)
  })
})

// ==========================================================================
// migrateV3 — History demotion (incl. nested-History opacity)
// ==========================================================================

describe('migrateV3 — History demotion', () => {
  it('demotes ##/### headings between entry headings, INCLUDING a never-demoted nested ## History block, while entry headings stay ###', () => {
    const { repoRoot, canonDir, backfill } = seedV2Fixture()
    migrateV3(canonDir, repoRoot, backfill, '20260718')

    const body = readBody(canonDir, 'epics/E1-x/E1-FR3.md', 'fr')
    expect(body.trim()).toBe(NESTED_HISTORY_BODY_DEMOTED.trim())
    // entry headings themselves are untouched
    expect(body).toContain('### v2 — 20260610 — CR-050')
    expect(body).toContain('### v1 — 20260601 — CR-040')
    // content between them (including the nested History block) is demoted
    expect(body).toContain('#### Old Section')
    expect(body).toContain('#### History')
    expect(body).not.toMatch(/^## Old Section$/m)
    // exactly ONE top-level `## History` heading survives (the section's own,
    // never demoted); the nested one was demoted to `#### History` above.
    const topLevelHistoryCount = (body.match(/^## History$/gm) ?? []).length
    expect(topLevelHistoryCount).toBe(1)
  })
})

// ==========================================================================
// migrateV3 — counters + config
// ==========================================================================

describe('migrateV3 — counters + config', () => {
  it('floors product.bug at 13 and seeds link_root, preserving existing config content/order', () => {
    const { repoRoot, canonDir, backfill } = seedV2Fixture()
    migrateV3(canonDir, repoRoot, backfill, '20260718')

    expect(readCounters(canonDir).product.bug).toBe(13)

    const rawConfig = readFileSync(join(canonDir, '.ba', 'config.yaml'), 'utf8')
    expect(rawConfig).toContain('canon_roots:')
    expect(rawConfig).toContain('link_root:')
    // canon_roots content/order preserved
    const canonRootsIndex = rawConfig.indexOf('canon_roots:')
    const visionIndex = rawConfig.indexOf('vision.md')
    expect(visionIndex).toBeGreaterThan(canonRootsIndex)
  })
})

// ==========================================================================
// migrateV3 — idempotence
// ==========================================================================

describe('migrateV3 — idempotence', () => {
  it('a second run writes/moves nothing and never overwrites the pre-migration snapshot', () => {
    const { repoRoot, canonDir, backfill } = seedV2Fixture()

    const first = migrateV3(canonDir, repoRoot, backfill, '20260718')
    expect(first.written.length).toBeGreaterThan(0)
    expect(first.moved.length).toBeGreaterThan(0)

    const snapshotPath = join(canonDir, '.ba', 'cache', 'migrate-v3-snapshot.json')
    const snapshotAfterFirst = readFileSync(snapshotPath, 'utf8')

    const second = migrateV3(canonDir, repoRoot, backfill, '20260719')
    expect(second.written).toEqual([])
    expect(second.moved).toEqual([])
    expect(readFileSync(snapshotPath, 'utf8')).toBe(snapshotAfterFirst)

    // Idempotent end-state still holds (not just "nothing written")
    expect(readFm(canonDir, 'cr/CR-001.md', 'cr').status).toBe('resolved')
    expect(readCounters(canonDir).product.bug).toBe(13)
  })
})

// ==========================================================================
// snapshotForParity / verifyParityV3
// ==========================================================================

describe('verifyParityV3', () => {
  it('is VERIFY-OK across all six checks for a clean migration', () => {
    const { repoRoot, canonDir, backfill } = seedV2Fixture()
    const snapshot = snapshotForParity(canonDir, repoRoot)

    migrateV3(canonDir, repoRoot, backfill, '20260718')

    const verdict = verifyParityV3(snapshot, canonDir, repoRoot)
    for (const check of verdict.checks) expect(check.ok, `${check.name}: ${check.reason}`).toBe(true)
    expect(verdict.verdict).toBe('VERIFY-OK')
  })

  it('rtm-superset stays ok when an NFR carries a non-empty traces_to (the snapshot records NFR->CR edges; the post-migration reconstruction must rebuild them symmetrically)', () => {
    const { repoRoot, canonDir, backfill } = seedV2Fixture()
    const snapshot = snapshotForParity(canonDir, repoRoot)

    // The snapshot side really does record the NFR->CR edge — without this
    // premise the assertion below would pass vacuously.
    expect(snapshot.rtmEdges).toContainEqual({ from: 'E1-NFR1', to: 'CR-001' })

    migrateV3(canonDir, repoRoot, backfill, '20260718')

    const verdict = verifyParityV3(snapshot, canonDir, repoRoot)
    const rtmCheck = verdict.checks.find((c) => c.name === 'rtm-superset')
    expect(rtmCheck?.ok, rtmCheck?.reason).toBe(true)
  })

  it("migrateV3's own internal pre-migration snapshot matches a fresh snapshotForParity call over the same starting state", () => {
    const { repoRoot, canonDir, backfill } = seedV2Fixture()
    const expected = snapshotForParity(canonDir, repoRoot)

    migrateV3(canonDir, repoRoot, backfill, '20260718')

    const onDisk = JSON.parse(readFileSync(join(canonDir, '.ba', 'cache', 'migrate-v3-snapshot.json'), 'utf8')) as ParitySnapshot
    expect(onDisk).toEqual(expected)
  })

  it('flags plan-content-identical as VERIFY-FAIL when a migrated plan file is corrupted post-move', () => {
    const { repoRoot, canonDir, backfill } = seedV2Fixture()
    const snapshot = snapshotForParity(canonDir, repoRoot)
    migrateV3(canonDir, repoRoot, backfill, '20260718')

    const planPath = join(canonDir, 'wp', 'WP-20260701-001', 'plan.md')
    writeFileSync(planPath, 'TAMPERED CONTENT\n', 'utf8')

    const verdict = verifyParityV3(snapshot, canonDir, repoRoot)
    expect(verdict.verdict).toBe('VERIFY-FAIL')
    const planCheck = verdict.checks.find((c) => c.name === 'plan-content-identical')
    expect(planCheck?.ok).toBe(false)
    expect(planCheck?.reason).toContain('WP-20260701-001')
  })

  it('flags same-id-set as VERIFY-FAIL when a snapshot id goes missing post-migration', () => {
    const { repoRoot, canonDir, backfill } = seedV2Fixture()
    const snapshot = snapshotForParity(canonDir, repoRoot)
    migrateV3(canonDir, repoRoot, backfill, '20260718')

    rmSync(join(canonDir, 'cr', 'CR-002.md'))

    const graphSanity = loadGraph(canonDir) // sanity: CR-002 really is gone from the live graph now
    expect(graphSanity.crs.some((c) => c.frontmatter.id === 'CR-002')).toBe(false)

    const verdict = verifyParityV3(snapshot, canonDir, repoRoot)
    expect(verdict.verdict).toBe('VERIFY-FAIL')
    const idCheck = verdict.checks.find((c) => c.name === 'same-id-set')
    expect(idCheck?.ok).toBe(false)
    expect(idCheck?.reason).toContain('CR-002')
  })

  // finding #21: three of the six checks (statuses-preserved, versions-
  // untouched, counters-monotonic) were only ever exercised on the all-green
  // fixture above — never proven to actually FIRE on a genuine regression.
  // This is the sole automated safety net for a one-shot, largely-
  // irreversible migration, so each violation-detection branch needs its own
  // forced-failure test, same as same-id-set/plan-content-identical already have.

  it('statuses-preserved fails when an UNRELATED status is hand-flipped post-migration — while the CR confirmed->resolved carve-out still passes', () => {
    const { repoRoot, canonDir, backfill } = seedV2Fixture()
    const snapshot = snapshotForParity(canonDir, repoRoot)
    migrateV3(canonDir, repoRoot, backfill, '20260718')

    // Sanity: CR-001's own legitimate confirmed -> resolved transition (the
    // ONE allowed carve-out) really did happen via migration's final reconcile.
    expect(readFm(canonDir, 'cr/CR-001.md', 'cr').status).toBe('resolved')

    // Hand-flip E1-FR2 to a status that is NOT the allowed carve-out.
    seedRaw(
      canonDir,
      join('epics', 'E1-x', 'E1-FR2.md'),
      [
        '---',
        'id: E1-FR2',
        'type: fr',
        'epic: E1',
        'status: retired',
        'version: 1',
        'traces_to: []',
        'enforces: []',
        'references_nfr: []',
        'related: []',
        '---',
        '',
        'As a user, I want Z.',
        '',
      ].join('\n')
    )

    const verdict = verifyParityV3(snapshot, canonDir, repoRoot)
    expect(verdict.verdict).toBe('VERIFY-FAIL')
    const check = verdict.checks.find((c) => c.name === 'statuses-preserved')
    expect(check?.ok).toBe(false)
    expect(check?.reason).toContain('E1-FR2')
    // The allowed CR-001 transition must NOT also be flagged here.
    expect(check?.reason).not.toContain('CR-001')
  })

  it('versions-untouched fails when a FR/NFR/BR version is bumped post-migration', () => {
    const { repoRoot, canonDir, backfill } = seedV2Fixture()
    const snapshot = snapshotForParity(canonDir, repoRoot)
    migrateV3(canonDir, repoRoot, backfill, '20260718')

    seedRaw(
      canonDir,
      join('br', 'E1-BR1.md'),
      [
        '---',
        'id: E1-BR1',
        'type: br',
        'epic: E1',
        'kind: operative',
        'enforcement: advisory',
        'status: active',
        'version: 2',
        '---',
        '',
        'A rule.',
        '',
      ].join('\n')
    )

    const verdict = verifyParityV3(snapshot, canonDir, repoRoot)
    expect(verdict.verdict).toBe('VERIFY-FAIL')
    const check = verdict.checks.find((c) => c.name === 'versions-untouched')
    expect(check?.ok).toBe(false)
    expect(check?.reason).toContain('E1-BR1')
  })

  it('counters-monotonic fails when a counter is decremented below its pre-migration value', () => {
    const { repoRoot, canonDir, backfill } = seedV2Fixture()
    const snapshot = snapshotForParity(canonDir, repoRoot)
    migrateV3(canonDir, repoRoot, backfill, '20260718')

    const counters = readCounters(canonDir)
    counters.epics.E1 = { ...counters.epics.E1!, fr: snapshot.counters.epics.E1!.fr - 1 }
    seedRaw(canonDir, join('.ba', 'counters.yaml'), yamlStringify(counters))

    const verdict = verifyParityV3(snapshot, canonDir, repoRoot)
    expect(verdict.verdict).toBe('VERIFY-FAIL')
    const check = verdict.checks.find((c) => c.name === 'counters-monotonic')
    expect(check?.ok).toBe(false)
    expect(check?.reason).toContain('epics.E1.fr')
  })
})
