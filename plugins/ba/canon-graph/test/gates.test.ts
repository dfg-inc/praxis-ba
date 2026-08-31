import { describe, it, expect } from 'vitest'
import { buildGraph, type Graph } from '../src/graph'
import { parsePage, type ParsedPage } from '../src/parse'
import { definitionOfReady, acceptGate, type VerifyEvidence } from '../src/gates'

// ---- fixture builders (design spec §8b) ----
//
// Every scenario below is built via `parsePage` (the real read path), same
// convention as graph.test.ts — the fixtures are themselves validated by
// schema.ts, not hand-crafted frontmatter literals that could drift from what
// a page on disk actually looks like.
//
// Canonical ids used throughout: CR-101 (the CR), E9-BR1 (the BR), E9-NFR1
// (the NFR), E9-FR1 (the FR), WP-20260713-101 (the WP). Each test starts from
// an all-green corpus and flips exactly one thing to trigger the scenario
// under test, so a failing check's reason can be asserted to name the id that
// was actually broken.
//
// v3 (Task 7): `definitionOfReady` takes a new `opts.linkRoot` and validates
// the WP's `## Scope` link OBJECTS themselves (path/anchor/version), not just
// the ids `graph.closure` extracts — so every fixture below is built through
// `graphFrom` (a `buildGraph` wrapper that also populates the `paths` map
// Task 4 added) and `wp()` (which renders Scope links whose `path` is
// `../../${the same canon-relative path graphFrom assigns}`), so a
// "green" fixture is Scope-link-correct BY CONSTRUCTION.

function page(raw: string, type: Parameters<typeof parsePage>[1]): ParsedPage {
  const r = parsePage(raw, type)
  if ('error' in r) throw new Error(`fixture page failed to parse: ${r.error}`)
  return r
}

const WELL_FORMED_AC_BODY =
  'Story body.\n\n## Acceptance Criteria\n- AC-1: given a starting state, when the user acts, then an observable outcome.\n'
const NO_AC_BODY = 'Story body with no Acceptance Criteria section at all.\n'
const DUPLICATE_AC_BODY =
  'Story body.\n\n## Acceptance Criteria\n- AC-1: given a, when b, then c.\n- AC-1: given x, when y, then z.\n'
const NON_GHERKIN_AC_BODY =
  'Story body.\n\n## Acceptance Criteria\n- AC-1: Something observable happens.\n'

function cr(id: string, status: 'captured' | 'confirmed' | 'resolved'): ParsedPage {
  return page(`---\nid: ${id}\ntype: cr\nstatus: ${status}\n---\n\nAn idea.\n`, 'cr')
}

function br(id: string, status: string, version = 1): ParsedPage {
  return page(
    `---\nid: ${id}\ntype: br\nepic: E9\nkind: structural\nenforcement: hard\nstatus: ${status}\nversion: ${version}\n---\n\nA rule.\n`,
    'br'
  )
}

function nfr(id: string, status: string, tracesTo: string[] = [], version = 1): ParsedPage {
  return page(
    `---\nid: ${id}\ntype: nfr\nepic: E9\nstatus: ${status}\nversion: ${version}\ntraces_to: [${tracesTo.join(', ')}]\nverified_by: []\nrelated: []\n---\n\nA constraint.\n`,
    'nfr'
  )
}

function fr(opts: {
  id: string
  status: string
  tracesTo: string[]
  enforces: string[]
  referencesNfr: string[]
  body: string
  version?: number
}): ParsedPage {
  return page(
    `---\nid: ${opts.id}\ntype: fr\nepic: E9\nstatus: ${opts.status}\nversion: ${opts.version ?? 1}\ntraces_to: [${opts.tracesTo.join(', ')}]\nenforces: [${opts.enforces.join(', ')}]\nreferences_nfr: [${opts.referencesNfr.join(', ')}]\nrelated: []\n---\n\n${opts.body}`,
    'fr'
  )
}

// v3 (Task 7): the canon-relative path every fixture id resolves to, mirroring
// the real per-type layout (schema.ts's own path comments) — the SAME
// convention `graphFrom`'s `paths` map and `wp()`'s Scope link `path`s both
// use, so a fixture's Scope link matches `../../${graph.pathOf(id)}`
// by construction rather than by coincidence.
const LINK_ROOT = 'product'
function epicFolder(id: string): string {
  return id.split('-')[0]! // 'E9-FR1' -> 'E9'
}
function frRelPath(id: string): string {
  return `epics/${epicFolder(id)}-x/${id}.md`
}
function nfrRelPath(id: string): string {
  return `epics/${epicFolder(id)}-x/${id}.md`
}
function brRelPath(id: string): string {
  return `br/${id}.md`
}
function crRelPath(id: string): string {
  return `cr/${id}.md`
}

/** `buildGraph` + a `paths` map derived from each page's own id/type, so
 * `graph.pathOf(id)` resolves for every fixture node without every test
 * hand-building its own `Map<ParsedPage, string>` (graph.test.ts's own
 * `pathOf` tests build the map inline; this file has many more fixtures per
 * test, so one shared derivation is worth it). */
function graphFrom(pages: ParsedPage[]): Graph {
  const paths = new Map<ParsedPage, string>()
  for (const p of pages) {
    const fm = p.frontmatter as { id?: string; type?: string }
    if (!fm.id || !fm.type) continue
    if (fm.type === 'cr') paths.set(p, crRelPath(fm.id))
    else if (fm.type === 'fr') paths.set(p, frRelPath(fm.id))
    else if (fm.type === 'nfr') paths.set(p, nfrRelPath(fm.id))
    else if (fm.type === 'br') paths.set(p, brRelPath(fm.id))
    else if (fm.type === 'wp') paths.set(p, `wp/${fm.id}/index.md`)
  }
  return buildGraph(pages, paths)
}

// v3 (Task 4): a WP's FR scope lives in the body's `## Scope` / `### Delivers`
// link list, not frontmatter (`fr_ids` is retired) — mechanical flip, same
// call-site shape every test in this file already uses. v3 (Task 7): also
// renders an optional `### Change requests` bucket (`opts.crIds`), and every
// link's `path` is `../../${the real canon-relative path}` — matching
// exactly what `graphFrom`'s `paths` map assigns, so `wp-scope-links` passes
// on a fixture that hasn't deliberately broken something.
function wp(id: string, status: string, frIds: string[], opts: { crIds?: string[] } = {}): ParsedPage {
  const deliversLines = frIds.map((f) => `- [${f}](../../${frRelPath(f)})`).join('\n')
  const crLines = (opts.crIds ?? []).map((c) => `- [${c}](../../${crRelPath(c)})`).join('\n')
  const body = [
    'A work package.',
    '',
    '## Scope',
    '',
    ...(crLines.length > 0 ? ['### Change requests', '', crLines, ''] : []),
    '### Delivers',
    '',
    deliversLines,
    '',
  ].join('\n')
  return page(`---\nid: ${id}\ntype: wp\nrole: developer\nstatus: ${status}\n---\n\n${body}`, 'wp')
}

const WP_ID = 'WP-20260713-101'
const FR_ID = 'E9-FR1'
const CR_ID = 'CR-101'
const BR_ID = 'E9-BR1'
const NFR_ID = 'E9-NFR1'

/** An all-green corpus: every def-of-ready and accept-gate criterion holds. */
function greenPages(wpStatus = 'ready'): ParsedPage[] {
  return [
    cr(CR_ID, 'confirmed'),
    br(BR_ID, 'active'),
    nfr(NFR_ID, 'active', [CR_ID]),
    fr({
      id: FR_ID,
      status: 'active',
      tracesTo: [CR_ID],
      enforces: [BR_ID],
      referencesNfr: [NFR_ID],
      body: WELL_FORMED_AC_BODY,
    }),
    wp(WP_ID, wpStatus, [FR_ID], { crIds: [CR_ID] }),
  ]
}

function validEvidence(overrides: Partial<VerifyEvidence> = {}): VerifyEvidence {
  return {
    wpId: WP_ID,
    commit: 'abc123def',
    testRunHashes: ['hash1'],
    suites: ['unit'],
    producedAt: '2026-07-13T00:00:00Z',
    producedBy: 'ci',
    toolVersion: '0.0.1',
    ...overrides,
  }
}

describe('definitionOfReady', () => {
  it('returns VERIFY-OK when vision is confirmed and every criterion holds, including all four Scope-link checks', () => {
    const g = graphFrom(greenPages())
    const result = definitionOfReady(g, WP_ID, true, { linkRoot: LINK_ROOT })
    expect(result.verdict).toBe('VERIFY-OK')
    expect(result.checks.every((c) => c.ok)).toBe(true)
    for (const name of ['wp-scope-links', 'wp-scope-version-current', 'wp-scope-crs-confirmed', 'frs-trace-to-scoped-cr']) {
      expect(result.checks.find((c) => c.name === name)?.ok, `expected '${name}' to be ok`).toBe(true)
    }
  })

  it('fails when vision is not confirmed', () => {
    const g = graphFrom(greenPages())
    const result = definitionOfReady(g, WP_ID, false, { linkRoot: LINK_ROOT })
    expect(result.verdict).toBe('VERIFY-FAIL')
    const check = result.checks.find((c) => c.name === 'vision-confirmed')
    expect(check?.ok).toBe(false)
    const verdict: string = result.verdict
    expect(verdict).not.toBe('PASS')
  })

  it('fails when a FR in the closure has no Acceptance Criteria at all', () => {
    const pages = [
      cr(CR_ID, 'confirmed'),
      br(BR_ID, 'active'),
      nfr(NFR_ID, 'active', [CR_ID]),
      fr({ id: FR_ID, status: 'active', tracesTo: [CR_ID], enforces: [BR_ID], referencesNfr: [NFR_ID], body: NO_AC_BODY }),
      wp(WP_ID, 'ready', [FR_ID], { crIds: [CR_ID] }),
    ]
    const g = graphFrom(pages)
    const result = definitionOfReady(g, WP_ID, true, { linkRoot: LINK_ROOT })
    expect(result.verdict).toBe('VERIFY-FAIL')
    const check = result.checks.find((c) => c.name === 'frs-well-formed-acs')
    expect(check?.ok).toBe(false)
    expect(check?.reason).toContain(FR_ID)
  })

  it('fails when a FR has a duplicate AC id (malformed AC block, not per-parsed-acs)', () => {
    const pages = [
      cr(CR_ID, 'confirmed'),
      br(BR_ID, 'active'),
      nfr(NFR_ID, 'active', [CR_ID]),
      fr({
        id: FR_ID,
        status: 'active',
        tracesTo: [CR_ID],
        enforces: [BR_ID],
        referencesNfr: [NFR_ID],
        body: DUPLICATE_AC_BODY,
      }),
      wp(WP_ID, 'ready', [FR_ID], { crIds: [CR_ID] }),
    ]
    const g = graphFrom(pages)
    const result = definitionOfReady(g, WP_ID, true, { linkRoot: LINK_ROOT })
    expect(result.verdict).toBe('VERIFY-FAIL')
    const check = result.checks.find((c) => c.name === 'frs-well-formed-acs')
    expect(check?.ok).toBe(false)
    expect(check?.reason).toContain(FR_ID)
  })

  it('fails when a FR AC lacks given/when/then (unverifiable)', () => {
    const pages = [
      cr(CR_ID, 'confirmed'),
      br(BR_ID, 'active'),
      nfr(NFR_ID, 'active', [CR_ID]),
      fr({
        id: FR_ID,
        status: 'active',
        tracesTo: [CR_ID],
        enforces: [BR_ID],
        referencesNfr: [NFR_ID],
        body: NON_GHERKIN_AC_BODY,
      }),
      wp(WP_ID, 'ready', [FR_ID], { crIds: [CR_ID] }),
    ]
    const g = graphFrom(pages)
    const result = definitionOfReady(g, WP_ID, true, { linkRoot: LINK_ROOT })
    expect(result.verdict).toBe('VERIFY-FAIL')
    const check = result.checks.find((c) => c.name === 'frs-well-formed-acs')
    expect(check?.ok).toBe(false)
    expect(check?.reason).toMatch(/unverifiable/i)
  })

  it('fails when an enforced BR is retired', () => {
    const pages = [
      cr(CR_ID, 'confirmed'),
      br(BR_ID, 'retired'),
      nfr(NFR_ID, 'active', [CR_ID]),
      fr({
        id: FR_ID,
        status: 'active',
        tracesTo: [CR_ID],
        enforces: [BR_ID],
        referencesNfr: [NFR_ID],
        body: WELL_FORMED_AC_BODY,
      }),
      wp(WP_ID, 'ready', [FR_ID], { crIds: [CR_ID] }),
    ]
    const g = graphFrom(pages)
    const result = definitionOfReady(g, WP_ID, true, { linkRoot: LINK_ROOT })
    expect(result.verdict).toBe('VERIFY-FAIL')
    const check = result.checks.find((c) => c.name === 'enforced-brs-not-retired')
    expect(check?.ok).toBe(false)
    expect(check?.reason).toContain(BR_ID)
  })

  it('fails when an enforced BR does not resolve to any real BR (dangling enforces)', () => {
    const missingBrId = 'E9-BR9'
    const pages = [
      cr(CR_ID, 'confirmed'),
      nfr(NFR_ID, 'active', [CR_ID]),
      fr({
        id: FR_ID,
        status: 'active',
        tracesTo: [CR_ID],
        enforces: [missingBrId],
        referencesNfr: [NFR_ID],
        body: WELL_FORMED_AC_BODY,
      }),
      wp(WP_ID, 'ready', [FR_ID], { crIds: [CR_ID] }),
    ]
    const g = graphFrom(pages)
    const result = definitionOfReady(g, WP_ID, true, { linkRoot: LINK_ROOT })
    expect(result.verdict).toBe('VERIFY-FAIL')
    const check = result.checks.find((c) => c.name === 'enforced-brs-not-retired')
    expect(check?.ok).toBe(false)
    expect(check?.reason).toContain(missingBrId)
  })

  it('fails when a dangling ref exists in the closure (FR references a NFR that does not exist)', () => {
    const danglingNfrId = 'E9-NFR9'
    const pages = [
      cr(CR_ID, 'confirmed'),
      br(BR_ID, 'active'),
      // note: the real NFR_ID node is deliberately absent — only the dangling
      // reference to danglingNfrId exists.
      fr({
        id: FR_ID,
        status: 'active',
        tracesTo: [CR_ID],
        enforces: [BR_ID],
        referencesNfr: [danglingNfrId],
        body: WELL_FORMED_AC_BODY,
      }),
      wp(WP_ID, 'ready', [FR_ID], { crIds: [CR_ID] }),
    ]
    const g = graphFrom(pages)
    const result = definitionOfReady(g, WP_ID, true, { linkRoot: LINK_ROOT })
    expect(result.verdict).toBe('VERIFY-FAIL')
    const check = result.checks.find((c) => c.name === 'no-dangling-refs-in-closure')
    expect(check?.ok).toBe(false)
    expect(check?.reason).toContain(danglingNfrId)
    expect(check?.reason).toContain(FR_ID)
  })

  it('fails when a FR is not active', () => {
    const pages = [
      cr(CR_ID, 'confirmed'),
      br(BR_ID, 'active'),
      nfr(NFR_ID, 'active', [CR_ID]),
      fr({ id: FR_ID, status: 'draft', tracesTo: [CR_ID], enforces: [BR_ID], referencesNfr: [NFR_ID], body: WELL_FORMED_AC_BODY }),
      wp(WP_ID, 'ready', [FR_ID], { crIds: [CR_ID] }),
    ]
    const g = graphFrom(pages)
    const result = definitionOfReady(g, WP_ID, true, { linkRoot: LINK_ROOT })
    expect(result.verdict).toBe('VERIFY-FAIL')
    const check = result.checks.find((c) => c.name === 'frs-active')
    expect(check?.ok).toBe(false)
    expect(check?.reason).toContain(FR_ID)
  })

  it("fails when a Delivers FR's traces_to resolves only to a CR that IS confirmed but is NOT in the WP's own Scope Change-requests list (frs-trace-to-scoped-cr)", () => {
    const pages = [
      cr(CR_ID, 'confirmed'),
      br(BR_ID, 'active'),
      nfr(NFR_ID, 'active', [CR_ID]),
      fr({
        id: FR_ID,
        status: 'active',
        tracesTo: [CR_ID],
        enforces: [BR_ID],
        referencesNfr: [NFR_ID],
        body: WELL_FORMED_AC_BODY,
      }),
      // the WP's own Scope lists NO Change requests at all — CR-101 exists
      // and is confirmed, but the WP never scoped it.
      wp(WP_ID, 'ready', [FR_ID]),
    ]
    const g = graphFrom(pages)
    const result = definitionOfReady(g, WP_ID, true, { linkRoot: LINK_ROOT })
    expect(result.verdict).toBe('VERIFY-FAIL')
    const check = result.checks.find((c) => c.name === 'frs-trace-to-scoped-cr')
    expect(check?.ok).toBe(false)
    expect(check?.reason).toContain(FR_ID)
  })

  it('fails when a referenced NFR resolves but is not active', () => {
    const pages = [
      cr(CR_ID, 'confirmed'),
      br(BR_ID, 'active'),
      nfr(NFR_ID, 'draft', [CR_ID]),
      fr({
        id: FR_ID,
        status: 'active',
        tracesTo: [CR_ID],
        enforces: [BR_ID],
        referencesNfr: [NFR_ID],
        body: WELL_FORMED_AC_BODY,
      }),
      wp(WP_ID, 'ready', [FR_ID], { crIds: [CR_ID] }),
    ]
    const g = graphFrom(pages)
    const result = definitionOfReady(g, WP_ID, true, { linkRoot: LINK_ROOT })
    expect(result.verdict).toBe('VERIFY-FAIL')
    const check = result.checks.find((c) => c.name === 'referenced-nfrs-active')
    expect(check?.ok).toBe(false)
    expect(check?.reason).toContain(NFR_ID)
  })

  it('fails when the WP references a fr_id that does not resolve to any real FR (dangling fr_id)', () => {
    const missingFrId = 'E9-FR9'
    const pages = [wp(WP_ID, 'draft', [missingFrId])]
    const g = graphFrom(pages)
    const result = definitionOfReady(g, WP_ID, true, { linkRoot: LINK_ROOT })
    expect(result.verdict).toBe('VERIFY-FAIL')
    const activeCheck = result.checks.find((c) => c.name === 'frs-active')
    expect(activeCheck?.ok).toBe(false)
    expect(activeCheck?.reason).toContain(missingFrId)
    const traceCheck = result.checks.find((c) => c.name === 'frs-trace-to-scoped-cr')
    expect(traceCheck?.ok).toBe(false)
    expect(traceCheck?.reason).toContain(missingFrId)
    const acCheck = result.checks.find((c) => c.name === 'frs-well-formed-acs')
    expect(acCheck?.ok).toBe(false)
    expect(acCheck?.reason).toContain(missingFrId)
  })

  it("fails when a closure NFR is active but its OWN traces_to does not resolve to a confirmed CR (NFRs gated like FRs)", () => {
    const unresolvableCrId = 'CR-999'
    const pages = [
      cr(CR_ID, 'confirmed'),
      br(BR_ID, 'active'),
      // E9-NFR1 is active, but traces_to a CR that does not exist anywhere in
      // the corpus — its own upward trace is unresolvable.
      nfr(NFR_ID, 'active', [unresolvableCrId]),
      fr({
        id: FR_ID,
        status: 'active',
        tracesTo: [CR_ID],
        enforces: [BR_ID],
        referencesNfr: [NFR_ID],
        body: WELL_FORMED_AC_BODY,
      }),
      wp(WP_ID, 'ready', [FR_ID], { crIds: [CR_ID] }),
    ]
    const g = graphFrom(pages)
    const result = definitionOfReady(g, WP_ID, true, { linkRoot: LINK_ROOT })
    expect(result.verdict).toBe('VERIFY-FAIL')
    // the NFR is active, so the FR→NFR edge check still passes...
    const activeCheck = result.checks.find((c) => c.name === 'referenced-nfrs-active')
    expect(activeCheck?.ok).toBe(true)
    // ...but the NFR's OWN upward trace fails.
    const traceCheck = result.checks.find((c) => c.name === 'nfrs-trace-to-confirmed-cr')
    expect(traceCheck?.ok).toBe(false)
    expect(traceCheck?.reason).toContain(NFR_ID)
  })

  it("fails a closure NFR whose OWN traces_to points at a CR that exists but is not confirmed", () => {
    const pages = [
      cr(CR_ID, 'confirmed'),
      cr('CR-102', 'captured'),
      br(BR_ID, 'active'),
      nfr(NFR_ID, 'active', ['CR-102']),
      fr({
        id: FR_ID,
        status: 'active',
        tracesTo: [CR_ID],
        enforces: [BR_ID],
        referencesNfr: [NFR_ID],
        body: WELL_FORMED_AC_BODY,
      }),
      wp(WP_ID, 'ready', [FR_ID], { crIds: [CR_ID] }),
    ]
    const g = graphFrom(pages)
    const result = definitionOfReady(g, WP_ID, true, { linkRoot: LINK_ROOT })
    expect(result.verdict).toBe('VERIFY-FAIL')
    const traceCheck = result.checks.find((c) => c.name === 'nfrs-trace-to-confirmed-cr')
    expect(traceCheck?.ok).toBe(false)
    expect(traceCheck?.reason).toContain(NFR_ID)
  })

  it('fails (wp-scope-links) on a WP whose Scope Delivers lists no FR link at all — parseScope requires >=1 Delivers FR, so an empty closure is now a structural Scope violation, not a vacuous pass', () => {
    const pages = [wp(WP_ID, 'draft', [])]
    const g = graphFrom(pages)
    const result = definitionOfReady(g, WP_ID, true, { linkRoot: LINK_ROOT })
    expect(result.verdict).toBe('VERIFY-FAIL')
    const scopeCheck = result.checks.find((c) => c.name === 'wp-scope-links')
    expect(scopeCheck?.ok).toBe(false)
    expect(scopeCheck?.reason).toContain('Delivers')
    // the FR/BR/NFR-specific checks are still vacuously true — the closure
    // itself (as opposed to the raw Scope parse) is empty.
    expect(result.checks.find((c) => c.name === 'frs-active')?.ok).toBe(true)
    expect(result.checks.find((c) => c.name === 'enforced-brs-not-retired')?.ok).toBe(true)
    expect(result.checks.find((c) => c.name === 'referenced-nfrs-active')?.ok).toBe(true)
    expect(result.checks.find((c) => c.name === 'nfrs-trace-to-confirmed-cr')?.ok).toBe(true)
  })

  // ---- v3 (Task 7): the four new Scope-link-integrity checks ----

  it('wp-scope-links fails on a Delivers link whose path does not match `../../${pathOf(id)}`', () => {
    const pages = [
      cr(CR_ID, 'confirmed'),
      br(BR_ID, 'active'),
      nfr(NFR_ID, 'active', [CR_ID]),
      fr({
        id: FR_ID,
        status: 'active',
        tracesTo: [CR_ID],
        enforces: [BR_ID],
        referencesNfr: [NFR_ID],
        body: WELL_FORMED_AC_BODY,
      }),
      page(
        `---\nid: ${WP_ID}\ntype: wp\nrole: developer\nstatus: ready\n---\n\nA work package.\n\n## Scope\n\n### Change requests\n\n- [${CR_ID}](../../${crRelPath(CR_ID)})\n\n### Delivers\n\n- [${FR_ID}](wrong/path/${FR_ID}.md)\n`,
        'wp'
      ),
    ]
    const g = graphFrom(pages)
    const result = definitionOfReady(g, WP_ID, true, { linkRoot: LINK_ROOT })
    expect(result.verdict).toBe('VERIFY-FAIL')
    const check = result.checks.find((c) => c.name === 'wp-scope-links')
    expect(check?.ok).toBe(false)
    expect(check?.reason).toContain(FR_ID)
  })

  it('wp-scope-links fails when a Scope link id does not resolve to any node in the graph', () => {
    const unknownFrId = 'E9-FR9'
    const pages = [cr(CR_ID, 'confirmed'), wp(WP_ID, 'ready', [unknownFrId], { crIds: [CR_ID] })]
    const g = graphFrom(pages)
    const result = definitionOfReady(g, WP_ID, true, { linkRoot: LINK_ROOT })
    expect(result.verdict).toBe('VERIFY-FAIL')
    const check = result.checks.find((c) => c.name === 'wp-scope-links')
    expect(check?.ok).toBe(false)
    expect(check?.reason).toContain(unknownFrId)
  })

  it('wp-scope-links fails when a present anchor does not exist on the target page', () => {
    const pages = [
      cr(CR_ID, 'confirmed'),
      br(BR_ID, 'active'),
      nfr(NFR_ID, 'active', [CR_ID]),
      fr({
        id: FR_ID,
        status: 'active',
        tracesTo: [CR_ID],
        enforces: [BR_ID],
        referencesNfr: [NFR_ID],
        body: WELL_FORMED_AC_BODY,
      }),
      page(
        `---\nid: ${WP_ID}\ntype: wp\nrole: developer\nstatus: ready\n---\n\nA work package.\n\n## Scope\n\n### Change requests\n\n- [${CR_ID}](../../${crRelPath(CR_ID)})\n\n### Delivers\n\n- [${FR_ID}](../../${frRelPath(FR_ID)}#no-such-anchor)\n`,
        'wp'
      ),
    ]
    const g = graphFrom(pages)
    const result = definitionOfReady(g, WP_ID, true, { linkRoot: LINK_ROOT })
    expect(result.verdict).toBe('VERIFY-FAIL')
    const check = result.checks.find((c) => c.name === 'wp-scope-links')
    expect(check?.ok).toBe(false)
    expect(check?.reason).toContain(FR_ID)
  })

  it('wp-scope-version-current fails on a stale v1 Scope link stamp against a FR whose current version is 2', () => {
    const pages = [
      cr(CR_ID, 'confirmed'),
      br(BR_ID, 'active'),
      nfr(NFR_ID, 'active', [CR_ID]),
      fr({
        id: FR_ID,
        status: 'active',
        version: 2,
        tracesTo: [CR_ID],
        enforces: [BR_ID],
        referencesNfr: [NFR_ID],
        body: WELL_FORMED_AC_BODY,
      }),
      page(
        `---\nid: ${WP_ID}\ntype: wp\nrole: developer\nstatus: ready\n---\n\nA work package.\n\n## Scope\n\n### Change requests\n\n- [${CR_ID}](../../${crRelPath(CR_ID)})\n\n### Delivers\n\n- [${FR_ID} v1](../../${frRelPath(FR_ID)})\n`,
        'wp'
      ),
    ]
    const g = graphFrom(pages)
    const result = definitionOfReady(g, WP_ID, true, { linkRoot: LINK_ROOT })
    expect(result.verdict).toBe('VERIFY-FAIL')
    const check = result.checks.find((c) => c.name === 'wp-scope-version-current')
    expect(check?.ok).toBe(false)
    expect(check?.reason).toContain(FR_ID)
  })

  it('wp-scope-version-current fails on a version stamp attached to a CR ref (CR refs never carry version stamps)', () => {
    const pages = [
      cr(CR_ID, 'confirmed'),
      br(BR_ID, 'active'),
      nfr(NFR_ID, 'active', [CR_ID]),
      fr({
        id: FR_ID,
        status: 'active',
        tracesTo: [CR_ID],
        enforces: [BR_ID],
        referencesNfr: [NFR_ID],
        body: WELL_FORMED_AC_BODY,
      }),
      page(
        `---\nid: ${WP_ID}\ntype: wp\nrole: developer\nstatus: ready\n---\n\nA work package.\n\n## Scope\n\n### Change requests\n\n- [${CR_ID} v1](../../${crRelPath(CR_ID)})\n\n### Delivers\n\n- [${FR_ID}](../../${frRelPath(FR_ID)})\n`,
        'wp'
      ),
    ]
    const g = graphFrom(pages)
    const result = definitionOfReady(g, WP_ID, true, { linkRoot: LINK_ROOT })
    expect(result.verdict).toBe('VERIFY-FAIL')
    const check = result.checks.find((c) => c.name === 'wp-scope-version-current')
    expect(check?.ok).toBe(false)
    expect(check?.reason).toContain(CR_ID)
    expect(check?.reason).toContain('do not carry version stamps')
  })

  it("wp-scope-crs-confirmed fails when a CR listed under the WP's own ### Change requests is not confirmed", () => {
    const pages = [
      cr(CR_ID, 'captured'),
      br(BR_ID, 'active'),
      nfr(NFR_ID, 'active', [CR_ID]),
      fr({
        id: FR_ID,
        status: 'active',
        tracesTo: [CR_ID],
        enforces: [BR_ID],
        referencesNfr: [NFR_ID],
        body: WELL_FORMED_AC_BODY,
      }),
      wp(WP_ID, 'ready', [FR_ID], { crIds: [CR_ID] }),
    ]
    const g = graphFrom(pages)
    const result = definitionOfReady(g, WP_ID, true, { linkRoot: LINK_ROOT })
    expect(result.verdict).toBe('VERIFY-FAIL')
    const check = result.checks.find((c) => c.name === 'wp-scope-crs-confirmed')
    expect(check?.ok).toBe(false)
    expect(check?.reason).toContain(CR_ID)
  })

  // finding #25: a `Graph` built WITHOUT a `paths` map is a construction bug
  // (both real call paths — `writer.ts`'s `loadGraph`, `cli.ts`'s `validate`
  // — always populate one) — `scopeLinkIssues` must fail LOUDLY (a thrown
  // invariant violation) rather than silently degrade every Scope link's
  // expected path to `../../`.
  it('scopeLinkIssues (via definitionOfReady) throws when the Graph was built without a paths map', () => {
    const g = buildGraph(greenPages())
    expect(() => definitionOfReady(g, WP_ID, true, { linkRoot: LINK_ROOT })).toThrow(/pathOf returned undefined/)
  })
})

describe('acceptGate', () => {
  it('returns VERIFY-OK with a plan-approved WP and matching, complete evidence', () => {
    const g = buildGraph(greenPages('plan-approved'))
    const evidence = validEvidence()
    const result = acceptGate(g, WP_ID, true, evidence, evidence.commit)
    expect(result.verdict).toBe('VERIFY-OK')
    expect(result.checks.every((c) => c.ok)).toBe(true)
  })

  it('fails when vision is not confirmed', () => {
    const g = buildGraph(greenPages('plan-approved'))
    const evidence = validEvidence()
    const result = acceptGate(g, WP_ID, false, evidence, evidence.commit)
    expect(result.verdict).toBe('VERIFY-FAIL')
    const check = result.checks.find((c) => c.name === 'vision-confirmed')
    expect(check?.ok).toBe(false)
  })

  it('fails when the WP is not plan-approved', () => {
    const g = buildGraph(greenPages('ready'))
    const evidence = validEvidence()
    const result = acceptGate(g, WP_ID, true, evidence, evidence.commit)
    expect(result.verdict).toBe('VERIFY-FAIL')
    const check = result.checks.find((c) => c.name === 'wp-plan-approved')
    expect(check?.ok).toBe(false)
    expect(check?.reason).toContain(WP_ID)
    const verdict: string = result.verdict
    expect(verdict).not.toBe('PASS')
  })

  it("fails when the evidence's commit does not match HEAD", () => {
    const g = buildGraph(greenPages('plan-approved'))
    const evidence = validEvidence({ commit: 'abc123def' })
    const result = acceptGate(g, WP_ID, true, evidence, 'def456abc')
    expect(result.verdict).toBe('VERIFY-FAIL')
    const check = result.checks.find((c) => c.name === 'evidence-commit-matches-head')
    expect(check?.ok).toBe(false)
    expect(check?.reason).toContain('abc123def')
    expect(check?.reason).toContain('def456abc')
  })

  it('fails when a WP FR has zero Acceptance Criteria (AC-presence, structural)', () => {
    const pages = [
      cr(CR_ID, 'confirmed'),
      br(BR_ID, 'active'),
      nfr(NFR_ID, 'active', [CR_ID]),
      fr({ id: FR_ID, status: 'active', tracesTo: [CR_ID], enforces: [BR_ID], referencesNfr: [NFR_ID], body: NO_AC_BODY }),
      wp(WP_ID, 'plan-approved', [FR_ID], { crIds: [CR_ID] }),
    ]
    const g = buildGraph(pages)
    const evidence = validEvidence()
    const result = acceptGate(g, WP_ID, true, evidence, evidence.commit)
    expect(result.verdict).toBe('VERIFY-FAIL')
    const check = result.checks.find((c) => c.name === 'ac-presence')
    expect(check?.ok).toBe(false)
    expect(check?.reason).toContain(FR_ID)
  })

  it('fails when the evidence has no testRunHashes, and the reason names the gate\'s own wpId', () => {
    const g = buildGraph(greenPages('plan-approved'))
    // evidence.wpId deliberately differs from the gate's wpId to prove the
    // reason string sources the gate's own wpId, not evidence.wpId.
    const evidence = validEvidence({ testRunHashes: [], wpId: 'WP-20260101-999' })
    const result = acceptGate(g, WP_ID, true, evidence, evidence.commit)
    expect(result.verdict).toBe('VERIFY-FAIL')
    const check = result.checks.find((c) => c.name === 'evidence-test-run-hashes-present')
    expect(check?.ok).toBe(false)
    expect(check?.reason).toContain(WP_ID)
    expect(check?.reason).not.toContain('WP-20260101-999')
  })

  it('fails when the WP itself does not exist', () => {
    const g = buildGraph(greenPages('plan-approved'))
    const evidence = validEvidence({ wpId: 'WP-99999999-999' })
    const result = acceptGate(g, 'WP-99999999-999', true, evidence, evidence.commit)
    expect(result.verdict).toBe('VERIFY-FAIL')
    const check = result.checks.find((c) => c.name === 'wp-plan-approved')
    expect(check?.ok).toBe(false)
    expect(check?.reason).toContain('WP-99999999-999')
  })
})
