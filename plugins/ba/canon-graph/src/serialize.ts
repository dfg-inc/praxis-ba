// ---- serialize: byte-stable frontmatter codec (design spec §serialize, §9)
// + derived-view exporters (PRD / RTM / Backlog).
//
// The write-side counterpart to parse.ts's read path. `emitPage` never reads
// `Date.now()`/RNG — every date/id is a value the caller passes in — and its
// output is byte-for-byte reproducible for the same (type, frontmatter,
// body) triple: a fixed per-node-type key order, eemeli `yaml`'s `stringify`
// under a pinned profile (`lineWidth: 0`, no anchors/aliases), ref-id arrays
// sorted by a shared numeric-aware natural comparator, LF line endings,
// UTF-8. The body is opaque: appended verbatim after the closing frontmatter
// fence, exactly as `parsePage` would hand it back — never re-parsed, never
// re-flowed, and (deliberately) never trailing-newline-normalized. That
// normalization, if wanted, is a canon-write-layer concern (Task 6+), not
// this codec's: "verbatim" is the whole of the body's contract here.

import { stringify } from 'yaml'
import type { NodeType } from './types.js'
// Task 6 reconciliation: `FrontmatterFor`/`GraphNode` are now canonically
// defined in graph.ts (derived straight from schema.ts's zod schemas) since
// the real `Graph` type needs them too — re-exported here (not redefined) so
// this module and every existing import site (incl. this file's own tests)
// keep resolving `FrontmatterFor`/`GraphNode` from '../src/serialize'.
import type { Graph, GraphNode, FrontmatterFor } from './graph.js'
export type { GraphNode, FrontmatterFor } from './graph.js'

// ---- the natural comparator (shared util — Task 6's graph module reuses it
// for ref-array sorting and any other id-ordering need, per the brief) ----
//
// Splits each string into alternating runs of digits / non-digits and
// compares run-by-run: numeric runs compare by numeric value (so "9" < "10"
// even though '1' < '9' as characters), everything else compares
// lexicographically. This is what makes `E1-FR10` sort after `E1-FR9`
// instead of before it — a plain string compare gets that backwards.
const RUN = /(\d+|\D+)/g
const ALL_DIGITS = /^\d+$/

export function naturalCompare(a: string, b: string): number {
  const aRuns = a.match(RUN) ?? [a]
  const bRuns = b.match(RUN) ?? [b]
  const len = Math.max(aRuns.length, bRuns.length)
  for (let i = 0; i < len; i++) {
    const aRun = aRuns[i]
    const bRun = bRuns[i]
    if (aRun === undefined) return -1
    if (bRun === undefined) return 1
    if (aRun === bRun) continue
    const aIsNum = ALL_DIGITS.test(aRun)
    const bIsNum = ALL_DIGITS.test(bRun)
    if (aIsNum && bIsNum) {
      const diff = Number(aRun) - Number(bRun)
      if (diff !== 0) return diff < 0 ? -1 : 1
      // Equal numeric value with `aRun !== bRun` (checked above) can only
      // mean different zero-padding width (e.g. "01" vs "1" both = 1) — a
      // same-length, same-value digit string is unique, so equal length here
      // would already have matched `aRun === bRun` and looped via `continue`
      // above. Prefer the less-padded (shorter) one for a total, stable order.
      return aRun.length < bRun.length ? -1 : 1
    }
    return aRun < bRun ? -1 : 1
  }
  return 0
}

function sortRefs(values: readonly string[]): string[] {
  return [...values].sort(naturalCompare)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

// ---- per-node-type key-order tables ("explicit per-doc-type key order",
// design spec §serialize) — mirrors the field declaration order of each zod
// schema in schema.ts field-for-field, so the emitted key order always
// matches the order a reader of schema.ts already expects.
//
// Exported so a drift-guard test (serialize.test.ts) can cross-check this
// table against `schema.ts`'s actual per-type field set — these two tables
// are hand-maintained parallel to the schemas, so the guard fails loudly if a
// schema field is ever added/removed without updating them here. ----
export const KEY_ORDER: Record<NodeType, readonly string[]> = {
  vision: ['type', 'status', 'confirmed_at', 'confirmed_by'],
  fr: [
    'id',
    'type',
    'epic',
    'status',
    'version',
    'traces_to',
    'enforces',
    'references_nfr',
    'related',
    'goal_ids',
    'baseline',
    'supersedes',
    'superseded_by',
    'provenance',
  ],
  nfr: [
    'id',
    'type',
    'epic',
    'status',
    'version',
    'traces_to',
    'verified_by',
    'related',
    'goal_ids',
    'baseline',
    'supersedes',
    'superseded_by',
    'provenance',
  ],
  br: [
    'id',
    'type',
    'epic',
    'kind',
    'enforcement',
    'status',
    'version',
    'goal_ids',
    'baseline',
    'supersedes',
    'superseded_by',
    'provenance',
  ],
  cr: ['id', 'type', 'status', 'entry_point', 'entry_point_confirmed', 'impacts', 'provenance', 'spawned_from_bug'],
  wp: ['id', 'type', 'role', 'status', 'plan'],
  bug: ['id', 'type', 'status', 'severity', 'affects', 'reported', 'reporter', 'spawned_cr'],
  epic: ['id', 'type', 'title', 'status'],
  goal: ['id', 'type', 'title', 'status'],
}

// ---- which of a type's keys hold ref-id arrays that get natural-sorted on
// emit (design spec §serialize / §6 sort comparator). Every array-typed
// field across every schema in schema.ts is listed here — see the Task 5
// report for the full per-type table and why that matters for aliasing.
//
// Exported (like KEY_ORDER above) so the drift-guard test can assert that
// EVERY array-typed field in each zod schema's shape is registered here — a
// future schema array field that forgets to appear would otherwise emit
// unsorted, silently. ----
export const REF_ARRAY_KEYS: Record<NodeType, readonly string[]> = {
  vision: [],
  fr: ['traces_to', 'enforces', 'references_nfr', 'related', 'goal_ids'],
  nfr: ['traces_to', 'verified_by', 'related', 'goal_ids'],
  br: ['goal_ids'],
  cr: [],
  wp: [],
  bug: ['affects'],
  epic: [],
  goal: [],
}

// ---- the fixed eemeli `stringify` profile: no line folding (`lineWidth:
// 0`) and no anchors/aliases for repeated object references — belt-and-
// suspenders per the design spec's "no anchors/aliases" clause, even though
// every ref-array field is freshly cloned by `sortRefs` before it ever
// reaches `stringify`, so object-identity aliasing can't occur through this
// function's own construction path today. ----
const STRINGIFY_OPTIONS = { lineWidth: 0, aliasDuplicateObjects: false } as const

// `FrontmatterFor` — per-type frontmatter shape, inferred from the already-
// committed zod schemas (schema.ts) — `emitPage`'s frontmatter argument is
// exactly as strict, for every NodeType, as `validateFrontmatter`'s accepted
// input. (Now defined in graph.ts and re-exported above — see this file's
// Task 6 reconciliation note at the top.)

export function emitPage<T extends NodeType>(type: T, frontmatter: FrontmatterFor<T>, body: string): string {
  // Widen the generic, schema-shaped input to a plain indexable record before
  // touching any of our own logic — the same boundary-widening parse.ts uses
  // for gray-matter's `data`. No `any` involved: this is `unknown`, narrowed
  // key-by-key below via the explicit key-order table.
  const fm = frontmatter as unknown as Record<string, unknown>
  const refKeys = REF_ARRAY_KEYS[type]
  const ordered: Record<string, unknown> = {}
  for (const key of KEY_ORDER[type]) {
    if (!(key in fm)) continue
    const value = fm[key]
    // Drop keys that are present-but-empty (`undefined` OR `null`): an optional
    // field carrying either must be omitted entirely, never emitted as an
    // explicit `key: null`.
    if (value === undefined || value === null) continue
    ordered[key] = refKeys.includes(key) && isStringArray(value) ? sortRefs(value) : value
  }
  const yamlBlock: string = stringify(ordered, STRINGIFY_OPTIONS)
  return `---\n${yamlBlock}---\n${normalizeTrailingNewline(body)}`
}

// ---- the "single trailing newline" half of the determinism contract. The
// body's internal CONTENT is byte-verbatim (opaque) — everything up to the
// trailing newline run passes through untouched — but the TRAILING newline(s)
// are canonicalized to exactly one LF: a body with none gains one, a body with
// several collapses to one. An all-whitespace/empty body contributes no body
// text at all (the frontmatter block's own closing `---\n` is then the single
// trailing newline), so we never emit a stray blank line after the fence. ----
function normalizeTrailingNewline(body: string): string {
  const content = body.replace(/\n+$/, '')
  return content === '' ? '' : `${content}\n`
}

// ---- derived-view exporters ----
//
// `exportPrd` runs over `ExportGraph`: flat, per-type arrays of already-
// parsed pages — the exact `{ frontmatter, body }` shape `parsePage` hands
// back (see parse.ts's `ParsedPage`) — the smallest structural slice that
// view actually needs; `ExportGraph` is a structural `Pick` of `Graph` (Task
// 6's reconciliation) rather than a parallel hand-maintained shape.
// `exportRtm`/`exportBacklog` (Task 4, v3) instead take a full `Graph`: a
// WP's delivered-FR set is no longer a plain array field on its frontmatter
// (`fr_ids` moved into the body's `## Scope` section, Task 3's
// `scopelinks.ts`) — reading it needs the `wpDelivers` QUERY METHOD, which
// only a real `Graph` (not the data-only `ExportGraph` slice) carries. The
// real output of `buildGraph(pages)` passes straight into all three
// exporters unchanged either way (a `Graph` value has every field
// `ExportGraph` needs, plus more; excess-property checks only apply to
// object literals, not to passing an existing variable through).
export type ExportGraph = Pick<Graph, 'epics' | 'frs' | 'nfrs' | 'brs' | 'crs' | 'wps' | 'bugs'>

function byNaturalId<T extends { frontmatter: { id: string } }>(nodes: readonly T[]): T[] {
  return [...nodes].sort((a, b) => naturalCompare(a.frontmatter.id, b.frontmatter.id))
}

export function exportPrd(graph: ExportGraph): string {
  const lines: string[] = ['# PRD', '']
  for (const epic of byNaturalId(graph.epics)) {
    lines.push(`## ${epic.frontmatter.id} — ${epic.frontmatter.title}`, '')
    const epicFrs = byNaturalId(graph.frs.filter((fr) => fr.frontmatter.epic === epic.frontmatter.id))
    for (const fr of epicFrs) {
      lines.push(`### ${fr.frontmatter.id} (${fr.frontmatter.status})`, '', fr.body.trim(), '')
    }
    const epicNfrs = byNaturalId(graph.nfrs.filter((nfr) => nfr.frontmatter.epic === epic.frontmatter.id))
    for (const nfr of epicNfrs) {
      lines.push(`### ${nfr.frontmatter.id} (${nfr.frontmatter.status})`, '', nfr.body.trim(), '')
    }
  }
  return `${lines.join('\n').trimEnd()}\n`
}

export function exportRtm(graph: Graph): string {
  type Row = { cr: string; fr: string; wps: string }
  const rows: Row[] = []
  for (const fr of graph.frs) {
    const wpIds = byNaturalId(graph.wps.filter((wp) => graph.wpDelivers(wp.frontmatter.id).includes(fr.frontmatter.id))).map(
      (wp) => wp.frontmatter.id
    )
    const wpsCell = wpIds.length > 0 ? wpIds.join(', ') : '—'
    const crIds = fr.frontmatter.traces_to.length > 0 ? sortRefs(fr.frontmatter.traces_to) : ['—']
    for (const cr of crIds) rows.push({ cr, fr: fr.frontmatter.id, wps: wpsCell })
  }
  rows.sort((a, b) => naturalCompare(a.cr, b.cr) || naturalCompare(a.fr, b.fr))
  const lines = ['# RTM', '', '| CR | FR | WP |', '| --- | --- | --- |', ...rows.map((r) => `| ${r.cr} | ${r.fr} | ${r.wps} |`)]
  return `${lines.join('\n')}\n`
}

export function exportBacklog(graph: Graph): string {
  const openCrs = byNaturalId(graph.crs.filter((cr) => cr.frontmatter.status !== 'resolved'))
  const openWps = byNaturalId(
    graph.wps.filter((wp) => wp.frontmatter.status !== 'accepted' && wp.frontmatter.status !== 'abandoned')
  )
  const openBugs = byNaturalId(graph.bugs.filter((bug) => bug.frontmatter.status === 'open'))

  const lines: string[] = ['# Backlog', '', '## Change Requests', '']
  for (const cr of openCrs) lines.push(`- ${cr.frontmatter.id} (${cr.frontmatter.status})`)
  lines.push('', '## Work Packages', '')
  for (const wp of openWps) lines.push(`- ${wp.frontmatter.id} (${wp.frontmatter.status})`)
  lines.push('', '## Bugs', '')
  for (const bug of openBugs) lines.push(`- ${bug.frontmatter.id} (${bug.frontmatter.severity})`)
  return `${lines.join('\n').trimEnd()}\n`
}
