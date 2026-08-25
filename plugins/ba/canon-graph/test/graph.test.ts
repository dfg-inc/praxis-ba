import { describe, it, expect } from 'vitest'
import { buildGraph } from '../src/graph'
import { parsePage, type ParsedPage } from '../src/parse'
import { exportRtm } from '../src/serialize'

// ---- fixture corpus (brief's exact shape: 2 CRs, 3 FRs — one with a
// dangling `enforces` — 1 NFR, 2 BRs, 1 WP) ----
//
// Built via `parsePage` (real read path), not hand-crafted frontmatter
// literals, so the fixture is itself validated by schema.ts the same way a
// real page on disk would be — this module's "Consumes: parse.ts" contract
// exercised, not bypassed.
//
// Wiring, by design:
// - E1-FR1, E1-FR2 both `traces_to: [CR-001]`      → CR-001's spawned-set
// - E1-NFR1 traces_to CR-002 (NOT CR-001)            → keeps CR-001's spawned
//   set exactly {E1-FR1, E1-FR2}, no NFR bleed-through
// - E1-FR3 has traces_to: [] (orphan) AND enforces a BR that doesn't exist
//   anywhere in the corpus (E1-BR9, dangling) — one fixture item covers both
//   `orphans()` and `danglingRefs()`
// - E1-BR1 is enforced by FR1; E1-BR2 is enforced by FR2 (2 BRs total)
// - WP-20260101-001's `## Scope` / `### Delivers` = [E1-FR1] only (not FR2)
//   — so its closure pulls in E1-BR1 (via FR1.enforces) and E1-NFR1 (via
//   FR1.references_nfr), but NOT E1-BR2 (only reachable via FR2, which the
//   WP does not deliver)

function page(raw: string, type: Parameters<typeof parsePage>[1]): ParsedPage {
  const r = parsePage(raw, type)
  if ('error' in r) throw new Error(`fixture page failed to parse: ${r.error}`)
  return r
}

function fixturePages(): ParsedPage[] {
  return [
    page('---\nid: CR-001\ntype: cr\nstatus: captured\n---\n\nFirst captured idea.\n', 'cr'),
    page('---\nid: CR-002\ntype: cr\nstatus: captured\n---\n\nSecond captured idea.\n', 'cr'),
    page(
      '---\nid: E1-FR1\ntype: fr\nepic: E1\nstatus: active\nversion: 1\ntraces_to: [CR-001]\nenforces: [E1-BR1]\nreferences_nfr: [E1-NFR1]\nrelated: []\n---\n\nFirst story, traces to CR-001.\n',
      'fr'
    ),
    page(
      '---\nid: E1-FR2\ntype: fr\nepic: E1\nstatus: active\nversion: 1\ntraces_to: [CR-001]\nenforces: [E1-BR2]\nreferences_nfr: []\nrelated: []\n---\n\nSecond story, also traces to CR-001.\n',
      'fr'
    ),
    page(
      '---\nid: E1-FR3\ntype: fr\nepic: E1\nstatus: draft\nversion: 1\ntraces_to: []\nenforces: [E1-BR9]\nreferences_nfr: []\nrelated: []\n---\n\nThird story: untraced (orphan), enforces a BR that does not exist (dangling).\n',
      'fr'
    ),
    page(
      '---\nid: E1-NFR1\ntype: nfr\nepic: E1\nstatus: active\nversion: 1\ntraces_to: [CR-002]\nverified_by: []\nrelated: []\n---\n\nPerformance budget, traces to CR-002.\n',
      'nfr'
    ),
    page(
      '---\nid: E1-BR1\ntype: br\nepic: E1\nkind: structural\nenforcement: hard\nstatus: active\nversion: 1\n---\n\nMoney math rule.\n',
      'br'
    ),
    page(
      '---\nid: E1-BR2\ntype: br\nepic: E1\nkind: operative\nenforcement: advisory\nstatus: active\nversion: 1\n---\n\nA second rule, enforced only by FR2.\n',
      'br'
    ),
    page(
      '---\nid: WP-20260101-001\ntype: wp\nrole: developer\nstatus: draft\n---\n\nWork package covering FR1 only.\n\n## Scope\n\n### Delivers\n\n- [E1-FR1](epics/E1-x/E1-FR1.md)\n',
      'wp'
    ),
  ]
}

describe('buildGraph — CR spawned-set (derived from traces_to, never stored)', () => {
  it("derives the CR spawned-set from traces_to (never stored)", () => {
    const g = buildGraph(fixturePages())
    expect(g.crSpawned('CR-001').sort()).toEqual(['E1-FR1', 'E1-FR2'])
  })

  it('derives a different CR\'s spawned-set independently (NFR traces_to CR-002)', () => {
    const g = buildGraph(fixturePages())
    expect(g.crSpawned('CR-002')).toEqual(['E1-NFR1'])
  })

  it('returns an empty spawned-set for a CR nothing traces to', () => {
    const g = buildGraph([...fixturePages(), page('---\nid: CR-003\ntype: cr\nstatus: captured\n---\n\nUnclaimed.\n', 'cr')])
    expect(g.crSpawned('CR-003')).toEqual([])
  })
})

describe('buildGraph — WP closure (Scope Delivers + enforced BRs + referenced NFRs + Constraints)', () => {
  it('computes WP closure incl. enforced BRs and referenced NFRs', () => {
    const g = buildGraph(fixturePages())
    expect(g.closure('WP-20260101-001')).toEqual({ frs: ['E1-FR1'], nfrs: ['E1-NFR1'], brs: ['E1-BR1'] })
  })

  it('does NOT pull in a BR/NFR only reachable via a FR outside the closure (FR2 excluded)', () => {
    const g = buildGraph(fixturePages())
    const closure = g.closure('WP-20260101-001')
    expect(closure.brs).not.toContain('E1-BR2')
    expect(closure.frs).not.toContain('E1-FR2')
  })

  it("folds a WP's Scope ### Constraints (BR) into the closure alongside the Delivers-derived set", () => {
    const withConstraints = page(
      '---\nid: WP-20260101-002\ntype: wp\nrole: developer\nstatus: draft\n---\n\nWP with an extra Constraint BR.\n\n## Scope\n\n### Delivers\n\n- [E1-FR1](epics/E1-x/E1-FR1.md)\n\n### Constraints\n\n- [E1-BR2](br/E1-BR2.md)\n',
      'wp'
    )
    const g = buildGraph([...fixturePages(), withConstraints])
    expect(g.closure('WP-20260101-002')).toEqual({ frs: ['E1-FR1'], nfrs: ['E1-NFR1'], brs: ['E1-BR1', 'E1-BR2'] })
  })

  it('returns an empty closure for an unknown WP id', () => {
    const g = buildGraph(fixturePages())
    expect(g.closure('WP-99999999-999')).toEqual({ frs: [], nfrs: [], brs: [] })
  })
})

describe('buildGraph — orphans (FRs with no traces_to)', () => {
  it('lists FRs with an empty traces_to, sorted', () => {
    const g = buildGraph(fixturePages())
    expect(g.orphans()).toEqual(['E1-FR3'])
  })

  it('does not flag a FR that traces to at least one CR', () => {
    const g = buildGraph(fixturePages())
    expect(g.orphans()).not.toContain('E1-FR1')
    expect(g.orphans()).not.toContain('E1-FR2')
  })
})

describe('buildGraph — danglingRefs (catches the bad `enforces`)', () => {
  it('catches E1-FR3 enforcing a BR that does not exist anywhere in the corpus', () => {
    const g = buildGraph(fixturePages())
    expect(g.danglingRefs()).toEqual([{ from: 'E1-FR3', to: 'E1-BR9' }])
  })

  it('reports no dangling refs once the missing BR is added', () => {
    const withMissingBr = page(
      '---\nid: E1-BR9\ntype: br\nepic: E1\nkind: structural\nenforcement: advisory\nstatus: draft\nversion: 1\n---\n\nNow it exists.\n',
      'br'
    )
    const g = buildGraph([...fixturePages(), withMissingBr])
    expect(g.danglingRefs()).toEqual([])
  })
})

describe('buildGraph — backlinks (generic reverse index over the same typed refs)', () => {
  it('resolves a CR\'s backlinks identically to crSpawned', () => {
    const g = buildGraph(fixturePages())
    expect(g.backlinks('CR-001')).toEqual(['E1-FR1', 'E1-FR2'])
  })

  it("resolves a BR's backlinks to the FR that enforces it", () => {
    const g = buildGraph(fixturePages())
    expect(g.backlinks('E1-BR1')).toEqual(['E1-FR1'])
  })

  it("resolves a FR's backlinks to the WP that delivers it (Scope ### Delivers)", () => {
    const g = buildGraph(fixturePages())
    expect(g.backlinks('E1-FR1')).toEqual(['WP-20260101-001'])
  })

  it('returns an empty array for an id nothing points to', () => {
    const g = buildGraph(fixturePages())
    expect(g.backlinks('E1-BR1000')).toEqual([])
  })
})

describe('buildGraph — frReachesCr (FR resolves to a real, existing CR)', () => {
  it('is true for a FR that traces to an existing CR', () => {
    const g = buildGraph(fixturePages())
    expect(g.frReachesCr('E1-FR1')).toBe(true)
  })

  it('is false for a FR with an empty traces_to', () => {
    const g = buildGraph(fixturePages())
    expect(g.frReachesCr('E1-FR3')).toBe(false)
  })

  it('is false for a FR id that does not exist in the graph', () => {
    const g = buildGraph(fixturePages())
    expect(g.frReachesCr('E1-FR999')).toBe(false)
  })
})

describe('buildGraph — raw per-type node projections (what serialize.ts\'s exporters consume)', () => {
  it('buckets every parsed page into its per-type array, dropping non-id-bearing types', () => {
    const g = buildGraph(fixturePages())
    expect(g.crs.map((n) => n.frontmatter.id).sort()).toEqual(['CR-001', 'CR-002'])
    expect(g.frs.map((n) => n.frontmatter.id).sort()).toEqual(['E1-FR1', 'E1-FR2', 'E1-FR3'])
    expect(g.nfrs.map((n) => n.frontmatter.id)).toEqual(['E1-NFR1'])
    expect(g.brs.map((n) => n.frontmatter.id).sort()).toEqual(['E1-BR1', 'E1-BR2'])
    expect(g.wps.map((n) => n.frontmatter.id)).toEqual(['WP-20260101-001'])
    expect(g.epics).toEqual([])
    expect(g.bugs).toEqual([])
  })

  it('buckets epic and bug pages too, and drops a `vision` page (no id) entirely', () => {
    const epic = page('---\nid: E1\ntype: epic\ntitle: Entry & board\nstatus: active\n---\n\nEpic overview.\n', 'epic')
    const bug = page(
      '---\nid: BUG-001\ntype: bug\nstatus: open\nseverity: high\naffects: [E1-FR1]\nreported: "2026-07-13"\nreporter: alex\n---\n\nRepro steps.\n',
      'bug'
    )
    const vision = page('---\ntype: vision\nstatus: draft\n---\n\nProduct vision text.\n', 'vision')
    const g = buildGraph([...fixturePages(), epic, bug, vision])
    expect(g.epics.map((n) => n.frontmatter.id)).toEqual(['E1'])
    expect(g.bugs.map((n) => n.frontmatter.id)).toEqual(['BUG-001'])
  })
})

describe('buildGraph — reconciliation: a real Graph feeds serialize.ts\'s exporters unchanged', () => {
  it('exportRtm(buildGraph(pages)) runs without adaptation', () => {
    const g = buildGraph(fixturePages())
    const out = exportRtm(g)
    expect(out.split('\n')[0]).toBe('# RTM')
    expect(out).toContain('| CR-001 | E1-FR1 | WP-20260101-001 |')
    expect(out).toContain('| CR-001 | E1-FR2 |') // FR2 traces to CR-001 but isn't Delivered by any WP
  })
})

describe('buildGraph — danglingRefs sort tie-break (same `from`, different `to`)', () => {
  it('orders multiple dangling refs from the same node by `to`', () => {
    const frWithTwoDangling = page(
      '---\nid: E1-FR4\ntype: fr\nepic: E1\nstatus: draft\nversion: 1\ntraces_to: []\nenforces: [E1-BR20, E1-BR10]\nreferences_nfr: []\nrelated: []\n---\n\nEnforces two BRs that do not exist.\n',
      'fr'
    )
    const g = buildGraph([...fixturePages(), frWithTwoDangling])
    const fromFr4 = g.danglingRefs().filter((d) => d.from === 'E1-FR4')
    expect(fromFr4).toEqual([
      { from: 'E1-FR4', to: 'E1-BR10' },
      { from: 'E1-FR4', to: 'E1-BR20' },
    ])
  })
})

// ==========================================================================
// v3 (Task 4): Scope-derived WP edges, id -> path index, CR impact queries
// ==========================================================================

describe('buildGraph — v3: closure/wpDelivers/backlinks derived from the WP body Scope section', () => {
  const wpBody =
    'Goal.\n\n## Scope\n\n### Change requests\n- [CR-002](cr/CR-002.md)\n\n### Delivers\n- [E1-FR1 v1](epics/E1-x/E1-FR1.md#acceptance-criteria)\n\n### Constraints\n- [E1-BR1](br/E1-BR1.md)\n'

  function scopedWp(): ParsedPage {
    return page(`---\nid: WP-20260718-001\ntype: wp\nrole: developer\nstatus: draft\n---\n\n${wpBody}`, 'wp')
  }

  it('closure derives from Scope links + FR enforces/references_nfr', () => {
    const g = buildGraph([...fixturePages(), scopedWp()])
    expect(g.closure('WP-20260718-001')).toEqual({ frs: ['E1-FR1'], nfrs: ['E1-NFR1'], brs: ['E1-BR1'] })
  })

  it('wpDelivers returns Scope Delivers ids; backlinks(E1-FR1) includes the WP', () => {
    const g = buildGraph([...fixturePages(), scopedWp()])
    expect(g.wpDelivers('WP-20260718-001')).toEqual(['E1-FR1'])
    expect(g.backlinks('E1-FR1')).toContain('WP-20260718-001')
  })

  it('wpScope exposes the full parsed Scope (incl. Change requests); an unknown WP gets an empty ParsedScope with an error', () => {
    const g = buildGraph([...fixturePages(), scopedWp()])
    const scope = g.wpScope('WP-20260718-001')
    expect(scope.crs.map((r) => r.id)).toEqual(['CR-002'])
    expect(scope.frs.map((r) => r.id)).toEqual(['E1-FR1'])
    expect(scope.brs.map((r) => r.id)).toEqual(['E1-BR1'])

    const unknown = g.wpScope('WP-99999999-999')
    expect(unknown).toEqual({ crs: [], frs: [], nfrs: [], brs: [], errors: expect.arrayContaining([expect.any(String)]) })
  })
})

describe('buildGraph — v3: pathOf (id -> canon-relative path)', () => {
  it('maps ids to canon-relative paths when buildGraph gets a paths map', () => {
    const pages = fixturePages()
    const cr001 = pages[0]!
    const paths = new Map<ParsedPage, string>([[cr001, 'cr/CR-001.md']])
    const g = buildGraph(pages, paths)
    expect(g.pathOf('CR-001')).toBe('cr/CR-001.md')
  })

  it('resolves nothing for any id when buildGraph gets no paths map at all', () => {
    const g = buildGraph(fixturePages())
    expect(g.pathOf('CR-001')).toBeUndefined()
  })

  it('resolves nothing for an id the paths map does not cover, even when other ids are covered', () => {
    const pages = fixturePages()
    const cr001 = pages[0]!
    const paths = new Map<ParsedPage, string>([[cr001, 'cr/CR-001.md']])
    const g = buildGraph(pages, paths)
    expect(g.pathOf('CR-002')).toBeUndefined()
  })
})

describe('buildGraph — v3: crImpacts / crAmendRealized', () => {
  const crWithImpacts = page(
    '---\nid: CR-010\ntype: cr\nstatus: confirmed\nimpacts:\n  - amends: E1-FR1\n  - spawns: fr\n    epic: E1\n---\n\nAmends FR1, spawns a new FR.\n',
    'cr'
  )
  const frWithHistory = page(
    '---\nid: E1-FR5\ntype: fr\nepic: E1\nstatus: baselined\nversion: 2\nbaseline: BL-20260718\ntraces_to: []\nenforces: []\nreferences_nfr: []\nrelated: []\n---\n\nCurrent text.\n\n## History\n\n### v1 — 20260718 — CR-002\n\nPrior text.\n',
    'fr'
  )
  const frWithoutHistory = page(
    '---\nid: E1-FR6\ntype: fr\nepic: E1\nstatus: baselined\nversion: 1\nbaseline: BL-20260718\ntraces_to: []\nenforces: []\nreferences_nfr: []\nrelated: []\n---\n\nNo history at all.\n',
    'fr'
  )
  // finding #24: crAmendRealized must mirror reconcile.ts's `baselined`-status
  // requirement, not just the History citation — an ACTIVE item can carry a
  // stale History citation (e.g. from before it was un-baselined/retargeted)
  // that must NOT count as "realized" yet.
  const frActiveWithHistory = page(
    '---\nid: E1-FR7\ntype: fr\nepic: E1\nstatus: active\nversion: 2\ntraces_to: []\nenforces: []\nreferences_nfr: []\nrelated: []\n---\n\nCurrent text.\n\n## History\n\n### v1 — 20260718 — CR-002\n\nPrior text.\n',
    'fr'
  )

  it("crImpacts reads the frontmatter's impacts list verbatim", () => {
    const g = buildGraph([...fixturePages(), crWithImpacts, frWithHistory, frWithoutHistory])
    expect(g.crImpacts('CR-010')).toEqual([{ amends: 'E1-FR1' }, { spawns: 'fr', epic: 'E1' }])
  })

  it('crImpacts returns [] for a CR with no impacts field, and for an unknown CR', () => {
    const g = buildGraph(fixturePages())
    expect(g.crImpacts('CR-001')).toEqual([])
    expect(g.crImpacts('CR-999')).toEqual([])
  })

  it('crAmendRealized needs a History entry citing the CR on a BASELINED target requirement', () => {
    const g = buildGraph([...fixturePages(), crWithImpacts, frWithHistory, frWithoutHistory])
    expect(g.crAmendRealized('CR-002', 'E1-FR5')).toBe(true)
  })

  it('crAmendRealized is false when the target has History but not for this CR', () => {
    const g = buildGraph([...fixturePages(), crWithImpacts, frWithHistory, frWithoutHistory])
    expect(g.crAmendRealized('CR-999', 'E1-FR5')).toBe(false)
  })

  it('crAmendRealized is false when the target has no History section at all', () => {
    const g = buildGraph([...fixturePages(), crWithImpacts, frWithHistory, frWithoutHistory])
    expect(g.crAmendRealized('CR-002', 'E1-FR6')).toBe(false)
  })

  it('crAmendRealized is false when the target requirement does not exist', () => {
    const g = buildGraph(fixturePages())
    expect(g.crAmendRealized('CR-002', 'E1-FR999')).toBe(false)
  })

  it('crAmendRealized is false when the target has a matching History citation but is NOT baselined (mirrors reconcile.ts)', () => {
    const g = buildGraph([...fixturePages(), crWithImpacts, frActiveWithHistory])
    expect(g.crAmendRealized('CR-002', 'E1-FR7')).toBe(false)
  })
})
