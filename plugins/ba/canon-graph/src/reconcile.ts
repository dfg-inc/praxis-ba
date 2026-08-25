// ---- reconcile.ts: CR auto-resolve (design spec §8a, v3 impact-based —
// Task 6; provenance-gated backfill relaxation — Task 9b) ----
//
// v3: a CR's resolution predicate is no longer "the derived reverse-walked
// spawned-set (graph.ts's `crSpawned`) is fully baselined" — it's built off
// the CR's OWN typed `impacts` set (schema.ts's `CrImpact`, Task 1). A CR
// with an EMPTY (or absent) `impacts` array is left alone — the v2
// "resolving a CR nothing traces to is not the intent" posture, now
// expressed as "no declared impact" rather than "no reverse-walked spawned
// FR/NFR" (`crSpawned` itself is untouched by this task; this module simply
// no longer reads it). A non-empty `impacts` set resolves once EVERY entry
// is provably delivered:
//   - `{ amends: reqId }` — `reqId` resolves to a real FR/NFR/BR and its
//     status is `baselined`. For a LIVE (non-`backfilled`) CR, its own
//     `## History` must additionally cite this CR (`history.ts`'s
//     `historyCrRefs`) — proof the amendment actually landed, not just that
//     the target happens to be baselined for some other reason.
//   - `{ spawns, epic, realized? }` — `realized` must already be stamped (by
//     `writer.ts`'s `realizeCrSpawn`, never re-derived from `traces_to`
//     here) to a real FR/NFR/BR that is itself `baselined`. For a LIVE
//     (non-`backfilled`) CR, that target's `traces_to` must additionally
//     include this CR (for a FR/NFR only — a BR spawn has no `traces_to`
//     field to check), proving the trace-back exists before the CR's own
//     record of realization is trusted.
//   - A CR with `provenance: 'backfilled'` (schema.ts — set only by the
//     v2->v3 migration's backfill map, Task 10, for CRs whose impact set was
//     factually reconstructed with no confident source to derive a History
//     citation or a `traces_to` addition from) SKIPS the History-citation /
//     traces_to-inclusion half of each rule above — by explicit design the
//     migration never fabricates either. Without this, a backfilled CR's
//     `impacts` could NEVER be judged delivered and it would stay
//     `confirmed` forever, defeating the migration's "auto-resolve on the
//     final reconcile" goal. The `baselined`-status requirement is NOT
//     skipped — that's the one piece of evidence the migration doesn't need
//     to fabricate (a target's current status is read live, not backfilled).
//
// Called ONLY by the accept transaction (writer.ts's `accept`, via a dynamic
// `import()` — see that file's own `accept` doc comment for why: this module
// statically imports writer.ts's `atomicWrite`/`crPath`/`loadGraph`, so a
// static top-level import in the other direction would create a writer.ts
// <-> reconcile.ts cycle; `accept` instead resolves this module lazily,
// inside its own function body, which is safe because nothing here is
// touched until well after both modules have finished evaluating). Never
// called by a routine `req`/`cr` edit.
//
// Reloads the corpus fresh via `loadGraph`: the `Graph` `accept` built
// earlier is stale by the time this runs — `accept` has already written the
// delivered items' new status/baseline to disk before handing off here.
// Writes route through writer.ts's `atomicWrite`/`crPath` — this file
// performs no write of its own construction, keeping writer.ts the sole
// place any byte reaches a canon page (per that file's header comment).

import { historyCrRefs } from './history.js'
import { emitPage } from './serialize.js'
import type { FrontmatterFor, Graph, GraphNode } from './graph.js'
import type { CrImpact } from './schema.js'
import { atomicWrite, crPath, loadGraph } from './writer.js'

const DATE_KEY = /^\d{8}$/

// A `nodeOf` lookup target — whichever of the three requirement types an
// impact's `amends`/`realized` id resolves to. `.frontmatter.status` is
// common to all three; `.frontmatter.traces_to` is NOT (a BR has none),
// which is exactly the fact the spawn branch below narrows on via `in`.
export type RequirementNode = GraphNode<'fr'> | GraphNode<'nfr'> | GraphNode<'br'>

/** Builds the `nodeOf` lookup this module's predicate needs from a `Graph`'s
 * (or graph-shaped) fr/nfr/br node lists — exported (Task 8) so `validate`
 * (cli.ts) can build the SAME index once for its own corpus-wide
 * `cr-impacts-consistent` check rather than re-deriving the fr/nfr/br `Map`s
 * itself. */
export function requirementNodeIndex(
  graph: Pick<Graph, 'frs' | 'nfrs' | 'brs'>
): (id: string) => RequirementNode | undefined {
  const frById = new Map(graph.frs.map((fr) => [fr.frontmatter.id, fr] as const))
  const nfrById = new Map(graph.nfrs.map((nfr) => [nfr.frontmatter.id, nfr] as const))
  const brById = new Map(graph.brs.map((br) => [br.frontmatter.id, br] as const))
  return (id: string): RequirementNode | undefined => frById.get(id) ?? nfrById.get(id) ?? brById.get(id)
}

/** The CR resolution predicate itself (file header): every impact of `crId`
 * is provably delivered against `nodeOf` (built by `requirementNodeIndex`
 * above). Exported (Task 8) so `validate`'s `cr-impacts-consistent` check can
 * assert a `resolved` CR actually satisfies this — the SAME rule
 * `reconcileCrs` uses to flip a CR to `resolved` in the first place, not a
 * hand-duplicated copy that could drift from it. Vacuously `true` on an empty
 * `impacts` array — callers that mean "nothing declared, nothing to
 * resolve" (this module's own `reconcileCrs`) check `impacts.length === 0`
 * themselves before calling this, exactly as before.
 *
 * `backfilled` (Task 9b) — pass `cr.frontmatter.provenance === 'backfilled'`
 * — SKIPS the evidentiary half of each rule (the amends branch's
 * History-citation check, the spawn branch's traces_to-inclusion check) that
 * a migration-reconstructed CR can never satisfy by design (file header).
 * The `baselined`-status check is never skipped, for either branch: it's
 * read live off the target, not something the migration would have had to
 * fabricate. */
export function crImpactsDelivered(
  nodeOf: (id: string) => RequirementNode | undefined,
  crId: string,
  impacts: readonly CrImpact[],
  backfilled: boolean
): boolean {
  return impacts.every((impact) => {
    if ('amends' in impact) {
      const node = nodeOf(impact.amends)
      if (node === undefined || node.frontmatter.status !== 'baselined') return false
      return backfilled || historyCrRefs(node.body).includes(crId)
    }
    if (impact.realized === undefined) return false
    const node = nodeOf(impact.realized)
    if (node === undefined || node.frontmatter.status !== 'baselined') return false
    if (backfilled) return true
    const traces = 'traces_to' in node.frontmatter ? node.frontmatter.traces_to : undefined
    return traces === undefined || traces.includes(crId) // BR spawns carry no traces_to
  })
}

/**
 * Resolves each `crId` in `affectedCrIds` whose OWN typed `impacts` set
 * (schema.ts's `CrImpact`) is non-empty and every entry of which is
 * provably delivered (see file header for the full amends/spawns
 * predicate).
 *
 * A CR with an EMPTY (or absent) `impacts` array is left alone — v3's
 * "nothing declared, nothing to resolve" posture (never vacuously true off
 * an empty set). Already-`resolved` CRs and a `crId` that doesn't resolve to
 * a real page are no-ops too (idempotent — safe to call again with the same
 * ids, e.g. from `accept`'s own crash-resume path).
 *
 * `date` (YYYYMMDD) is validated for shape here but not currently persisted
 * anywhere — `schema.ts`'s CR frontmatter has no `resolved_at`-style field
 * today. It's part of the pinned interface (mirroring every other
 * date-taking function in this package's determinism convention: never read
 * the clock) so a future audit-stamp can be added without a signature
 * change.
 */
export function reconcileCrs(repo: string, affectedCrIds: readonly string[], date: string): void {
  if (!DATE_KEY.test(date)) throw new Error(`reconcile: date must be YYYYMMDD, got ${JSON.stringify(date)}`)
  if (affectedCrIds.length === 0) return

  const graph = loadGraph(repo)
  const crById = new Map(graph.crs.map((cr) => [cr.frontmatter.id, cr] as const))
  const nodeOf = requirementNodeIndex(graph)

  for (const crId of affectedCrIds) {
    const cr = crById.get(crId)
    if (!cr || cr.frontmatter.status === 'resolved') continue
    const impacts = cr.frontmatter.impacts ?? []
    if (impacts.length === 0) continue
    if (!crImpactsDelivered(nodeOf, crId, impacts, cr.frontmatter.provenance === 'backfilled')) continue

    const nextFm = { ...cr.frontmatter, status: 'resolved' as const }
    atomicWrite(crPath(repo, crId), emitPage('cr', nextFm as unknown as FrontmatterFor<'cr'>, cr.body))
  }
}
