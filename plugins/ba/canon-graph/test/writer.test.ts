import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { stringify as yamlStringify } from 'yaml'
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  addRequirement,
  editRequirement,
  retireRequirement,
  addEpic,
  confirmCr,
  realizeCrSpawn,
  setStatus,
  setVisionConfirmed,
} from '../src/writer'
import { parseFile } from '../src/parse'
import { historyCrRefs } from '../src/history'
import { readCounters, type Counters } from '../src/ids'
import type { Status } from '../src/types'
import { bodyHasLeadingFrontmatterFence } from '../src/body-refs'
import * as reconcileModule from '../src/reconcile'

// finding #23: `editRequirement`'s gap-fix reconcile trigger is dynamically
// imported (`await import('./reconcile.js')`, writer.ts) — spied (not
// stubbed) so every OTHER test in this file still gets reconcile's REAL
// behavior (its own status-flip side effects), while the one test below can
// assert non-invocation/invocation-count directly instead of only inferring
// it from an end-state that a second, independent guard (reconcile.ts's own
// `baselined`-status predicate) could produce even if this trigger fired
// unconditionally.
vi.mock('../src/reconcile.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/reconcile')>()
  return { ...actual, reconcileCrs: vi.fn(actual.reconcileCrs) }
})

// ---- fixture repo helpers — a temp dir per test, never the real `product/`
// (per the task's global constraint). Mirrors ids.test.ts's makeRepo. ----

const tempDirs: string[] = []

function baseCounters(): Counters {
  return { product: { epic: 0, cr: 0, wp: 0, bug: 0, baselineSeq: {} }, epics: {}, retired: [] }
}

function makeRepo(counters: Counters = baseCounters()): string {
  const dir = mkdtempSync(join(tmpdir(), 'canon-writer-'))
  mkdirSync(join(dir, '.ba'), { recursive: true })
  writeFileSync(join(dir, '.ba', 'counters.yaml'), yamlStringify(counters), 'utf8')
  tempDirs.push(dir)
  return dir
}

/** Writes a raw fixture page directly (bypassing the writer under test) —
 * used to seed pre-existing state (e.g. an already-`baselined` FR) that no
 * function in THIS task's scope can produce yet (that's `accept`, Task 11). */
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
  opts: { status?: string; version?: number; baseline?: string; body?: string; tracesTo?: string[] } = {}
): string {
  const status = opts.status ?? 'draft'
  const version = opts.version ?? 1
  const lines = [
    '---',
    `id: ${id}`,
    'type: fr',
    `epic: ${epic}`,
    `status: ${status}`,
    `version: ${version}`,
    `traces_to: [${(opts.tracesTo ?? []).join(', ')}]`,
    'enforces: []',
    'references_nfr: []',
    'related: []',
  ]
  if (opts.baseline) lines.push(`baseline: ${opts.baseline}`)
  lines.push('---', '', opts.body ?? 'Original story body.', '')
  return seedRaw(repo, join('epics', `${epic}-x`, `${id}.md`), lines.join('\n'))
}

// Mirrors accept.test.ts's own `seedCr` fixture (v3 Task 6's `impacts`
// rendering) — `opts.impacts` renders a YAML block sequence; omitted
// entirely (not even an empty key) when absent, so the bare 3-arg call every
// existing test uses still produces a CR with NO `impacts` field at all.
type CrImpactFixture = { amends: string } | { spawns: 'fr' | 'nfr' | 'br'; epic: string; realized?: string }

function seedCr(
  repo: string,
  id: string,
  status: 'captured' | 'confirmed' | 'resolved',
  opts: { impacts?: CrImpactFixture[]; entryPoint?: 'vision' | 'requirement' } = {}
): string {
  const lines = ['---', `id: ${id}`, 'type: cr', `status: ${status}`]
  if (opts.entryPoint) lines.push(`entry_point: ${opts.entryPoint}`)
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
  lines.push('---', '', 'Captured idea.', '')
  return seedRaw(repo, join('cr', `${id}.md`), lines.join('\n'))
}

function seedVision(repo: string, status: 'draft' | 'confirmed'): string {
  return seedRaw(repo, 'vision.md', `---\ntype: vision\nstatus: ${status}\n---\n\nProduct vision text.\n`)
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

// ==========================================================================
// addEpic
// ==========================================================================

describe('addEpic', () => {
  it('mints E1 and writes epics/E1-<slug>/index.md (status: active, empty body)', async () => {
    const repo = makeRepo()
    const { id } = await addEpic(repo, 'Entry & Board Access')
    expect(id).toBe('E1')

    const result = parseFile(join(repo, 'epics', 'E1-entry-board-access', 'index.md'), 'epic')
    if ('error' in result) throw new Error(result.error)
    expect(result.frontmatter).toEqual({ id: 'E1', type: 'epic', title: 'Entry & Board Access', status: 'active' })
    expect(result.body).toBe('')
  })

  it('mints sequential epic ids', async () => {
    const repo = makeRepo()
    const a = await addEpic(repo, 'First')
    const b = await addEpic(repo, 'Second')
    expect([a.id, b.id]).toEqual(['E1', 'E2'])
  })
})

// ==========================================================================
// addRequirement
// ==========================================================================

describe('addRequirement', () => {
  it('mints an FR under an existing epic, status draft, version 1, allocated via ids', async () => {
    const repo = makeRepo()
    await addEpic(repo, 'Foundation')
    const { id, path } = await addRequirement(repo, { epic: 'E1', type: 'fr', body: 'Story.\n' })
    expect(id).toBe('E1-FR1')
    expect(path).toBe(join(repo, 'epics', 'E1-foundation', 'E1-FR1.md'))

    const result = parseFile(path, 'fr')
    if ('error' in result) throw new Error(result.error)
    expect(result.frontmatter).toMatchObject({ id: 'E1-FR1', type: 'fr', epic: 'E1', status: 'draft', version: 1 })
    expect(result.body).toBe('Story.\n')
    expect(readCounters(repo).epics.E1?.fr).toBe(1)
  })

  it('writes the given refs (traces_to/enforces/references_nfr/related) for an FR', async () => {
    const repo = makeRepo()
    await addEpic(repo, 'Foundation')
    const { path } = await addRequirement(repo, {
      epic: 'E1',
      type: 'fr',
      body: 'Story.\n',
      refs: { tracesTo: ['CR-001'], enforces: ['E1-BR1'], referencesNfr: ['E1-NFR1'], related: ['E1-FR9'] },
    })
    const result = parseFile(path, 'fr')
    if ('error' in result) throw new Error(result.error)
    expect(result.frontmatter).toMatchObject({
      traces_to: ['CR-001'],
      enforces: ['E1-BR1'],
      references_nfr: ['E1-NFR1'],
      related: ['E1-FR9'],
    })
  })

  it('mints an NFR with verified_by/traces_to/related defaults', async () => {
    const repo = makeRepo()
    await addEpic(repo, 'Foundation')
    const { id, path } = await addRequirement(repo, { epic: 'E1', type: 'nfr', body: 'Budget.\n' })
    expect(id).toBe('E1-NFR1')
    const result = parseFile(path, 'nfr')
    if ('error' in result) throw new Error(result.error)
    expect(result.frontmatter).toMatchObject({ traces_to: [], verified_by: [], related: [] })
  })

  it('mints a BR with default kind/enforcement, overridable via refs', async () => {
    const repo = makeRepo()
    await addEpic(repo, 'Foundation')
    const defaulted = await addRequirement(repo, { epic: 'E1', type: 'br', body: 'Rule.\n' })
    const defaultedPage = parseFile(defaulted.path, 'br')
    if ('error' in defaultedPage) throw new Error(defaultedPage.error)
    expect(defaultedPage.frontmatter).toMatchObject({ kind: 'operative', enforcement: 'advisory' })

    const overridden = await addRequirement(repo, {
      epic: 'E1',
      type: 'br',
      body: 'Money rule.\n',
      refs: { kind: 'structural', enforcement: 'hard' },
    })
    expect(overridden.path).toBe(join(repo, 'br', 'E1-BR2.md'))
    const overriddenPage = parseFile(overridden.path, 'br')
    if ('error' in overriddenPage) throw new Error(overriddenPage.error)
    expect(overriddenPage.frontmatter).toMatchObject({ kind: 'structural', enforcement: 'hard' })
  })

  it('rejects a malformed epic id before minting', async () => {
    const repo = makeRepo()
    await expect(addRequirement(repo, { epic: 'not-an-epic', type: 'fr', body: 'x' })).rejects.toThrow(/not a valid epic id/)
  })

  it('mints (burns) an id then throws if the epic directory does not exist on disk', async () => {
    const repo = makeRepo()
    await expect(addRequirement(repo, { epic: 'E9', type: 'fr', body: 'x' })).rejects.toThrow(/no epic(s)? directory/)
    // The id was minted before the write failed — the ledger advanced (a
    // gap, not a reuse), matching ids.ts's documented failure mode.
    expect(readCounters(repo).epics.E9?.fr).toBe(1)
  })
})

// ==========================================================================
// editRequirement
// ==========================================================================

describe('editRequirement', () => {
  it('edits a draft item in place with NO version bump', async () => {
    const repo = makeRepo()
    await addEpic(repo, 'Foundation')
    const { id, path } = await addRequirement(repo, { epic: 'E1', type: 'fr', body: 'Original.\n' })

    const edit = await editRequirement(repo, { id, body: 'Rewritten.\n' })
    expect(edit).toEqual({ id, path, bumped: false })

    const result = parseFile(path, 'fr')
    if ('error' in result) throw new Error(result.error)
    expect(result.body).toBe('Rewritten.\n')
    expect(result.frontmatter).toMatchObject({ status: 'draft', version: 1 })
  })

  it('edits an active item in place with NO version bump', async () => {
    const repo = makeRepo()
    await addEpic(repo, 'Foundation')
    const { id, path } = await addRequirement(repo, { epic: 'E1', type: 'fr', body: 'Original.\n' })
    await setStatus(repo, id, 'active')

    const edit = await editRequirement(repo, { id, body: 'Rewritten while active.\n' })
    expect(edit.bumped).toBe(false)
    const result = parseFile(path, 'fr')
    if ('error' in result) throw new Error(result.error)
    expect(result.frontmatter).toMatchObject({ status: 'active', version: 1 })
  })

  it('rejects editing a batched item in place', async () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', { status: 'batched' })
    await expect(editRequirement(repo, { id: 'E1-FR1', body: 'x' })).rejects.toThrow(/batched/)
  })

  it('rejects editing a superseded or retired item (terminal)', async () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', { status: 'superseded' })
    seedFr(repo, 'E1-FR2', 'E1', { status: 'retired' })
    await expect(editRequirement(repo, { id: 'E1-FR1', body: 'x' })).rejects.toThrow(/terminal/)
    await expect(editRequirement(repo, { id: 'E1-FR2', body: 'x' })).rejects.toThrow(/terminal/)
  })

  it('rejects --activate on a non-draft item', async () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', { status: 'active' })
    await expect(editRequirement(repo, { id: 'E1-FR1', body: 'x', activate: true })).rejects.toThrow(/not 'draft'/)
  })

  it('--activate moves draft -> active in the same write', async () => {
    const repo = makeRepo()
    await addEpic(repo, 'Foundation')
    const { id, path } = await addRequirement(repo, { epic: 'E1', type: 'fr', body: 'Original.\n' })
    await editRequirement(repo, { id, body: 'Original.\n', activate: true })
    const result = parseFile(path, 'fr')
    if ('error' in result) throw new Error(result.error)
    expect(result.frontmatter).toMatchObject({ status: 'active' })
  })

  it('rejects editing a baselined item without a --cr', async () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', { status: 'baselined', baseline: 'BL-20260710' })
    await expect(editRequirement(repo, { id: 'E1-FR1', body: 'New content.\n', date: '20260713' })).rejects.toThrow(
      /confirmed --cr/
    )
  })

  it('rejects editing a baselined item against a CR that is not confirmed', async () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', { status: 'baselined', baseline: 'BL-20260710' })
    seedCr(repo, 'CR-001', 'captured')
    await expect(
      editRequirement(repo, { id: 'E1-FR1', body: 'New content.\n', cr: 'CR-001', date: '20260713' })
    ).rejects.toThrow(/must be 'confirmed'/)
  })

  // ------------------------------------------------------------------------
  // finding #1: `--cr`'s guard must cross-check the CITING CR's OWN
  // `entry_point`/`impacts` — not just its status — before it's allowed to
  // drive an edit. `impacts` is reconcile's ONLY source of truth for "what a
  // CR touches" (reconcile.ts's own header); without this, any confirmed CR
  // — including a vision-entry CR, required to carry an EMPTY impacts set —
  // could be cited to falsely amend an unrelated requirement.
  // ------------------------------------------------------------------------

  it('rejects a --cr edit driven by a vision-entry CR (a vision CR carries no impacts and can never amend a requirement)', async () => {
    const repo = makeRepo()
    const path = seedFr(repo, 'E1-FR1', 'E1', { status: 'baselined', version: 1, baseline: 'BL-20260710', body: 'Unrelated FR body.' })
    seedCr(repo, 'CR-777', 'confirmed', { entryPoint: 'vision' })
    const before = readFileSync(path, 'utf8')

    await expect(
      editRequirement(repo, { id: 'E1-FR1', body: 'Amended via a vision CR!\n', cr: 'CR-777', date: '20260101' })
    ).rejects.toThrow(/entry_point/)

    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('rejects a --cr edit driven by a requirement-entry CR whose impacts do not declare an amend on the target', async () => {
    const repo = makeRepo()
    const path = seedFr(repo, 'E1-FR1', 'E1', { status: 'baselined', version: 1, baseline: 'BL-20260710', body: 'Unrelated FR body.' })
    seedCr(repo, 'CR-778', 'confirmed', { entryPoint: 'requirement', impacts: [{ amends: 'E1-FR2' }] })
    const before = readFileSync(path, 'utf8')

    await expect(
      editRequirement(repo, { id: 'E1-FR1', body: 'Amended via an unrelated CR!\n', cr: 'CR-778', date: '20260101' })
    ).rejects.toThrow(/do not declare/)

    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('rejects a --cr edit driven by a requirement-entry CR whose impacts only SPAWN (never amend) — a spawn cannot back an edit to an existing item', async () => {
    const repo = makeRepo()
    const path = seedFr(repo, 'E1-FR1', 'E1', { status: 'baselined', version: 1, baseline: 'BL-20260710', body: 'Unrelated FR body.' })
    seedCr(repo, 'CR-779', 'confirmed', { entryPoint: 'requirement', impacts: [{ spawns: 'fr', epic: 'E1', realized: 'E1-FR1' }] })
    const before = readFileSync(path, 'utf8')

    await expect(
      editRequirement(repo, { id: 'E1-FR1', body: 'Amended via a spawn-only CR!\n', cr: 'CR-779', date: '20260101' })
    ).rejects.toThrow(/do not declare/)

    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('bumps version + archives the prior body verbatim to ## History on a real content change (heading cites the CR, not baseline)', async () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', { status: 'baselined', version: 1, baseline: 'BL-20260710', body: 'Original story body.' })
    seedCr(repo, 'CR-001', 'confirmed', { entryPoint: 'requirement', impacts: [{ amends: 'E1-FR1' }] })

    const edit = await editRequirement(repo, {
      id: 'E1-FR1',
      body: 'Rewritten story body.\n',
      cr: 'CR-001',
      date: '20260713',
    })
    expect(edit.bumped).toBe(true)

    const result = parseFile(edit.path, 'fr')
    if ('error' in result) throw new Error(result.error)
    // v3: heading cites the CR id, universally — never the item's `baseline:`
    // field, which stays untouched by the bump.
    expect(result.frontmatter).toMatchObject({ version: 2, baseline: 'BL-20260710' })
    expect(result.body).toContain('Rewritten story body.')
    expect(result.body).toContain('## History')
    expect(result.body).toContain('### v1 — 20260713 — CR-001')
    // The prior body substring must survive verbatim, unchanged.
    expect(result.body).toContain('Original story body.')
    // Append-at-top: the History heading precedes the new entry, and the new
    // entry precedes the archived (prior) body.
    const historyIdx = result.body.indexOf('## History')
    const entryIdx = result.body.indexOf('### v1')
    const priorIdx = result.body.indexOf('Original story body.')
    expect(historyIdx).toBeLessThan(entryIdx)
    expect(entryIdx).toBeLessThan(priorIdx)
  })

  it('throws (rather than silently no-op) when a --cr edit of a baselined item does not actually change content', async () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', { status: 'baselined', version: 1, baseline: 'BL-20260710', body: 'Same body.' })
    seedCr(repo, 'CR-001', 'confirmed', { entryPoint: 'requirement', impacts: [{ amends: 'E1-FR1' }] })

    // Matches seedFr's own leading-blank-line-after-fence convention exactly
    // (shouldBump's normalize() drops only TRAILING blank lines, not
    // leading ones) — a genuinely unchanged body, not just a similar one.
    // v3 (Task 5): a CR-driven edit that changes nothing is REJECTED outright
    // (universal across active/baselined), not silently absorbed as a no-op —
    // see the 'throws on a no-op --cr edit' tests above for the active case.
    await expect(
      editRequirement(repo, { id: 'E1-FR1', body: '\nSame body.\n', cr: 'CR-001', date: '20260713' })
    ).rejects.toThrow(/must change the requirement/)
    const result = parseFile(join(repo, 'epics', 'E1-x', 'E1-FR1.md'), 'fr')
    if ('error' in result) throw new Error(result.error)
    expect(result.frontmatter).toMatchObject({ version: 1 })
    expect(result.body).not.toContain('## History')
  })

  it('requires a date when a baselined edit actually bumps', async () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', { status: 'baselined', version: 1, baseline: 'BL-20260710', body: 'Original.' })
    seedCr(repo, 'CR-001', 'confirmed', { entryPoint: 'requirement', impacts: [{ amends: 'E1-FR1' }] })
    await expect(editRequirement(repo, { id: 'E1-FR1', body: 'Changed.\n', cr: 'CR-001' })).rejects.toThrow(/requires a date/)
  })

  // finding #19: a malformed --date must be caught BEFORE any write — not
  // only later, inside `reconcileCrs`'s own date guard — so a bad date can
  // never bake itself permanently into a History heading while the CALL
  // still reports failure.
  it('rejects a malformed --date on a bump BEFORE any write — the file stays byte-unchanged', async () => {
    const repo = makeRepo()
    const path = seedFr(repo, 'E1-FR1', 'E1', { status: 'baselined', version: 1, baseline: 'BL-20260710', body: 'Original.' })
    seedCr(repo, 'CR-001', 'confirmed', { entryPoint: 'requirement', impacts: [{ amends: 'E1-FR1' }] })
    const before = readFileSync(path, 'utf8')

    await expect(
      editRequirement(repo, { id: 'E1-FR1', body: 'Changed.\n', cr: 'CR-001', date: '2026-07-13' })
    ).rejects.toThrow(/YYYYMMDD/)

    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('History is append-only: a second bump keeps the first entry nested underneath, verbatim', async () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', { status: 'baselined', version: 1, baseline: 'BL-20260710', body: 'v1 body.' })
    // Two DISTINCT CRs (v3: a CR that auto-resolves on its own amend landing
    // is a one-shot artifact — it can't legitimately drive a second edit
    // once `resolved`), each independently declaring an amend on E1-FR1.
    seedCr(repo, 'CR-001', 'confirmed', { entryPoint: 'requirement', impacts: [{ amends: 'E1-FR1' }] })
    seedCr(repo, 'CR-002', 'confirmed', { entryPoint: 'requirement', impacts: [{ amends: 'E1-FR1' }] })

    const first = await editRequirement(repo, { id: 'E1-FR1', body: 'v2 body.\n', cr: 'CR-001', date: '20260711' })
    expect(first.bumped).toBe(true)

    const second = await editRequirement(repo, { id: 'E1-FR1', body: 'v3 body.\n', cr: 'CR-002', date: '20260713' })
    expect(second.bumped).toBe(true)

    const result = parseFile(second.path, 'fr')
    if ('error' in result) throw new Error(result.error)
    expect(result.frontmatter).toMatchObject({ version: 3 })
    expect(result.body).toContain('v3 body.')
    // Newest-first: the v2 archival entry (from the second bump) precedes
    // the v1 archival entry (nested inside what v2's own body carried). The
    // nested entry's own headings (its `## History` and `### v1` — carried
    // over verbatim from the first bump's output) are DEMOTED two levels
    // (`####`/`#####`) when re-embedded by the second bump, per history.ts's
    // `archiveIntoHistory` — the archive never re-introduces a `##`/`###`
    // anchor at the live document's heading level.
    const v2EntryIdx = result.body.indexOf('### v2 — 20260713 — CR-002')
    const v1EntryIdx = result.body.indexOf('##### v1 — 20260711 — CR-001')
    expect(v2EntryIdx).toBeGreaterThanOrEqual(0)
    expect(v1EntryIdx).toBeGreaterThan(v2EntryIdx)
    expect(result.body).toContain('#### History')
    // The un-demoted (`### v1`) form must NOT appear as its own heading line
    // — only the demoted `##### v1` form.
    expect(result.body).not.toMatch(/^### v1 — 20260711 — CR-001$/m)
    // finding #3/#6 regression: the first bump's citation (CR-001) is not
    // buried by the second, unrelated bump landing on the same target.
    expect(historyCrRefs(result.body)).toEqual(expect.arrayContaining(['CR-002', 'CR-001']))
    // Nothing was dropped across the two bumps: the original v1 body text
    // still appears, unchanged, nested inside the archived v2 blob.
    expect(result.body).toContain('v1 body.')
  })

  it('inserts the newest entry right after an existing ## History heading already present in the caller-supplied new body', async () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', { status: 'baselined', version: 5, baseline: 'BL-20260710', body: 'v5 body.' })
    seedCr(repo, 'CR-001', 'confirmed', { entryPoint: 'requirement', impacts: [{ amends: 'E1-FR1' }] })

    // The caller's new body already carries its own `## History` section
    // (e.g. hand-authored) with a pre-existing older entry underneath it —
    // the writer must insert the new entry right after the heading, AHEAD
    // of what was already there, not clobber or duplicate the heading.
    const newBody = 'v6 body.\n\n## History\n\n### v0 — 20260101 — BL-old\n\nAncient entry.\n'
    const edit = await editRequirement(repo, { id: 'E1-FR1', body: newBody, cr: 'CR-001', date: '20260713' })
    expect(edit.bumped).toBe(true)

    const result = parseFile(edit.path, 'fr')
    if ('error' in result) throw new Error(result.error)
    expect(result.frontmatter).toMatchObject({ version: 6 })
    const historyIdx = result.body.indexOf('## History')
    const newEntryIdx = result.body.indexOf('### v5 — 20260713 — CR-001')
    const oldEntryIdx = result.body.indexOf('### v0 — 20260101 — BL-old')
    expect(historyIdx).toBeGreaterThanOrEqual(0)
    expect(newEntryIdx).toBeGreaterThan(historyIdx)
    expect(oldEntryIdx).toBeGreaterThan(newEntryIdx) // pre-existing entry preserved, pushed below the newest one
    expect(result.body).toContain('v5 body.') // the prior (pre-bump) body, verbatim
    expect(result.body).toContain('Ancient entry.') // the pre-existing older entry, untouched (literal input text)
    // Only one '## History' heading — the writer must not create a second.
    expect(result.body.split('## History').length - 1).toBe(1)
  })

  // ------------------------------------------------------------------------
  // v3 (Task 5): the universal CR bump — legal on `active` too, not just
  // `baselined`; a no-op `--cr` edit throws; `--cr` is illegal on a `draft`.
  // ------------------------------------------------------------------------

  it('bumps an ACTIVE requirement edited with --cr, cites the CR, appends traces_to (deduped)', async () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', { status: 'active', version: 1, tracesTo: ['CR-001'], body: 'Active story body.' })
    seedCr(repo, 'CR-002', 'confirmed', { entryPoint: 'requirement', impacts: [{ amends: 'E1-FR1' }] })

    const r = await editRequirement(repo, {
      id: 'E1-FR1',
      body: 'Rewritten active body.\n',
      cr: 'CR-002',
      date: '20260718',
    })
    expect(r.bumped).toBe(true)

    const result = parseFile(r.path, 'fr')
    if ('error' in result) throw new Error(result.error)
    expect(result.frontmatter).toMatchObject({ version: 2, status: 'active' })
    // both the original CR-001 and the amending CR-002 are on traces_to now.
    const tracesTo = (result.frontmatter as { traces_to: string[] }).traces_to
    expect(tracesTo).toEqual(expect.arrayContaining(['CR-001', 'CR-002']))
    expect(tracesTo.length).toBe(2)
    expect(result.body).toContain('### v1 — 20260718 — CR-002')
    expect(result.body).toContain('Active story body.')
  })

  it('re-amending the same active item against the SAME CR again does not duplicate the traces_to entry', async () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', { status: 'active', version: 1, tracesTo: ['CR-002'], body: 'v1.' })
    seedCr(repo, 'CR-002', 'confirmed', { entryPoint: 'requirement', impacts: [{ amends: 'E1-FR1' }] })

    const r = await editRequirement(repo, { id: 'E1-FR1', body: 'v2.\n', cr: 'CR-002', date: '20260718' })
    expect(r.bumped).toBe(true)
    const result = parseFile(r.path, 'fr')
    if ('error' in result) throw new Error(result.error)
    expect((result.frontmatter as { traces_to: string[] }).traces_to).toEqual(['CR-002'])
  })

  it('throws on a no-op --cr edit (active item, unchanged content)', async () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', { status: 'active', version: 1, body: 'Same body.' })
    seedCr(repo, 'CR-002', 'confirmed', { entryPoint: 'requirement', impacts: [{ amends: 'E1-FR1' }] })
    await expect(
      editRequirement(repo, { id: 'E1-FR1', body: '\nSame body.\n', cr: 'CR-002', date: '20260718' })
    ).rejects.toThrow(/must change the requirement/)
  })

  it('throws on --cr against a draft (draft authoring is free-form)', async () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', { status: 'draft', version: 1 })
    seedCr(repo, 'CR-002', 'confirmed', { entryPoint: 'requirement', impacts: [{ amends: 'E1-FR1' }] })
    await expect(
      editRequirement(repo, { id: 'E1-FR1', body: 'Changed.\n', cr: 'CR-002', date: '20260718' })
    ).rejects.toThrow(/draft/)
  })

  it('still allows a free non-CR edit of an active item (no bump, no CR required)', async () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', { status: 'active', version: 1, tracesTo: ['CR-001'] })
    const r = await editRequirement(repo, { id: 'E1-FR1', body: 'Free-form rewrite.\n' })
    expect(r.bumped).toBe(false)
    const result = parseFile(r.path, 'fr')
    if ('error' in result) throw new Error(result.error)
    expect(result.frontmatter).toMatchObject({ version: 1, status: 'active' })
    expect((result.frontmatter as { traces_to: string[] }).traces_to).toEqual(['CR-001'])
    expect(result.body).toBe('Free-form rewrite.\n')
  })

  // ------------------------------------------------------------------------
  // Gap fix (post-Task-6): a CR whose only impact is `{amends: <id>}` never
  // auto-resolved when the amend landed via a bare `editRequirement` bump on
  // an ALREADY-baselined item — nothing routed it through `accept`, reconcile's
  // only prior caller. The trigger now lives in `editRequirement` itself.
  // ------------------------------------------------------------------------

  function readCrStatus(repo: string, id: string): unknown {
    const result = parseFile(join(repo, 'cr', `${id}.md`), 'cr')
    if ('error' in result) throw new Error(result.error)
    return (result.frontmatter as { status?: unknown }).status
  }

  it('an amend-only CR resolves the instant its bump lands on an already-baselined item', async () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', { status: 'baselined', version: 1, baseline: 'BL-20260710', body: 'Original.' })
    seedCr(repo, 'CR-001', 'confirmed', { entryPoint: 'requirement', impacts: [{ amends: 'E1-FR1' }] })

    const edit = await editRequirement(repo, { id: 'E1-FR1', body: 'Amended.\n', cr: 'CR-001', date: '20260713' })
    expect(edit.bumped).toBe(true)

    expect(readCrStatus(repo, 'CR-001')).toBe('resolved')
  })

  it('a mixed CR (amend on a baselined item + an un-realized spawn) stays confirmed after the same bump', async () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', { status: 'baselined', version: 1, baseline: 'BL-20260710', body: 'Original.' })
    seedCr(repo, 'CR-002', 'confirmed', {
      entryPoint: 'requirement',
      impacts: [{ amends: 'E1-FR1' }, { spawns: 'fr', epic: 'E1' }],
    })

    const edit = await editRequirement(repo, { id: 'E1-FR1', body: 'Amended.\n', cr: 'CR-002', date: '20260713' })
    expect(edit.bumped).toBe(true)

    // The spawn impact is still un-realized, so the CR as a whole cannot
    // resolve yet — only fully-delivered impact sets resolve.
    expect(readCrStatus(repo, 'CR-002')).toBe('confirmed')
  })

  it('proves NON-invocation: a bump on an ACTIVE item never calls reconcileCrs at all, while a bump on an already-baselined item calls it exactly once', async () => {
    const spy = vi.mocked(reconcileModule.reconcileCrs)
    spy.mockClear()

    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', { status: 'active', version: 1, body: 'Original active body.' })
    seedCr(repo, 'CR-003', 'confirmed', { entryPoint: 'requirement', impacts: [{ amends: 'E1-FR1' }] })

    const edit = await editRequirement(repo, { id: 'E1-FR1', body: 'Amended active body.\n', cr: 'CR-003', date: '20260713' })
    expect(edit.bumped).toBe(true)

    // Not an end-state inference: reconcileCrs itself was never CALLED.
    expect(spy).not.toHaveBeenCalled()
    // No reconcile fires off an active-item edit — resolution (if any) is
    // deferred to that item's eventual `accept`, not asserted here.
    expect(readCrStatus(repo, 'CR-003')).toBe('confirmed')

    spy.mockClear()

    // Sibling case: a bump landing on an ALREADY-baselined item DOES fire the
    // gap-fix trigger — exactly once.
    seedFr(repo, 'E1-FR9', 'E1', { status: 'baselined', version: 1, baseline: 'BL-20260710', body: 'Original.' })
    seedCr(repo, 'CR-901', 'confirmed', { entryPoint: 'requirement', impacts: [{ amends: 'E1-FR9' }] })
    await editRequirement(repo, { id: 'E1-FR9', body: 'Amended.\n', cr: 'CR-901', date: '20260713' })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(readCrStatus(repo, 'CR-901')).toBe('resolved')
  })
})

// ==========================================================================
// retireRequirement
// ==========================================================================

describe('retireRequirement', () => {
  it('soft-retires a draft item', async () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', { status: 'draft' })
    const { id, path } = await retireRequirement(repo, 'E1-FR1')
    expect(id).toBe('E1-FR1')
    const result = parseFile(path, 'fr')
    if ('error' in result) throw new Error(result.error)
    expect(result.frontmatter).toMatchObject({ status: 'retired' })
  })

  it('retires a batched or baselined item too (soft-retire is not restricted to draft/active)', async () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', { status: 'batched' })
    seedFr(repo, 'E1-FR2', 'E1', { status: 'baselined', baseline: 'BL-20260710' })
    await retireRequirement(repo, 'E1-FR1')
    await retireRequirement(repo, 'E1-FR2')
    const r1 = parseFile(join(repo, 'epics', 'E1-x', 'E1-FR1.md'), 'fr')
    const r2 = parseFile(join(repo, 'epics', 'E1-x', 'E1-FR2.md'), 'fr')
    if ('error' in r1) throw new Error(r1.error)
    if ('error' in r2) throw new Error(r2.error)
    expect(r1.frontmatter).toMatchObject({ status: 'retired' })
    expect(r2.frontmatter).toMatchObject({ status: 'retired' })
  })

  it('rejects retiring an already-retired item', async () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', { status: 'retired' })
    await expect(retireRequirement(repo, 'E1-FR1')).rejects.toThrow(/already 'retired'/)
  })

  it('rejects retiring a superseded item (no legal transition out of superseded)', async () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', { status: 'superseded' })
    await expect(retireRequirement(repo, 'E1-FR1')).rejects.toThrow(/illegal status transition/)
  })
})

// ==========================================================================
// confirmCr (v3, Task 5) — `authorWp` was retired outright this task (WP
// authoring is now the hybrid `id next` + direct `Write` skill pattern, no
// longer a writer.ts mutator at all).
// ==========================================================================

describe('confirmCr', () => {
  it('confirms entry: vision with no impacts', async () => {
    const repo = makeRepo()
    seedCr(repo, 'CR-010', 'captured')
    const r = await confirmCr(repo, { crId: 'CR-010', entry: 'vision' })
    const result = parseFile(r.path, 'cr')
    if ('error' in result) throw new Error(result.error)
    expect(result.frontmatter).toMatchObject({ status: 'confirmed', entry_point: 'vision', entry_point_confirmed: true })
    expect(result.frontmatter).not.toHaveProperty('impacts')
  })

  it('rejects entry: vision carrying non-empty impacts', async () => {
    const repo = makeRepo()
    await addEpic(repo, 'Foundation')
    seedCr(repo, 'CR-011', 'captured')
    await expect(
      confirmCr(repo, { crId: 'CR-011', entry: 'vision', impacts: [{ spawns: 'fr', epic: 'E1' }] })
    ).rejects.toThrow()
  })

  it('requires non-empty resolving impacts for entry: requirement', async () => {
    const repo = makeRepo()
    await addEpic(repo, 'Foundation')
    await addRequirement(repo, { epic: 'E1', type: 'fr', body: 'Story.\n' })
    seedCr(repo, 'CR-003', 'captured')

    await expect(confirmCr(repo, { crId: 'CR-003', entry: 'requirement', impacts: [] })).rejects.toThrow()
    await expect(
      confirmCr(repo, { crId: 'CR-003', entry: 'requirement', impacts: [{ amends: 'E9-FR9' }] })
    ).rejects.toThrow(/does not resolve/)

    const r = await confirmCr(repo, {
      crId: 'CR-003',
      entry: 'requirement',
      impacts: [{ amends: 'E1-FR1' }, { spawns: 'fr', epic: 'E1' }],
    })
    const result = parseFile(r.path, 'cr')
    if ('error' in result) throw new Error(result.error)
    expect(result.frontmatter).toMatchObject({ status: 'confirmed', entry_point: 'requirement', entry_point_confirmed: true })
    expect((result.frontmatter as { impacts: unknown }).impacts).toEqual([{ amends: 'E1-FR1' }, { spawns: 'fr', epic: 'E1' }])
  })

  it('rejects a spawns impact whose epic does not exist', async () => {
    const repo = makeRepo()
    seedCr(repo, 'CR-004', 'captured')
    await expect(
      confirmCr(repo, { crId: 'CR-004', entry: 'requirement', impacts: [{ spawns: 'fr', epic: 'E9' }] })
    ).rejects.toThrow(/does not exist/)
  })

  it('rejects confirming a CR that is not captured', async () => {
    const repo = makeRepo()
    seedCr(repo, 'CR-005', 'confirmed')
    await expect(confirmCr(repo, { crId: 'CR-005', entry: 'vision' })).rejects.toThrow(/must be 'captured'/)
  })
})

// ==========================================================================
// realizeCrSpawn (v3, Task 5)
// ==========================================================================

describe('realizeCrSpawn', () => {
  it('stamps the first un-realized matching entry and validates the trace', async () => {
    const repo = makeRepo()
    await addEpic(repo, 'Foundation')
    seedFr(repo, 'E1-FR5', 'E1', { status: 'active', tracesTo: ['CR-006'] })
    seedRaw(
      repo,
      join('cr', 'CR-006.md'),
      '---\nid: CR-006\ntype: cr\nstatus: confirmed\nentry_point: requirement\nentry_point_confirmed: true\nimpacts:\n  - spawns: fr\n    epic: E1\n---\n\nIdea.\n'
    )

    const r = await realizeCrSpawn(repo, { crId: 'CR-006', epic: 'E1', type: 'fr', newId: 'E1-FR5' })
    const result = parseFile(r.path, 'cr')
    if ('error' in result) throw new Error(result.error)
    expect((result.frontmatter as { impacts: unknown }).impacts).toEqual([{ spawns: 'fr', epic: 'E1', realized: 'E1-FR5' }])
  })

  it('claims the NEXT still-un-realized entry when an earlier one of the same shape is already realized', async () => {
    const repo = makeRepo()
    await addEpic(repo, 'Foundation')
    seedFr(repo, 'E1-FR6', 'E1', { status: 'active', tracesTo: ['CR-007'] })
    seedFr(repo, 'E1-FR7', 'E1', { status: 'active', tracesTo: ['CR-007'] })
    seedRaw(
      repo,
      join('cr', 'CR-007.md'),
      [
        '---',
        'id: CR-007',
        'type: cr',
        'status: confirmed',
        'entry_point: requirement',
        'entry_point_confirmed: true',
        'impacts:',
        '  - spawns: fr',
        '    epic: E1',
        '    realized: E1-FR6',
        '  - spawns: fr',
        '    epic: E1',
        '---',
        '',
        'Idea.',
        '',
      ].join('\n')
    )

    const r = await realizeCrSpawn(repo, { crId: 'CR-007', epic: 'E1', type: 'fr', newId: 'E1-FR7' })
    const result = parseFile(r.path, 'cr')
    if ('error' in result) throw new Error(result.error)
    expect((result.frontmatter as { impacts: unknown }).impacts).toEqual([
      { spawns: 'fr', epic: 'E1', realized: 'E1-FR6' },
      { spawns: 'fr', epic: 'E1', realized: 'E1-FR7' },
    ])
  })

  it('throws when no impact entry matches {spawns:type, epic}', async () => {
    const repo = makeRepo()
    seedRaw(
      repo,
      join('cr', 'CR-008.md'),
      '---\nid: CR-008\ntype: cr\nstatus: confirmed\nimpacts:\n  - spawns: nfr\n    epic: E1\n---\n\nIdea.\n'
    )
    await expect(realizeCrSpawn(repo, { crId: 'CR-008', epic: 'E1', type: 'fr', newId: 'E1-FR1' })).rejects.toThrow(
      /no un-realized/
    )
  })

  it("throws when newId doesn't resolve in the graph", async () => {
    const repo = makeRepo()
    seedRaw(
      repo,
      join('cr', 'CR-009.md'),
      '---\nid: CR-009\ntype: cr\nstatus: confirmed\nimpacts:\n  - spawns: fr\n    epic: E1\n---\n\nIdea.\n'
    )
    await expect(
      realizeCrSpawn(repo, { crId: 'CR-009', epic: 'E1', type: 'fr', newId: 'E1-FR99' })
    ).rejects.toThrow(/does not resolve/)
  })

  it("throws when the realized FR/NFR's traces_to does not include the CR", async () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR8', 'E1', { status: 'active', tracesTo: [] })
    seedRaw(
      repo,
      join('cr', 'CR-012.md'),
      '---\nid: CR-012\ntype: cr\nstatus: confirmed\nimpacts:\n  - spawns: fr\n    epic: E1\n---\n\nIdea.\n'
    )
    await expect(
      realizeCrSpawn(repo, { crId: 'CR-012', epic: 'E1', type: 'fr', newId: 'E1-FR8' })
    ).rejects.toThrow(/traces_to does not include/)
  })

  it('realizes an NFR spawn too (validates traces_to just like an FR)', async () => {
    const repo = makeRepo()
    await addEpic(repo, 'Foundation')
    await addRequirement(repo, { epic: 'E1', type: 'nfr', body: 'Budget.\n', refs: { tracesTo: ['CR-014'] } })
    seedRaw(
      repo,
      join('cr', 'CR-014.md'),
      '---\nid: CR-014\ntype: cr\nstatus: confirmed\nimpacts:\n  - spawns: nfr\n    epic: E1\n---\n\nIdea.\n'
    )
    const r = await realizeCrSpawn(repo, { crId: 'CR-014', epic: 'E1', type: 'nfr', newId: 'E1-NFR1' })
    const result = parseFile(r.path, 'cr')
    if ('error' in result) throw new Error(result.error)
    expect((result.frontmatter as { impacts: unknown }).impacts).toEqual([{ spawns: 'nfr', epic: 'E1', realized: 'E1-NFR1' }])
  })

  it('a BR spawn needs no traces_to check (BR has no such field)', async () => {
    const repo = makeRepo()
    await addEpic(repo, 'Foundation')
    await addRequirement(repo, { epic: 'E1', type: 'br', body: 'Rule.\n' })
    seedRaw(
      repo,
      join('cr', 'CR-013.md'),
      '---\nid: CR-013\ntype: cr\nstatus: confirmed\nimpacts:\n  - spawns: br\n    epic: E1\n---\n\nIdea.\n'
    )
    const r = await realizeCrSpawn(repo, { crId: 'CR-013', epic: 'E1', type: 'br', newId: 'E1-BR1' })
    const result = parseFile(r.path, 'cr')
    if ('error' in result) throw new Error(result.error)
    expect((result.frontmatter as { impacts: unknown }).impacts).toEqual([{ spawns: 'br', epic: 'E1', realized: 'E1-BR1' }])
  })

  // ------------------------------------------------------------------------
  // findings #4/#5/#8: realizeCrSpawn hardening — the same real page must
  // never double-count as two distinct declared spawns (#4), and a newId
  // whose own shape/epic doesn't match the impact it's being stamped against
  // must be rejected outright (#5/#8) rather than silently recorded.
  // ------------------------------------------------------------------------

  it('rejects realizing a spawn with an id that already realizes a DIFFERENT impact entry on the same CR (#4)', async () => {
    const repo = makeRepo()
    await addEpic(repo, 'Foundation')
    seedFr(repo, 'E1-FR1', 'E1', { status: 'active', tracesTo: ['CR-020'] })
    seedRaw(
      repo,
      join('cr', 'CR-020.md'),
      [
        '---',
        'id: CR-020',
        'type: cr',
        'status: confirmed',
        'entry_point: requirement',
        'entry_point_confirmed: true',
        'impacts:',
        '  - spawns: fr',
        '    epic: E1',
        '    realized: E1-FR1',
        '  - spawns: fr',
        '    epic: E1',
        '---',
        '',
        'Idea.',
        '',
      ].join('\n')
    )
    await expect(realizeCrSpawn(repo, { crId: 'CR-020', epic: 'E1', type: 'fr', newId: 'E1-FR1' })).rejects.toThrow(
      /already realizes a different impact entry/
    )
  })

  it("rejects a newId whose own id-shape does not match the impact's declared spawns type (#5)", async () => {
    const repo = makeRepo()
    seedCr(repo, 'CR-021', 'confirmed', { entryPoint: 'requirement', impacts: [{ spawns: 'fr', epic: 'E1' }] })
    await expect(realizeCrSpawn(repo, { crId: 'CR-021', epic: 'E1', type: 'fr', newId: 'E1-NFR3' })).rejects.toThrow(
      /not a valid 'fr' id/
    )
  })

  it("rejects a newId whose own epic does not match the impact's declared epic (#8)", async () => {
    const repo = makeRepo()
    seedCr(repo, 'CR-022', 'confirmed', { entryPoint: 'requirement', impacts: [{ spawns: 'fr', epic: 'E5' }] })
    await expect(realizeCrSpawn(repo, { crId: 'CR-022', epic: 'E5', type: 'fr', newId: 'E2-FR9' })).rejects.toThrow(
      /epic \('E2'\) does not match/
    )
  })
})

// ==========================================================================
// setStatus
// ==========================================================================

describe('setStatus', () => {
  const cases: Array<[Status, Status]> = [
    ['draft', 'active'],
    ['draft', 'batched'],
    ['active', 'batched'],
    ['batched', 'baselined'],
    ['batched', 'active'],
  ]
  it.each(cases)('allows the legal transition %s -> %s', async (from, to) => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', { status: from })
    const { id, path } = await setStatus(repo, 'E1-FR1', to)
    expect(id).toBe('E1-FR1')
    const result = parseFile(path, 'fr')
    if ('error' in result) throw new Error(result.error)
    expect(result.frontmatter).toMatchObject({ status: to })
  })

  it('rejects an illegal transition (e.g. active -> baselined, skipping batched)', async () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', { status: 'active' })
    await expect(setStatus(repo, 'E1-FR1', 'baselined')).rejects.toThrow(/illegal status transition/)
  })

  it('rejects a same-state transition', async () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', { status: 'active' })
    await expect(setStatus(repo, 'E1-FR1', 'active')).rejects.toThrow(/already 'active'/)
  })

  it('rejects any transition out of a terminal state (superseded/retired)', async () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', { status: 'superseded' })
    seedFr(repo, 'E1-FR2', 'E1', { status: 'retired' })
    await expect(setStatus(repo, 'E1-FR1', 'active')).rejects.toThrow(/illegal status transition/)
    await expect(setStatus(repo, 'E1-FR2', 'active')).rejects.toThrow(/illegal status transition/)
  })

  it('rejects a non-requirement id', async () => {
    const repo = makeRepo()
    await expect(setStatus(repo, 'CR-001', 'active')).rejects.toThrow(/not a requirement id/)
  })

  it('draft → batched mutates the existing frontmatter and never prepends a second YAML block', async () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', {
      status: 'draft',
      body: '## Rationale\nDepends on PXT-NFR-001 and E1-NFR2.\n\n## Acceptance Criteria\n- AC-1: given a, when b, then c.\n',
    })
    await setStatus(repo, 'E1-FR1', 'batched')
    const raw = readFileSync(join(repo, 'epics/E1-x/E1-FR1.md'), 'utf8')
    expect(raw.match(/^---$/gm)?.length).toBe(2)
    expect(raw).not.toMatch(/\n---\n[\s\S]*?\n---\n---/)
    const parsed = parseFile(join(repo, 'epics/E1-x/E1-FR1.md'), 'fr')
    if ('error' in parsed) throw new Error(parsed.error)
    expect(parsed.frontmatter).toMatchObject({ status: 'batched' })
    expect((parsed.frontmatter as { references_nfr: string[] }).references_nfr).toEqual([
      'E1-NFR2',
      'PXT-NFR-001',
    ])
    expect(bodyHasLeadingFrontmatterFence(parsed.body)).toBe(false)
  })

  it('heals a stale duplicate frontmatter fence left in the body on status transition', async () => {
    const repo = makeRepo()
    seedRaw(
      repo,
      'epics/E1-x/E1-FR1.md',
      [
        '---',
        'id: E1-FR1',
        'type: fr',
        'epic: E1',
        'status: draft',
        'version: 1',
        'traces_to: []',
        'enforces: []',
        'references_nfr: []',
        'related: []',
        '---',
        '',
        '---',
        'id: E1-FR1',
        'type: fr',
        'epic: E1',
        'status: draft',
        'version: 1',
        'traces_to: []',
        'enforces: []',
        'references_nfr: []',
        'related: []',
        '---',
        '',
        '## Rationale',
        'Needs PXT-NFR-002.',
        '',
      ].join('\n'),
    )
    await setStatus(repo, 'E1-FR1', 'batched')
    const raw = readFileSync(join(repo, 'epics/E1-x/E1-FR1.md'), 'utf8')
    expect(raw.match(/^---$/gm)?.length).toBe(2)
    const parsed = parseFile(join(repo, 'epics/E1-x/E1-FR1.md'), 'fr')
    if ('error' in parsed) throw new Error(parsed.error)
    expect(parsed.frontmatter).toMatchObject({ status: 'batched' })
    expect((parsed.frontmatter as { references_nfr: string[] }).references_nfr).toContain('PXT-NFR-002')
    expect(bodyHasLeadingFrontmatterFence(parsed.body)).toBe(false)
  })
})

// ==========================================================================
// setVisionConfirmed
// ==========================================================================

describe('setVisionConfirmed', () => {
  it('sets status/confirmed_at/confirmed_by on a draft vision', async () => {
    const repo = makeRepo()
    seedVision(repo, 'draft')
    const { path } = await setVisionConfirmed(repo, 'alex', '20260713')
    const result = parseFile(path, 'vision')
    if ('error' in result) throw new Error(result.error)
    expect(result.frontmatter).toEqual({
      type: 'vision',
      status: 'confirmed',
      confirmed_at: '20260713',
      confirmed_by: 'alex',
    })
  })

  it('rejects re-confirming an already-confirmed vision', async () => {
    const repo = makeRepo()
    seedVision(repo, 'confirmed')
    await expect(setVisionConfirmed(repo, 'alex', '20260713')).rejects.toThrow(/already confirmed/)
  })
})
