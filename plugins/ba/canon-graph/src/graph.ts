// ---- graph.ts: the typed RTM graph (design spec §4.1 `graph`) — backlinks,
// orphans, dangling refs, WP closure, FR→CR reachability, and the derived
// CR-spawned-set, all computed from a page corpus's *forward* typed refs.
//
// Q4 invariant this whole module rests on: backlinks/spawned-sets are never
// read from a stored field — they are reverse-walked from the forward refs
// every page already declares (`traces_to`, `enforces`, `references_nfr` on
// FR; `traces_to` on NFR; a WP's `## Scope` body links, Task 3/4). Pure — no
// IO; callers parse pages (parse.ts) and pass the result in.
//
// v3 (Task 4): a WP's FR/NFR/BR scope no longer lives in frontmatter
// (`fr_ids`/`extra_brs`/`extra_nfrs`, retired by schema.ts's wpSchema
// slim-down) — it lives in the page BODY's machine-readable `## Scope`
// section, parsed once per WP via scopelinks.ts's `parseScope` and exposed
// both as the raw `wpScope`/`wpDelivers` queries and folded into `closure`
// exactly as the old frontmatter fields were. `crImpacts`/`crAmendRealized`
// are new CR-side queries: a CR's typed `impacts` set (schema.ts's
// `CrImpact`, Task 1) and whether a given impact has actually been
// "realized" — the target requirement exists AND its own `## History`
// records this CR (history.ts's `historyCrRefs`, Task 2).
//
// Scope note: `related` (FR/NFR), `verified_by` (NFR) and `affects` (BUG) are
// deliberately excluded from the edge set this module resolves — schema.ts
// (Task 2) leaves them as untyped `z.array(z.string())`, not constrained to
// any single id-namespace by regex, so they are informational free-form
// mentions rather than a strict dependency edge a "dangling ref" check could
// meaningfully validate. Only the FR/NFR typed-ref fields plus a WP's Scope
// links make up the "typed refs" this graph resolves.

import type { z } from 'zod'
import { naturalCompare } from './serialize.js'
import { parseScope, type ParsedScope } from './scopelinks.js'
import { historyCrRefs } from './history.js'
import type {
  visionSchema,
  frSchema,
  nfrSchema,
  brSchema,
  crSchema,
  wpSchema,
  bugSchema,
  epicSchema,
  goalSchema,
  CrImpact,
} from './schema.js'
import type { ParsedPage } from './parse.js'
import type { NodeType } from './types.js'

// ---- per-node-type frontmatter shape, inferred from the already-committed
// zod schemas (schema.ts). This is the single canonical mapping — serialize.ts
// imports it from here (see that file's header comment for the Task 6
// reconciliation note) rather than keeping its own parallel copy. ----
export type FrontmatterFor<T extends NodeType> = T extends 'vision'
  ? z.infer<typeof visionSchema>
  : T extends 'fr'
    ? z.infer<typeof frSchema>
    : T extends 'nfr'
      ? z.infer<typeof nfrSchema>
      : T extends 'br'
        ? z.infer<typeof brSchema>
        : T extends 'cr'
          ? z.infer<typeof crSchema>
          : T extends 'wp'
            ? z.infer<typeof wpSchema>
            : T extends 'bug'
              ? z.infer<typeof bugSchema>
              : T extends 'epic'
                ? z.infer<typeof epicSchema>
                : T extends 'goal'
                  ? z.infer<typeof goalSchema>
                  : never

export type GraphNode<T extends NodeType> = { frontmatter: FrontmatterFor<T>; body: string }

export type DanglingRef = { from: string; to: string }
export type Closure = { frs: string[]; nfrs: string[]; brs: string[] }

export type Graph = {
  readonly epics: readonly GraphNode<'epic'>[]
  readonly frs: readonly GraphNode<'fr'>[]
  readonly nfrs: readonly GraphNode<'nfr'>[]
  readonly brs: readonly GraphNode<'br'>[]
  readonly crs: readonly GraphNode<'cr'>[]
  readonly wps: readonly GraphNode<'wp'>[]
  readonly bugs: readonly GraphNode<'bug'>[]
  readonly goals: readonly GraphNode<'goal'>[]
  /** Every id that points AT `id` via a typed ref, reverse-walked (never stored), naturally sorted. */
  backlinks(id: string): string[]
  /** FR ids with an empty `traces_to`, naturally sorted. */
  orphans(): string[]
  /** Every typed-ref edge whose target id doesn't resolve to a real node, sorted by (from, to). */
  danglingRefs(): DanglingRef[]
  /** A WP's delivered-set closure: its Scope `### Delivers` FR ids + those FRs'
   * `enforces`/`references_nfr` + its own Scope `### Constraints` NFR/BR ids. */
  closure(wpId: string): Closure
  /** A CR's spawned-set, derived by reverse-walking every FR/NFR's `traces_to` — never a stored field. */
  crSpawned(crId: string): string[]
  /** Whether a FR's `traces_to` resolves to at least one CR that actually exists in this graph. */
  frReachesCr(frId: string): boolean
  /** The CANON-RELATIVE path (e.g. `cr/CR-015.md`) a node's id was loaded from,
   * when `buildGraph`'s caller supplied a `paths` map — `undefined` otherwise
   * (including for any id `paths` didn't cover). */
  pathOf(id: string): string | undefined
  /** The memoized parse of a WP's body `## Scope` section (scopelinks.ts's
   * `parseScope`) — an empty `ParsedScope` carrying an error is returned for
   * an unknown `wpId`, never a throw. */
  wpScope(wpId: string): ParsedScope
  /** A WP's Scope `### Delivers` FR ids, natural-sorted — replaces every old
   * `wp.frontmatter.fr_ids` read (v3, Task 4). */
  wpDelivers(wpId: string): string[]
  /** A CR's typed impact set (schema.ts's `CrImpact`, Task 1) — `cr.frontmatter.impacts ?? []`. */
  crImpacts(crId: string): CrImpact[]
  /** Whether `reqId` (a FR/NFR/BR) both exists in this graph, is `baselined`,
   * AND its own `## History` records an entry citing `crId` (history.ts's
   * `historyCrRefs`, depth-relaxed so a demoted/nested citation from an
   * earlier bump still counts — finding #3/#6) — mirrors `reconcile.ts`'s
   * OWN `amends`-impact delivered rule (`crImpactsDelivered`) exactly, so
   * this query and that predicate never drift apart (finding #24). */
  crAmendRealized(crId: string, reqId: string): boolean
  /** Requirement ids (FR/NFR/BR) that declare `goalId` in `goal_ids` — reverse-
   * walked, never stored on the goal page (WBS 1.11). */
  goalRequirements(goalId: string): string[]
}

const NODE_TYPES: ReadonlySet<string> = new Set<NodeType>([
  'vision',
  'fr',
  'nfr',
  'br',
  'cr',
  'wp',
  'bug',
  'epic',
  'goal',
])

// Recovers the NodeType discriminant from an already-validated (but
// statically `unknown`) frontmatter value — every schema in schema.ts
// requires a `type: z.literal(...)` field, so this is always present on a
// page that passed `parsePage`. Anything else (malformed input, or `vision`
// pages which carry no `id`) is simply not part of the id-indexed graph.
function nodeTypeOf(fm: unknown): NodeType | undefined {
  if (typeof fm !== 'object' || fm === null || !('type' in fm)) return undefined
  const t = (fm as { type: unknown }).type
  return typeof t === 'string' && NODE_TYPES.has(t) ? (t as NodeType) : undefined
}

function idOf(fm: unknown): string | undefined {
  if (typeof fm !== 'object' || fm === null || !('id' in fm)) return undefined
  const id = (fm as { id: unknown }).id
  return typeof id === 'string' ? id : undefined
}

export function buildGraph(pages: ParsedPage[], paths?: ReadonlyMap<ParsedPage, string>): Graph {
  const epics: GraphNode<'epic'>[] = []
  const frs: GraphNode<'fr'>[] = []
  const nfrs: GraphNode<'nfr'>[] = []
  const brs: GraphNode<'br'>[] = []
  const crs: GraphNode<'cr'>[] = []
  const wps: GraphNode<'wp'>[] = []
  const bugs: GraphNode<'bug'>[] = []
  const goals: GraphNode<'goal'>[] = []
  // Task 4: id -> its CANON-RELATIVE path, populated only when the caller
  // supplies `paths` (`writer.ts`'s `loadGraph` always does; a hand-built
  // test corpus may omit it entirely, in which case `pathOf` resolves
  // nothing for anyone — no silent partial population from a mixed corpus).
  const pathIndex = new Map<string, string>()

  for (const page of pages) {
    const type = nodeTypeOf(page.frontmatter)
    switch (type) {
      case 'epic':
        epics.push({ frontmatter: page.frontmatter as FrontmatterFor<'epic'>, body: page.body })
        break
      case 'fr':
        frs.push({ frontmatter: page.frontmatter as FrontmatterFor<'fr'>, body: page.body })
        break
      case 'nfr':
        nfrs.push({ frontmatter: page.frontmatter as FrontmatterFor<'nfr'>, body: page.body })
        break
      case 'br':
        brs.push({ frontmatter: page.frontmatter as FrontmatterFor<'br'>, body: page.body })
        break
      case 'cr':
        crs.push({ frontmatter: page.frontmatter as FrontmatterFor<'cr'>, body: page.body })
        break
      case 'wp':
        wps.push({ frontmatter: page.frontmatter as FrontmatterFor<'wp'>, body: page.body })
        break
      case 'bug':
        bugs.push({ frontmatter: page.frontmatter as FrontmatterFor<'bug'>, body: page.body })
        break
      case 'goal':
        goals.push({ frontmatter: page.frontmatter as FrontmatterFor<'goal'>, body: page.body })
        break
      default:
        // 'vision' (no id) or an unrecognized/malformed frontmatter shape:
        // not part of the id-indexed graph.
        break
    }
    if (type !== undefined && paths) {
      const path = paths.get(page)
      const id = idOf(page.frontmatter)
      if (path !== undefined && id !== undefined) pathIndex.set(id, path)
    }
  }

  // ---- id existence index (every id-bearing node type) ----
  const idIndex = new Set<string>()
  for (const n of epics) idIndex.add(n.frontmatter.id)
  for (const n of frs) idIndex.add(n.frontmatter.id)
  for (const n of nfrs) idIndex.add(n.frontmatter.id)
  for (const n of brs) idIndex.add(n.frontmatter.id)
  for (const n of crs) idIndex.add(n.frontmatter.id)
  for (const n of wps) idIndex.add(n.frontmatter.id)
  for (const n of bugs) idIndex.add(n.frontmatter.id)
  for (const n of goals) idIndex.add(n.frontmatter.id)

  // ---- forward edges: the core typed-ref graph (see file header for the
  // scope note on why `related`/`verified_by`/`affects` are excluded) ----
  const edges: DanglingRef[] = []
  for (const fr of frs) {
    for (const to of fr.frontmatter.traces_to) edges.push({ from: fr.frontmatter.id, to })
    for (const to of fr.frontmatter.enforces) edges.push({ from: fr.frontmatter.id, to })
    for (const to of fr.frontmatter.references_nfr) edges.push({ from: fr.frontmatter.id, to })
    for (const to of fr.frontmatter.goal_ids ?? []) edges.push({ from: fr.frontmatter.id, to })
  }
  for (const nfr of nfrs) {
    for (const to of nfr.frontmatter.traces_to) edges.push({ from: nfr.frontmatter.id, to })
    for (const to of nfr.frontmatter.goal_ids ?? []) edges.push({ from: nfr.frontmatter.id, to })
  }
  for (const br of brs) {
    for (const to of br.frontmatter.goal_ids ?? []) edges.push({ from: br.frontmatter.id, to })
  }
  // v3 (Task 4): a WP's forward edges come from its body's `## Scope` links
  // (all four buckets), NOT frontmatter — `fr_ids`/`extra_brs`/`extra_nfrs`
  // no longer exist on wpSchema at all. Parsed once here and memoized.
  const scopeByWp = new Map<string, ParsedScope>()
  for (const wp of wps) {
    const scope = parseScope(wp.body)
    scopeByWp.set(wp.frontmatter.id, scope)
    for (const ref of [...scope.crs, ...scope.frs, ...scope.nfrs, ...scope.brs]) {
      edges.push({ from: wp.frontmatter.id, to: ref.id })
    }
  }

  // ---- reverse index — DERIVED from the forward edges above, never a
  // stored field (Q4). This is the whole of `backlinks`'s implementation. ----
  const reverse = new Map<string, string[]>()
  for (const { from, to } of edges) {
    const existing = reverse.get(to)
    if (existing) existing.push(from)
    else reverse.set(to, [from])
  }

  const frById = new Map(frs.map((fr) => [fr.frontmatter.id, fr] as const))
  const nfrById = new Map(nfrs.map((nfr) => [nfr.frontmatter.id, nfr] as const))
  const brById = new Map(brs.map((br) => [br.frontmatter.id, br] as const))
  const crById = new Map(crs.map((cr) => [cr.frontmatter.id, cr] as const))
  const wpById = new Map(wps.map((wp) => [wp.frontmatter.id, wp] as const))

  function wpScope(wpId: string): ParsedScope {
    return scopeByWp.get(wpId) ?? { crs: [], frs: [], nfrs: [], brs: [], errors: [`wpScope: unknown WP id '${wpId}'`] }
  }

  return {
    epics,
    frs,
    nfrs,
    brs,
    crs,
    wps,
    bugs,
    goals,

    backlinks(id: string): string[] {
      const sources = reverse.get(id) ?? []
      return [...new Set(sources)].sort(naturalCompare)
    },

    orphans(): string[] {
      return frs
        .filter((fr) => fr.frontmatter.traces_to.length === 0)
        .map((fr) => fr.frontmatter.id)
        .sort(naturalCompare)
    },

    danglingRefs(): DanglingRef[] {
      return edges
        .filter(({ to }) => {
          if (idIndex.has(to)) return false
          // Project-catalogue NFR ids are not graph nodes.
          if (/^[A-Z][A-Z0-9]{1,9}-NFR-\d{3}$/.test(to) && !/^E\d+-NFR\d+$/.test(to)) {
            return false
          }
          return true
        })
        .sort((a, b) => naturalCompare(a.from, b.from) || naturalCompare(a.to, b.to))
    },

    closure(wpId: string): Closure {
      const wp = wpById.get(wpId)
      if (!wp) return { frs: [], nfrs: [], brs: [] }

      const scope = scopeByWp.get(wpId)! // populated 1:1 with `wps` above
      const nfrSet = new Set<string>(scope.nfrs.map((r) => r.id))
      const brSet = new Set<string>(scope.brs.map((r) => r.id))
      const frIds = scope.frs.map((r) => r.id)
      for (const frId of frIds) {
        const fr = frById.get(frId)
        if (!fr) continue // a dangling Delivers ref: no enforces/references_nfr to fold in
        for (const br of fr.frontmatter.enforces) brSet.add(br)
        for (const nfr of fr.frontmatter.references_nfr) {
          // Only canon NFR nodes participate in closure status checks.
          if (/^E\d+-NFR\d+$/.test(nfr)) nfrSet.add(nfr)
        }
      }
      return {
        // Deliberately NOT deduped (matches the pre-v3 `fr_ids` behavior) —
        // writer.ts's `accept()` relies on collapsing duplicates itself via
        // its own `Set`, not on this method doing so.
        frs: [...frIds].sort(naturalCompare),
        nfrs: [...nfrSet].sort(naturalCompare),
        brs: [...brSet].sort(naturalCompare),
      }
    },

    crSpawned(crId: string): string[] {
      const ids: string[] = []
      for (const fr of frs) if (fr.frontmatter.traces_to.includes(crId)) ids.push(fr.frontmatter.id)
      for (const nfr of nfrs) if (nfr.frontmatter.traces_to.includes(crId)) ids.push(nfr.frontmatter.id)
      return [...new Set(ids)].sort(naturalCompare)
    },

    frReachesCr(frId: string): boolean {
      const fr = frById.get(frId)
      if (!fr) return false
      return fr.frontmatter.traces_to.some((cr) => idIndex.has(cr))
    },

    pathOf(id: string): string | undefined {
      return pathIndex.get(id)
    },

    wpScope,

    wpDelivers(wpId: string): string[] {
      return wpScope(wpId).frs.map((r) => r.id).sort(naturalCompare)
    },

    crImpacts(crId: string): CrImpact[] {
      return crById.get(crId)?.frontmatter.impacts ?? []
    },

    crAmendRealized(crId: string, reqId: string): boolean {
      const target = frById.get(reqId) ?? nfrById.get(reqId) ?? brById.get(reqId)
      if (!target || target.frontmatter.status !== 'baselined') return false
      return historyCrRefs(target.body).includes(crId)
    },

    goalRequirements(goalId: string): string[] {
      const ids: string[] = []
      for (const fr of frs) if ((fr.frontmatter.goal_ids ?? []).includes(goalId)) ids.push(fr.frontmatter.id)
      for (const nfr of nfrs) if ((nfr.frontmatter.goal_ids ?? []).includes(goalId)) ids.push(nfr.frontmatter.id)
      for (const br of brs) if ((br.frontmatter.goal_ids ?? []).includes(goalId)) ids.push(br.frontmatter.id)
      return [...new Set(ids)].sort(naturalCompare)
    },
  }
}
