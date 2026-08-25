import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  emitPage,
  naturalCompare,
  exportPrd,
  exportRtm,
  exportBacklog,
  KEY_ORDER,
  REF_ARRAY_KEYS,
  type FrontmatterFor,
} from '../src/serialize'
import { buildGraph } from '../src/graph'
import { parsePage, type ParsedPage } from '../src/parse'
import { schemas, type CrImpact } from '../src/schema'
import type { NodeType, Status } from '../src/types'

const golden = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/golden/${name}.md`, import.meta.url)), 'utf8')

describe('naturalCompare — numeric-aware natural sort (design spec §6 sort comparator)', () => {
  it('sorts E1-FR10 after E1-FR9, never lexicographically', () => {
    expect(naturalCompare('E1-FR9', 'E1-FR10')).toBeLessThan(0)
    expect(naturalCompare('E1-FR10', 'E1-FR9')).toBeGreaterThan(0)
    expect(['E1-FR10', 'E1-FR9'].sort(naturalCompare)).toEqual(['E1-FR9', 'E1-FR10'])
  })

  it('treats identical strings as equal', () => {
    expect(naturalCompare('CR-001', 'CR-001')).toBe(0)
  })

  it('falls back to lexicographic compare on non-numeric runs', () => {
    expect(naturalCompare('E1-BR2', 'E1-FR2')).toBeLessThan(0) // 'BR' < 'FR'
  })

  it('breaks a numeric tie by literal width when the numeric value is equal (e.g. zero-padding)', () => {
    expect(naturalCompare('E1-FR01', 'E1-FR1')).toBeGreaterThan(0) // same value (1), "01" is wider
    expect(naturalCompare('E1-FR1', 'E1-FR01')).toBeLessThan(0)
  })

  it('orders a shorter, wholly-matching prefix before its extension', () => {
    expect(naturalCompare('E1', 'E1-FR1')).toBeLessThan(0)
  })

  it('handles the empty string (no regex match) without throwing', () => {
    expect(naturalCompare('', '')).toBe(0)
    expect(naturalCompare('', 'a')).toBeLessThan(0)
    expect(naturalCompare('a', '')).toBeGreaterThan(0)
  })
})

describe('emitPage — golden byte-compare per node type (fixed key order, sorted refs, verbatim body)', () => {
  it("emits FR frontmatter in fixed key order, body verbatim (brief's exact example)", () => {
    const out = emitPage(
      'fr',
      {
        id: 'E1-FR1',
        type: 'fr',
        epic: 'E1',
        status: 'draft',
        version: 1,
        traces_to: ['CR-002', 'CR-001'],
        enforces: [],
        references_nfr: [],
        related: [],
      },
      '\nStory.\n'
    )
    expect(out).toBe(golden('E1-FR1'))
  })

  it('emits FR with baseline/supersedes/provenance, sorting all three ref-array kinds independently', () => {
    const out = emitPage(
      'fr',
      {
        id: 'E1-FR2',
        type: 'fr',
        epic: 'E1',
        status: 'baselined',
        version: 3,
        traces_to: ['CR-001'],
        enforces: ['E1-BR10', 'E1-BR2'],
        references_nfr: ['E1-NFR10', 'E1-NFR2'],
        related: ['E1-FR10', 'E1-FR9'],
        baseline: 'BL-20260713',
        supersedes: 'E1-FR1',
        provenance: 'migrated',
      },
      '\nUpdated story after baseline.\n'
    )
    expect(out).toBe(golden('E1-FR2'))
  })

  it('emits VISION frontmatter (no id field, per schema)', () => {
    const out = emitPage(
      'vision',
      { type: 'vision', status: 'confirmed', confirmed_at: '2026-07-13', confirmed_by: 'alex' },
      '\nProduct vision text.\n'
    )
    expect(out).toBe(golden('vision'))
  })

  it('emits NFR frontmatter, sorting traces_to and verified_by independently (mixed-length numeric suffix)', () => {
    const out = emitPage(
      'nfr',
      {
        id: 'E1-NFR1',
        type: 'nfr',
        epic: 'E1',
        status: 'active',
        version: 1,
        traces_to: ['CR-002', 'CR-001'],
        verified_by: ['WP-20260713-002', 'WP-20260713-1'],
        related: [],
      },
      '\nPerformance budget.\n'
    )
    expect(out).toBe(golden('E1-NFR1'))
  })

  it('emits BR frontmatter (no ref-array fields on this type)', () => {
    const out = emitPage(
      'br',
      { id: 'E1-BR1', type: 'br', epic: 'E1', kind: 'structural', enforcement: 'hard', status: 'active', version: 1 },
      '\nMoney math rule.\n'
    )
    expect(out).toBe(golden('E1-BR1'))
  })

  it('emits CR frontmatter with entry_point + an impacts set (v3 object-array field, insertion order preserved)', () => {
    const out = emitPage(
      'cr',
      {
        id: 'CR-001',
        type: 'cr',
        status: 'confirmed',
        entry_point: 'requirement',
        entry_point_confirmed: true,
        impacts: [{ amends: 'E2-FR1' }, { spawns: 'fr', epic: 'E2' }],
      },
      '\nCaptured idea.\n'
    )
    expect(out).toBe(golden('CR-001'))
  })

  it('emits WP frontmatter (v3 slim shape — role/status/plan only; refs live in the body Scope section)', () => {
    const out = emitPage(
      'wp',
      { id: 'WP-20260713-001', type: 'wp', role: 'developer', status: 'draft' },
      '\nWork package plan.\n\n## Scope\n\n### Change requests\n- [CR-001](cr/CR-001.md)\n\n### Delivers\n- [E1-FR1 v1](epics/E1-x/E1-FR1.md#acceptance-criteria)\n\n### Constraints\n- [E1-BR1](br/E1-BR1.md)\n'
    )
    expect(out).toBe(golden('WP-20260713-001'))
  })

  it('emits BUG frontmatter, sorting affects by the natural comparator', () => {
    const out = emitPage(
      'bug',
      {
        id: 'BUG-001',
        type: 'bug',
        status: 'open',
        severity: 'high',
        affects: ['E1-FR10', 'E1-FR9'],
        reported: '2026-07-13',
        reporter: 'alex',
      },
      '\nBug description.\n'
    )
    expect(out).toBe(golden('BUG-001'))
  })

  it('emits EPIC-INDEX frontmatter', () => {
    const out = emitPage('epic', { id: 'E1', type: 'epic', title: 'Entry & board', status: 'active' }, '\nEpic overview.\n')
    expect(out).toBe(golden('E1'))
  })

  it('never emits YAML anchor/alias syntax in any golden case', () => {
    for (const name of [
      'E1-FR1',
      'E1-FR2',
      'vision',
      'E1-NFR1',
      'E1-BR1',
      'CR-001',
      'WP-20260713-001',
      'BUG-001',
      'E1',
    ]) {
      expect(golden(name)).not.toMatch(/(^|\s)[&*][A-Za-z0-9_]/m)
    }
  })
})

describe('emitPage — determinism contract (zero ambient nondeterminism)', () => {
  it('never mutates the input frontmatter object (ref-array sort must not be in-place)', () => {
    const fm = {
      id: 'E1-FR1',
      type: 'fr' as const,
      epic: 'E1',
      status: 'draft' as const,
      version: 1,
      traces_to: ['CR-002', 'CR-001'],
      enforces: [],
      references_nfr: [],
      related: [],
    }
    const before = JSON.parse(JSON.stringify(fm)) as unknown
    emitPage('fr', fm, '\nStory.\n')
    expect(fm).toEqual(before)
  })

  it('omits an optional key that is present but explicitly undefined, rather than emitting a null', () => {
    const fm = {
      id: 'CR-001',
      type: 'cr' as const,
      status: 'captured' as const,
      entry_point: undefined,
    }
    const out = emitPage('cr', fm, '\nbody\n')
    expect(out).not.toContain('entry_point')
  })

  it('omits an optional key that is present but null (never emits `key: null`)', () => {
    const fm = {
      id: 'CR-001',
      type: 'cr' as const,
      status: 'captured' as const,
      // A stray null (e.g. round-tripped from a hand-edited file) must be
      // dropped, not serialized as `entry_point: null`.
      entry_point: null as unknown as 'vision' | 'requirement' | undefined,
    }
    const out = emitPage('cr', fm, '\nbody\n')
    expect(out).not.toContain('entry_point')
    expect(out).not.toContain('null')
  })

  it('produces LF-only output with exactly one trailing newline for a well-formed body', () => {
    const out = emitPage('cr', { id: 'CR-001', type: 'cr', status: 'captured' }, '\nbody\n')
    expect(out.includes('\r')).toBe(false)
    expect(out.endsWith('\n')).toBe(true)
    expect(out.endsWith('\n\n')).toBe(false)
  })

  describe('single trailing newline canonicalization (body content stays verbatim)', () => {
    it('appends exactly one LF when the body has no trailing newline at all', () => {
      const out = emitPage('cr', { id: 'CR-001', type: 'cr', status: 'captured' }, '\nno trailing newline')
      expect(out.endsWith('no trailing newline\n')).toBe(true)
      expect(out.endsWith('\n\n')).toBe(false)
    })

    it('collapses three trailing newlines down to exactly one', () => {
      const out = emitPage('cr', { id: 'CR-001', type: 'cr', status: 'captured' }, '\nbody\n\n\n')
      expect(out.endsWith('body\n')).toBe(true)
      expect(out.endsWith('body\n\n')).toBe(false)
    })

    it('leaves the body internal content (everything before the trailing run) byte-for-byte unchanged', () => {
      // A content string with internal blank lines and a mid-body `---` rule —
      // none of which may be touched; only the tail newline run is normalized.
      const content = '\nLine one.\n\n---\n\nLine two, after a rule.'
      const outNone = emitPage('cr', { id: 'CR-001', type: 'cr', status: 'captured' }, content)
      const outMany = emitPage('cr', { id: 'CR-001', type: 'cr', status: 'captured' }, `${content}\n\n\n`)
      // Both non-canonical inputs (no trailing NL / 3 trailing NLs) must yield
      // the identical canonical output: content verbatim + exactly one LF.
      const expectedTail = `${content}\n`
      expect(outNone.endsWith(expectedTail)).toBe(true)
      expect(outMany.endsWith(expectedTail)).toBe(true)
      expect(outNone).toBe(outMany)
    })

    it('emits no stray blank line for an empty body — the fence provides the single trailing newline', () => {
      const out = emitPage('cr', { id: 'CR-001', type: 'cr', status: 'captured' }, '')
      expect(out.endsWith('status: captured\n---\n')).toBe(true)
      expect(out.endsWith('---\n\n')).toBe(false)
    })

    it('treats an all-newline body the same as empty (no stray blank after the fence)', () => {
      const out = emitPage('cr', { id: 'CR-001', type: 'cr', status: 'captured' }, '\n\n\n')
      expect(out.endsWith('---\n')).toBe(true)
      expect(out.endsWith('---\n\n')).toBe(false)
    })
  })

  it('is a pure function of its inputs — calling twice with equal inputs yields identical bytes', () => {
    const fm = {
      id: 'E1-BR1',
      type: 'br' as const,
      epic: 'E1',
      kind: 'structural' as const,
      enforcement: 'hard' as const,
      status: 'active' as const,
      version: 1,
    }
    expect(emitPage('br', fm, '\nx\n')).toBe(emitPage('br', fm, '\nx\n'))
  })
})

describe('emitPage — round-trip property (fast-check)', () => {
  const posInt = (max: number): fc.Arbitrary<number> => fc.integer({ min: 1, max })
  const pad = (n: number, width: number): string => String(n).padStart(width, '0')
  const safeText = (maxLength = 16): fc.Arbitrary<string> =>
    fc.stringOf(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.'".split('')), {
      minLength: 1,
      maxLength,
    })

  const epicIdArb = posInt(30).map((n) => `E${n}`)
  const frIdArb = fc.tuple(posInt(9), posInt(30)).map(([e, n]) => `E${e}-FR${n}`)
  const nfrIdArb = fc.tuple(posInt(9), posInt(30)).map(([e, n]) => `E${e}-NFR${n}`)
  const brIdArb = fc.tuple(posInt(9), posInt(30)).map(([e, n]) => `E${e}-BR${n}`)
  const crIdArb = posInt(999).map((n) => `CR-${pad(n, 3)}`)
  const bugIdArb = posInt(999).map((n) => `BUG-${pad(n, 3)}`)
  const wpIdArb = fc.tuple(posInt(99999999), posInt(999)).map(([d, s]) => `WP-${pad(d, 8)}-${pad(s, 3)}`)
  const baselineIdArb = posInt(99999999).map((n) => `BL-${pad(n, 8)}`)
  const refIdArb = fc.oneof(frIdArb, nfrIdArb, brIdArb, crIdArb, wpIdArb, bugIdArb, epicIdArb)

  // Pre-sorted (canonical) ref arrays: models the real invariant that any `fm`
  // a caller re-emits was itself written by emitPage, so its ref arrays are
  // already naturally sorted — keeps the round-trip a true deep-equal. The
  // sort-on-emit behavior for ARBITRARY-order input is proven separately by
  // the golden tests and by the dedicated sort property below.
  const sortedIdArray = (idArb: fc.Arbitrary<string>, maxLength = 4): fc.Arbitrary<string[]> =>
    fc.uniqueArray(idArb, { maxLength }).map((arr) => [...arr].sort(naturalCompare))

  // Arbitrary-ORDER (deliberately un-pre-sorted) ref array — fc.uniqueArray
  // yields elements in generation order, not sorted.
  const unsortedIdArray = (idArb: fc.Arbitrary<string>, maxLength = 6): fc.Arbitrary<string[]> =>
    fc.uniqueArray(idArb, { maxLength })

  const statusArb: fc.Arbitrary<Status> = fc.constantFrom(
    'draft',
    'active',
    'batched',
    'baselined',
    'superseded',
    'retired'
  )
  // Canonical bodies only (leading + exactly one trailing LF; `s` never
  // contains a newline) — so emitPage's trailing-newline canonicalization is a
  // no-op here and `parsePage(emitPage(...)).body === body` stays a true
  // round-trip. Non-canonical→canonical normalization is proven by the
  // targeted "single trailing newline" tests above, not by this property.
  const bodyArb = safeText(40).map((s) => `\n${s}\n`)

  const visionArb = fc.record(
    {
      type: fc.constant('vision' as const),
      status: fc.constantFrom('draft' as const, 'confirmed' as const),
      confirmed_at: safeText(),
      confirmed_by: safeText(),
    },
    { requiredKeys: ['type', 'status'] }
  )

  const frArb = fc.record(
    {
      id: frIdArb,
      type: fc.constant('fr' as const),
      epic: epicIdArb,
      status: statusArb,
      version: posInt(9),
      traces_to: sortedIdArray(crIdArb),
      enforces: sortedIdArray(brIdArb),
      references_nfr: sortedIdArray(nfrIdArb),
      related: sortedIdArray(refIdArb),
      baseline: baselineIdArb,
      supersedes: frIdArb,
      superseded_by: frIdArb,
      provenance: fc.constant('migrated' as const),
    },
    {
      requiredKeys: ['id', 'type', 'epic', 'status', 'version', 'traces_to', 'enforces', 'references_nfr', 'related'],
    }
  )

  const nfrArb = fc.record(
    {
      id: nfrIdArb,
      type: fc.constant('nfr' as const),
      epic: epicIdArb,
      status: statusArb,
      version: posInt(9),
      traces_to: sortedIdArray(crIdArb),
      verified_by: sortedIdArray(refIdArb),
      related: sortedIdArray(refIdArb),
      baseline: baselineIdArb,
      supersedes: nfrIdArb,
      superseded_by: nfrIdArb,
      provenance: fc.constant('migrated' as const),
    },
    { requiredKeys: ['id', 'type', 'epic', 'status', 'version', 'traces_to', 'verified_by', 'related'] }
  )

  const brArb = fc.record(
    {
      id: brIdArb,
      type: fc.constant('br' as const),
      epic: epicIdArb,
      kind: fc.constantFrom('structural' as const, 'operative' as const),
      enforcement: fc.constantFrom('advisory' as const, 'hard' as const),
      status: statusArb,
      version: posInt(9),
      baseline: baselineIdArb,
      supersedes: brIdArb,
      superseded_by: brIdArb,
      provenance: fc.constant('migrated' as const),
    },
    { requiredKeys: ['id', 'type', 'epic', 'kind', 'enforcement', 'status', 'version'] }
  )

  // finding #22: the v3 `impacts` field (a discriminated-union ARRAY, unlike
  // every other cr field) had zero fuzz coverage — only hand-written seeds
  // elsewhere exercised a basic round-trip, and only through a single shape.
  // Covers 0/1/multi-entry arrays mixing both `amends` and `spawns` (with and
  // without `realized`).
  const requirementIdArb = fc.oneof(frIdArb, nfrIdArb, brIdArb)
  const crImpactArb: fc.Arbitrary<CrImpact> = fc.oneof(
    requirementIdArb.map((amends): CrImpact => ({ amends })),
    fc.record(
      {
        spawns: fc.constantFrom('fr' as const, 'nfr' as const, 'br' as const),
        epic: epicIdArb,
        realized: requirementIdArb,
      },
      { requiredKeys: ['spawns', 'epic'] }
    )
  )

  const crArb = fc.record(
    {
      id: crIdArb,
      type: fc.constant('cr' as const),
      status: fc.constantFrom('captured' as const, 'confirmed' as const, 'resolved' as const),
      entry_point: fc.constantFrom('vision' as const, 'requirement' as const),
      entry_point_confirmed: fc.boolean(),
      impacts: fc.array(crImpactArb, { maxLength: 4 }),
      provenance: fc.constant('backfilled' as const),
      spawned_from_bug: bugIdArb,
    },
    { requiredKeys: ['id', 'type', 'status'] }
  )

  const wpArb = fc.record(
    {
      id: wpIdArb,
      type: fc.constant('wp' as const),
      role: fc.constantFrom('developer' as const, 'qa' as const),
      status: fc.constantFrom(
        'draft' as const,
        'ready' as const,
        'plan-approved' as const,
        'accepted' as const,
        'abandoned' as const
      ),
      plan: safeText(),
    },
    { requiredKeys: ['id', 'type', 'role', 'status'] }
  )

  const bugArb = fc.record(
    {
      id: bugIdArb,
      type: fc.constant('bug' as const),
      status: fc.constantFrom('open' as const, 'fixed' as const, 'wontfix' as const, 'duplicate' as const),
      severity: safeText(8),
      affects: sortedIdArray(refIdArb, 5),
      reported: safeText(),
      reporter: safeText(),
      spawned_cr: crIdArb,
    },
    { requiredKeys: ['id', 'type', 'status', 'severity', 'affects', 'reported', 'reporter'] }
  )

  const epicArb = fc.record({
    id: epicIdArb,
    type: fc.constant('epic' as const),
    title: safeText(),
    status: safeText(8),
  })

  type Case =
    | { type: 'vision'; fm: FrontmatterFor<'vision'> }
    | { type: 'fr'; fm: FrontmatterFor<'fr'> }
    | { type: 'nfr'; fm: FrontmatterFor<'nfr'> }
    | { type: 'br'; fm: FrontmatterFor<'br'> }
    | { type: 'cr'; fm: FrontmatterFor<'cr'> }
    | { type: 'wp'; fm: FrontmatterFor<'wp'> }
    | { type: 'bug'; fm: FrontmatterFor<'bug'> }
    | { type: 'epic'; fm: FrontmatterFor<'epic'> }

  const caseArb: fc.Arbitrary<Case> = fc.oneof(
    visionArb.map((fm): Case => ({ type: 'vision', fm })),
    frArb.map((fm): Case => ({ type: 'fr', fm })),
    nfrArb.map((fm): Case => ({ type: 'nfr', fm })),
    brArb.map((fm): Case => ({ type: 'br', fm })),
    crArb.map((fm): Case => ({ type: 'cr', fm })),
    wpArb.map((fm): Case => ({ type: 'wp', fm })),
    bugArb.map((fm): Case => ({ type: 'bug', fm })),
    epicArb.map((fm): Case => ({ type: 'epic', fm }))
  )

  function emitCase(kase: Case, body: string): string {
    switch (kase.type) {
      case 'vision':
        return emitPage(kase.type, kase.fm, body)
      case 'fr':
        return emitPage(kase.type, kase.fm, body)
      case 'nfr':
        return emitPage(kase.type, kase.fm, body)
      case 'br':
        return emitPage(kase.type, kase.fm, body)
      case 'cr':
        return emitPage(kase.type, kase.fm, body)
      case 'wp':
        return emitPage(kase.type, kase.fm, body)
      case 'bug':
        return emitPage(kase.type, kase.fm, body)
      case 'epic':
        return emitPage(kase.type, kase.fm, body)
    }
  }

  it('parsePage(emitPage(type, fm, body)).frontmatter deep-equals fm, and the body round-trips, for every node type', () => {
    fc.assert(
      fc.property(caseArb, bodyArb, (kase, body) => {
        const out = emitCase(kase, body)
        const result = parsePage(out, kase.type)
        expect('error' in result).toBe(false)
        if ('error' in result) return
        expect(result.frontmatter).toEqual(kase.fm)
        expect(result.body).toBe(body)
      }),
      { numRuns: 200 }
    )
  })

  it('emit sorts every ref array by naturalCompare regardless of input order (FR — all four ref-array kinds)', () => {
    fc.assert(
      fc.property(
        unsortedIdArray(crIdArb),
        unsortedIdArray(brIdArb),
        unsortedIdArray(nfrIdArb),
        unsortedIdArray(refIdArb),
        (tracesTo, enforces, referencesNfr, related) => {
          const fm = {
            id: 'E1-FR1',
            type: 'fr' as const,
            epic: 'E1',
            status: 'draft' as const,
            version: 1,
            traces_to: tracesTo,
            enforces,
            references_nfr: referencesNfr,
            related,
          }
          const result = parsePage(emitPage('fr', fm, '\nx\n'), 'fr')
          expect('error' in result).toBe(false)
          if ('error' in result) return
          const out = result.frontmatter as FrontmatterFor<'fr'>
          expect(out.traces_to).toEqual([...tracesTo].sort(naturalCompare))
          expect(out.enforces).toEqual([...enforces].sort(naturalCompare))
          expect(out.references_nfr).toEqual([...referencesNfr].sort(naturalCompare))
          expect(out.related).toEqual([...related].sort(naturalCompare))
        }
      ),
      { numRuns: 200 }
    )
  })

  it('emit sorts ref arrays for the other registered types too (BUG.affects — WP has no ref-array fields left, v3)', () => {
    fc.assert(
      fc.property(unsortedIdArray(refIdArb), (affects) => {
        const bug = {
          id: 'BUG-001',
          type: 'bug' as const,
          status: 'open' as const,
          severity: 'high',
          affects,
          reported: '2026-07-13',
          reporter: 'alex',
        }
        const bugOut = parsePage(emitPage('bug', bug, '\nx\n'), 'bug')
        expect('error' in bugOut).toBe(false)
        if (!('error' in bugOut)) {
          expect((bugOut.frontmatter as FrontmatterFor<'bug'>).affects).toEqual([...affects].sort(naturalCompare))
        }
      }),
      { numRuns: 200 }
    )
  })
})

describe('exportPrd / exportRtm / exportBacklog — view exporters over a real Graph', () => {
  // exportRtm/exportBacklog (v3, Task 4) take a full `Graph` — a WP's
  // delivered-FR set is a QUERY (`wpDelivers`, sourced from the body's
  // `## Scope` section), not a plain data field, so a hand-built data-only
  // literal (the pre-v3 `ExportGraph` shape) can no longer stand in for it.
  // Built via the real `parsePage` + `buildGraph` path instead — the exact
  // same corpus this block always exercised, just constructed as real pages.
  // `exportPrd` still only needs the `ExportGraph` slice, so it's exercised
  // unchanged by passing this same `graph` value (a `Graph` satisfies
  // `ExportGraph` structurally).
  function page(raw: string, type: Parameters<typeof parsePage>[1]): ParsedPage {
    const r = parsePage(raw, type)
    if ('error' in r) throw new Error(`fixture page failed to parse: ${r.error}`)
    return r
  }

  const graph = buildGraph([
    page('---\nid: E1\ntype: epic\ntitle: Entry & board\nstatus: active\n---\n\n', 'epic'),
    page(
      '---\nid: E1-FR2\ntype: fr\nepic: E1\nstatus: active\nversion: 1\ntraces_to: [CR-001]\nenforces: []\nreferences_nfr: []\nrelated: []\n---\n\nSecond story.\n',
      'fr'
    ),
    page(
      '---\nid: E1-FR1\ntype: fr\nepic: E1\nstatus: draft\nversion: 1\ntraces_to: [CR-002, CR-001]\nenforces: []\nreferences_nfr: []\nrelated: []\n---\n\nFirst story.\n',
      'fr'
    ),
    page(
      '---\nid: E1-FR3\ntype: fr\nepic: E1\nstatus: draft\nversion: 1\ntraces_to: []\nenforces: []\nreferences_nfr: []\nrelated: []\n---\n\nThird story, untraced and unbuilt.\n',
      'fr'
    ),
    page(
      '---\nid: E1-NFR1\ntype: nfr\nepic: E1\nstatus: active\nversion: 1\ntraces_to: []\nverified_by: []\nrelated: []\n---\n\nPerformance budget note.\n',
      'nfr'
    ),
    page('---\nid: CR-002\ntype: cr\nstatus: captured\n---\n\n', 'cr'),
    page('---\nid: CR-001\ntype: cr\nstatus: resolved\n---\n\n', 'cr'),
    page(
      '---\nid: WP-20260713-001\ntype: wp\nrole: developer\nstatus: draft\n---\n\n## Scope\n\n### Delivers\n\n- [E1-FR1](epics/E1-x/E1-FR1.md)\n',
      'wp'
    ),
    page(
      '---\nid: BUG-001\ntype: bug\nstatus: open\nseverity: high\naffects: [E1-FR1]\nreported: "2026-07-13"\nreporter: alex\n---\n\n',
      'bug'
    ),
  ])

  it('exportPrd orders epics and FRs by natural id regardless of input order, and inlines each FR/NFR body', () => {
    const out = exportPrd(graph)
    expect(out.indexOf('E1-FR1')).toBeLessThan(out.indexOf('E1-FR2'))
    expect(out).toContain('First story.')
    expect(out).toContain('Second story.')
    expect(out).toContain('E1-NFR1')
    expect(out).toContain('Performance budget note.')
  })

  it('exportRtm produces one row per CR×FR pair, WPs joined, sorted by CR then FR', () => {
    const out = exportRtm(graph)
    const lines = out.trim().split('\n')
    expect(lines[0]).toBe('# RTM')
    expect(out).toContain('| CR-001 | E1-FR1 | WP-20260713-001 |')
    expect(out).toContain('| CR-002 | E1-FR1 | WP-20260713-001 |')
    expect(out).toContain('| — | E1-FR3 | — |') // untraced, unbuilt FR: both columns fall back to the placeholder
  })

  it('exportBacklog lists only open CRs/bugs and non-terminal WPs, sorted by natural id', () => {
    const out = exportBacklog(graph)
    expect(out).toContain('CR-002')
    expect(out).not.toContain('CR-001 (')
    expect(out).toContain('WP-20260713-001')
    expect(out).toContain('BUG-001')
  })

  it('is deterministic — calling twice on the same graph yields identical output', () => {
    expect(exportPrd(graph)).toBe(exportPrd(graph))
    expect(exportRtm(graph)).toBe(exportRtm(graph))
    expect(exportBacklog(graph)).toBe(exportBacklog(graph))
  })
})

describe('KEY_ORDER / REF_ARRAY_KEYS drift guard (cross-checked against schema.ts shapes)', () => {
  // Peel ZodOptional/ZodDefault/ZodNullable/ZodEffects wrappers off a field so
  // e.g. `z.array(...).optional()` is still recognized as an array-typed field.
  function unwrap(field: z.ZodTypeAny): z.ZodTypeAny {
    let cur = field
    // `_def` inspection is zod's only route to the wrapped inner type; this is
    // a test-only guard, so reaching into internals here is acceptable.
    for (;;) {
      const def = cur._def as { typeName?: string; innerType?: z.ZodTypeAny; schema?: z.ZodTypeAny }
      if (def.typeName === 'ZodOptional' || def.typeName === 'ZodDefault' || def.typeName === 'ZodNullable') {
        if (!def.innerType) return cur
        cur = def.innerType
      } else if (def.typeName === 'ZodEffects') {
        if (!def.schema) return cur
        cur = def.schema
      } else {
        return cur
      }
    }
  }

  function shapeOf(type: NodeType): Record<string, z.ZodTypeAny> {
    // Every schema in the `schemas` registry is a ZodObject; narrow to read
    // its `.shape` without an `any`.
    const schema = schemas[type] as unknown as z.ZodObject<z.ZodRawShape>
    return schema.shape
  }

  const types = Object.keys(schemas) as NodeType[]

  // Array-typed schema fields whose ELEMENT is an object, not a ref-id
  // string (e.g. cr.impacts, v3 §2.1) — these deliberately stay out of
  // REF_ARRAY_KEYS, whose sort (`sortRefs`/`naturalCompare`) is string-array
  // only, and are exempted from the "every array field is registered" guard
  // below rather than asserted to be absent from it (a fresh entry with a
  // string-array field would still need to register normally).
  const OBJECT_ARRAY_FIELDS: Record<string, readonly string[]> = { cr: ['impacts'] }

  it.each(types)('every array-typed field in the %s schema is registered in REF_ARRAY_KEYS', (type) => {
    const shape = shapeOf(type)
    const arrayFields = Object.keys(shape).filter((key) => unwrap(shape[key]!) instanceof z.ZodArray)
    const expected = arrayFields.filter((f) => !(OBJECT_ARRAY_FIELDS[type] ?? []).includes(f))
    for (const field of expected) {
      expect(REF_ARRAY_KEYS[type]).toContain(field)
    }
  })

  it.each(types)('REF_ARRAY_KEYS[%s] lists only real array fields of that schema', (type) => {
    const shape = shapeOf(type)
    for (const registered of REF_ARRAY_KEYS[type]) {
      expect(shape[registered]).toBeDefined()
      expect(unwrap(shape[registered]!)).toBeInstanceOf(z.ZodArray)
    }
  })

  it.each(types)('KEY_ORDER[%s] lists exactly the fields of that schema (no missing, no stale)', (type) => {
    const schemaFields = Object.keys(shapeOf(type)).sort()
    const keyOrderFields = [...KEY_ORDER[type]].sort()
    expect(keyOrderFields).toEqual(schemaFields)
  })
})
