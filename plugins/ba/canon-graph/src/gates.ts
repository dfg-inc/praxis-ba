// ---- the two human-gate evaluators (design spec §8b) ----
//
// `definitionOfReady` blocks `wp prepare`; `acceptGate` blocks `accept`. Both
// are pure — no IO, no filesystem access, no clock reads — the caller loads
// the page corpus (via parse.ts + graph.ts) and the VERIFY-EVIDENCE artifact
// and passes them in. Both return `{ verdict, checks[] }`; `verdict` is only
// ever the literal `'VERIFY-OK'` or `'VERIFY-FAIL'` — this codebase never
// writes the bare string `PASS` for a machine-run check (owner decision,
// ADLC process doc: only a human ever writes an accept verb).
//
// Task 4 carried note: `parsePage` discards `parseAcBlock`'s `.error` (the
// duplicate-AC-id signal), and — more fundamentally — `graph.ts`'s
// `buildGraph` doesn't even carry a page's `acs` field onto `GraphNode` (it
// only keeps `{ frontmatter, body }`, see graph.ts's per-type push calls). So
// there is no way to ask "does this FR have well-formed ACs?" from a `Graph`
// alone; `acIssue` below calls `parseAcBlock(fr.body)` directly on every FR
// it inspects, and treats a `.error` (duplicate AC id) as a failed
// "well-formed AC" check exactly like a zero-AC body — never assumes some
// upstream `acs` array already reflects validity.

import type { z } from 'zod'
import { dirname, relative } from 'node:path'
import type { Graph, GraphNode } from './graph.js'
import { parseAcBlock, unverifiableAcIds } from './ac.js'
import { pageAnchors } from './scopelinks.js'
import { verifyEvidenceSchema } from './schema.js'
import type { Verdict, Check } from './types.js'

export type VerifyEvidence = z.infer<typeof verifyEvidenceSchema>

// ---- shared helpers ----

function byId<T extends { frontmatter: { id: string } }>(nodes: readonly T[]): Map<string, T> {
  return new Map(nodes.map((n) => [n.frontmatter.id, n]))
}

/**
 * `undefined` if `frId`'s Acceptance Criteria block is well-formed, has
 * >=1 entry, and every AC is Gherkin-verifiable (given/when/then or
 * Дано/Когда/Тогда); otherwise a human-readable reason naming `frId`. A
 * duplicate AC id (`parseAcBlock`'s `.error`) is a failed check, same as
 * zero ACs — see file header. Unverifiable AC text is marked explicitly
 * (WBS 1.12).
 */
function acIssue(frId: string, fr: GraphNode<'fr'> | undefined): string | undefined {
  if (!fr) return `${frId}: FR not found`
  const result = parseAcBlock(fr.body)
  if (result.error !== undefined) return `${frId}: ${result.error}`
  if (result.acs.length === 0) return `${frId}: has no Acceptance Criteria`
  const bad = unverifiableAcIds(result.acs)
  if (bad.length > 0) {
    return `${frId}: AC-${bad.join(', AC-')} unverifiable (need given/when/then or Дано/Когда/Тогда)`
  }
  return undefined
}

function visionCheck(visionConfirmed: boolean): Check {
  return {
    name: 'vision-confirmed',
    ok: visionConfirmed,
    reason: visionConfirmed ? 'vision is confirmed' : 'vision is not confirmed',
  }
}

function toVerdict(checks: Check[]): Verdict {
  return { verdict: checks.every((c) => c.ok) ? 'VERIFY-OK' : 'VERIFY-FAIL', checks }
}

// ---- shared Scope-link integrity helpers (v3, Task 7; exported for Task 8's
// `validate` aggregator, which reuses these WITHOUT duplicating the logic —
// `definitionOfReady`'s own `wp-scope-links`/`wp-scope-version-current`
// checks below are now thin wrappers over the same two functions. ----

/** File-relative Scope href from a WP page to a target page (POSIX). */
export function expectedScopeHref(wpRelPath: string, targetRelPath: string): string {
  return relative(dirname(wpRelPath), targetRelPath).split('\\').join('/')
}

/** `wp-scope-links`: every ref across all four Scope buckets must (a) carry
 * no `parseScope` grammar error, (b) resolve to a real node in the graph,
 * (c) declare a **file-relative** `path` matching {@link expectedScopeHref}
 * from the WP index, and (d) — when a `#anchor` is present — name a heading
 * that actually exists on the target page.
 *
 * `linkRoot` is retained for call-site compatibility but unused for path
 * matching — repo-root `link_root/...` hrefs break under `wp/<id>/`. */
export function scopeLinkIssues(graph: Graph, wpId: string, _linkRoot?: string): string[] {
  const frById = byId(graph.frs)
  const nfrById = byId(graph.nfrs)
  const brById = byId(graph.brs)
  const crById = byId(graph.crs)
  const scope = graph.wpScope(wpId)
  const wpRelPath = graph.pathOf(wpId)

  const issues: string[] = [...scope.errors]
  if (wpRelPath === undefined) {
    throw new Error(
      `scopeLinkIssues: pathOf returned undefined for WP ${wpId} — Graph was built without a paths map`,
    )
  }
  for (const ref of [...scope.crs, ...scope.frs, ...scope.nfrs, ...scope.brs]) {
    const target = crById.get(ref.id) ?? frById.get(ref.id) ?? nfrById.get(ref.id) ?? brById.get(ref.id)
    if (!target) {
      issues.push(`${ref.id}: Scope link does not resolve to any node in the graph`)
      continue
    }
    const targetPath = graph.pathOf(ref.id)
    if (targetPath === undefined) {
      throw new Error(
        `scopeLinkIssues: pathOf returned undefined for resolved node ${ref.id} — Graph was built without a paths map`,
      )
    }
    const expectedPath = expectedScopeHref(wpRelPath, targetPath)
    if (ref.path !== expectedPath) {
      issues.push(`${ref.id}: Scope link path '${ref.path}' does not match expected '${expectedPath}'`)
    }
    if (ref.anchor !== undefined && !pageAnchors(target.body).has(ref.anchor)) {
      issues.push(`${ref.id}: Scope link anchor '#${ref.anchor}' does not exist on the target page`)
    }
  }
  return issues
}

/** `wp-scope-version-current`: a version-stamped Scope link (`[id vN](...)`)
 * must match the target's CURRENT `frontmatter.version`. CR refs never carry
 * a version stamp (crSchema has no `version` field at all) — `parseScope`
 * accepts the `vN` grammar structurally regardless of bucket, so a version
 * on a CR ref is flagged here, not at parse time. */
export function scopeVersionIssues(graph: Graph, wpId: string): string[] {
  const frById = byId(graph.frs)
  const nfrById = byId(graph.nfrs)
  const brById = byId(graph.brs)
  const scope = graph.wpScope(wpId)

  const issues: string[] = []
  for (const ref of scope.crs) {
    if (ref.version !== undefined) issues.push(`${ref.id}: CR refs do not carry version stamps`)
  }
  for (const ref of [...scope.frs, ...scope.nfrs, ...scope.brs]) {
    if (ref.version === undefined) continue
    const target = frById.get(ref.id) ?? nfrById.get(ref.id) ?? brById.get(ref.id)
    if (!target) {
      issues.push(`${ref.id}: cannot verify Scope link version stamp v${ref.version} — target not found`)
    } else if (target.frontmatter.version !== ref.version) {
      issues.push(`${ref.id}: Scope link stamped v${ref.version} but current version is v${target.frontmatter.version}`)
    }
  }
  return issues
}

// ---- definitionOfReady (blocks `wp prepare`) ----

export function definitionOfReady(
  graph: Graph,
  wpId: string,
  visionConfirmed: boolean,
  opts: { linkRoot: string }
): Verdict {
  const frById = byId(graph.frs)
  const nfrById = byId(graph.nfrs)
  const brById = byId(graph.brs)
  const crById = byId(graph.crs)

  const closure = graph.closure(wpId)
  // v3 (Task 7): the WP's raw Scope parse (scopelinks.ts's `parseScope`,
  // memoized on the graph via `wpScope`) — the source both for `closure`'s
  // already-folded FR/NFR/BR id sets above AND for the four link-integrity
  // checks below, which validate the Scope ref OBJECTS themselves (path,
  // anchor, version, id) rather than just the ids `closure` extracts.
  const scope = graph.wpScope(wpId)
  const scopeCrIds = new Set(scope.crs.map((r) => r.id))

  // Members whose OWN outgoing typed refs are in scope for the "no
  // orphan/dangling ref in the closure" check: the WP itself (its own Scope
  // body links, all four buckets, originate `from` the WP id), every FR in
  // the closure (traces_to/enforces/references_nfr originate `from` the FR
  // id), AND every NFR in the closure (its own traces_to originates `from`
  // the NFR id). NFRs are gated like FRs (design spec §6.3: `traces_to` is
  // "required for the orphan/reachability check — NFRs are gated like
  // FRs"), so an NFR's dangling `traces_to` must fail the dangling-ref check
  // just as a FR's does. BRs never declare outgoing typed refs (schema.ts
  // has none for `br`), so including closure.brs here would be a no-op.
  const memberIds = new Set<string>([wpId, ...closure.frs, ...closure.nfrs])

  const inactiveFrs: string[] = []
  const acIssues: string[] = []
  const unscopedTraceFrs: string[] = []
  for (const frId of closure.frs) {
    const fr = frById.get(frId)
    if (!fr) {
      inactiveFrs.push(`${frId}: FR not found`)
      unscopedTraceFrs.push(`${frId}: FR not found`)
    } else {
      if (fr.frontmatter.status !== 'active') inactiveFrs.push(`${frId}: status is '${fr.frontmatter.status}', not active`)
      // v3 (Task 7): a Delivers FR must trace to a CR the WP itself SCOPES
      // (its `### Change requests` bucket) — replaces the old "traces to
      // ANY confirmed CR anywhere in the corpus" form (frs-trace-to-scoped-cr
      // below). The NFR analogue (nfrs-trace-to-confirmed-cr, further down)
      // deliberately KEEPS the old any-confirmed-CR form (spec: NFRs are
      // gated like FRs for reachability, but not re-scoped to the WP here).
      const tracesToScopedCr = fr.frontmatter.traces_to.some((crId) => scopeCrIds.has(crId))
      if (!tracesToScopedCr) unscopedTraceFrs.push(`${frId}: traces_to does not intersect the WP's Scope CR list`)
    }
    const issue = acIssue(frId, fr)
    if (issue) acIssues.push(issue)
  }

  const brIssues: string[] = []
  for (const brId of closure.brs) {
    const br = brById.get(brId)
    if (!br) brIssues.push(`${brId}: BR not found`)
    else if (br.frontmatter.status === 'retired') brIssues.push(`${brId}: BR is retired`)
  }

  const nfrIssues: string[] = []
  const unconfirmedTraceNfrs: string[] = []
  for (const nfrId of closure.nfrs) {
    const nfr = nfrById.get(nfrId)
    if (!nfr) {
      nfrIssues.push(`${nfrId}: NFR not found`)
      unconfirmedTraceNfrs.push(`${nfrId}: NFR not found`)
    } else {
      if (nfr.frontmatter.status !== 'active') nfrIssues.push(`${nfrId}: status is '${nfr.frontmatter.status}', not active`)
      // NFRs are gated like FRs (spec §6.3): the NFR's OWN upward trace must
      // resolve to a confirmed CR. This is distinct from `referenced-nfrs-active`
      // above (the FR→NFR edge) — this is the NFR→CR edge.
      const resolvesToConfirmedCr = nfr.frontmatter.traces_to.some((crId) => crById.get(crId)?.frontmatter.status === 'confirmed')
      if (!resolvesToConfirmedCr) unconfirmedTraceNfrs.push(`${nfrId}: traces_to does not resolve to a confirmed CR`)
    }
  }

  const dangling = graph.danglingRefs().filter((d) => memberIds.has(d.from))

  // v3 (Task 7, refactored Task 8): both checks now go through the shared,
  // exported helpers above — `validate` (cli.ts) reuses the SAME logic
  // corpus-wide rather than a hand-duplicated copy.
  const scopeLinkIssuesList = scopeLinkIssues(graph, wpId, opts.linkRoot)
  const scopeVersionIssuesList = scopeVersionIssues(graph, wpId)

  // v3 (Task 7) — `wp-scope-crs-confirmed`: every CR the WP itself scopes
  // (`### Change requests`) must be `confirmed` — distinct from
  // `frs-trace-to-scoped-cr` above, which only checks id-intersection, not
  // the CR's own status.
  const unconfirmedScopedCrs: string[] = []
  for (const ref of scope.crs) {
    const cr = crById.get(ref.id)
    if (!cr) unconfirmedScopedCrs.push(`${ref.id}: CR not found`)
    else if (cr.frontmatter.status !== 'confirmed') unconfirmedScopedCrs.push(`${ref.id}: status is '${cr.frontmatter.status}', not confirmed`)
  }

  const checks: Check[] = [
    visionCheck(visionConfirmed),
    {
      name: 'frs-active',
      ok: inactiveFrs.length === 0,
      reason: inactiveFrs.length === 0 ? 'every FR in the closure is active' : inactiveFrs.join('; '),
    },
    {
      name: 'frs-well-formed-acs',
      ok: acIssues.length === 0,
      reason: acIssues.length === 0 ? 'every FR in the closure has >=1 well-formed AC' : acIssues.join('; '),
    },
    {
      name: 'frs-trace-to-scoped-cr',
      ok: unscopedTraceFrs.length === 0,
      reason:
        unscopedTraceFrs.length === 0
          ? "every Delivers FR's traces_to intersects the WP's Scope CR list"
          : unscopedTraceFrs.join('; '),
    },
    {
      name: 'enforced-brs-not-retired',
      ok: brIssues.length === 0,
      reason: brIssues.length === 0 ? 'every enforced BR resolves and is not retired' : brIssues.join('; '),
    },
    {
      name: 'referenced-nfrs-active',
      ok: nfrIssues.length === 0,
      reason: nfrIssues.length === 0 ? 'every referenced NFR resolves and is active' : nfrIssues.join('; '),
    },
    {
      name: 'nfrs-trace-to-confirmed-cr',
      ok: unconfirmedTraceNfrs.length === 0,
      reason:
        unconfirmedTraceNfrs.length === 0
          ? 'every NFR in the closure traces_to a confirmed CR'
          : unconfirmedTraceNfrs.join('; '),
    },
    {
      name: 'no-dangling-refs-in-closure',
      ok: dangling.length === 0,
      reason:
        dangling.length === 0
          ? 'no orphan/dangling ref in the closure'
          : dangling.map((d) => `${d.from} -> ${d.to} does not resolve`).join('; '),
    },
    {
      name: 'wp-scope-links',
      ok: scopeLinkIssuesList.length === 0,
      reason:
        scopeLinkIssuesList.length === 0
          ? 'every Scope link parses, resolves, path-matches, and anchor-matches'
          : scopeLinkIssuesList.join('; '),
    },
    {
      name: 'wp-scope-version-current',
      ok: scopeVersionIssuesList.length === 0,
      reason:
        scopeVersionIssuesList.length === 0
          ? "every version-stamped Scope link matches its target's current version"
          : scopeVersionIssuesList.join('; '),
    },
    {
      name: 'wp-scope-crs-confirmed',
      ok: unconfirmedScopedCrs.length === 0,
      reason:
        unconfirmedScopedCrs.length === 0
          ? 'every ### Change requests CR is confirmed'
          : unconfirmedScopedCrs.join('; '),
    },
  ]

  return toVerdict(checks)
}

// ---- acceptGate (blocks `accept`) ----

export function acceptGate(
  graph: Graph,
  wpId: string,
  visionConfirmed: boolean,
  evidence: VerifyEvidence,
  headCommit: string
): Verdict {
  const frById = byId(graph.frs)
  const wpById = byId(graph.wps)
  const wp = wpById.get(wpId)
  const frIds = graph.wpDelivers(wpId)

  // AC-presence: a STRUCTURAL check (every WP FR has >=1 well-formed AC) —
  // explicitly NOT per-AC test coverage, which is out of this gate's scope.
  const acIssues: string[] = []
  for (const frId of frIds) {
    const issue = acIssue(frId, frById.get(frId))
    if (issue) acIssues.push(issue)
  }

  const planApproved = wp?.frontmatter.status === 'plan-approved'
  const commitMatches = evidence.commit === headCommit
  const hashesPresent = evidence.testRunHashes.length > 0

  const checks: Check[] = [
    visionCheck(visionConfirmed),
    {
      name: 'ac-presence',
      ok: acIssues.length === 0,
      reason: acIssues.length === 0 ? 'every WP FR has >=1 well-formed AC' : acIssues.join('; '),
    },
    {
      name: 'wp-plan-approved',
      ok: planApproved,
      reason:
        wp === undefined
          ? `${wpId}: WP not found`
          : planApproved
            ? `${wpId} is plan-approved`
            : `${wpId}: status is '${wp.frontmatter.status}', not plan-approved`,
    },
    {
      name: 'evidence-commit-matches-head',
      ok: commitMatches,
      reason: commitMatches
        ? 'evidence.commit matches HEAD'
        : `evidence.commit (${evidence.commit}) !== headCommit (${headCommit})`,
    },
    {
      name: 'evidence-test-run-hashes-present',
      ok: hashesPresent,
      reason: hashesPresent ? 'evidence.testRunHashes is present' : `${wpId}: evidence.testRunHashes is empty`,
    },
  ]

  return toVerdict(checks)
}
