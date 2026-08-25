// ---- migrate-v3.ts: the v2→v3 canon migration + parity verdict (design spec
// §12, Task 9; CLI verb wiring moved here from Task 8 per the controller's
// task-9 addendum, item 1). A separate module from `migrate.ts` (the v1→v2
// codemod, untouched by this task) — v2 canon (folder epics, `.ba/config.yaml`
// already seeded, flat `wp/<id>.md` pages, free-text CR `entry_point`) is the
// INPUT here, not v1 JSON.
//
// **Interface deviation, flagged for reviewer awareness:** the task-9 brief
// pinned `migrateV3(canonDir, repoRoot, backfill)` (no date). The controller's
// addendum (item 8) requires this function's LAST step to call
// `reconcileCrs`, which itself takes a `date` — and per this package's
// repo-wide determinism invariant (every date is a caller-supplied param,
// never `Date.now()`), that date cannot be read from the clock INSIDE this
// module. So the signature here is widened to a 4th, required `date: string`
// parameter; `cli.ts`'s new `migrate-v3` verb is the one place that reads the
// clock (`--date`, defaulting to `todayDate()`, exactly like every other
// date-taking verb already does) and threads it in.
//
// **Legacy shapes this module tolerates (neither is valid under the CURRENT
// v3 zod schemas in schema.ts):**
//   - a v2 WP: a FLAT `wp/<id>.md` file (not `wp/<id>/index.md`) whose
//     frontmatter carries `fr_ids`/`extra_brs`/`extra_nfrs` — v3's `wpSchema`
//     is `.strict()` (Task 5) and has none of those keys, so `parseFile`
//     fails outright on one of these. `wpSchemaV2` below is the OLD shape,
//     used ONLY by this migration to read such a page.
//   - a v2 CR: `entry_point` as free text (`'solution'`/`'epic'`/`'feature'`,
//     the retired v1/v2 CLI's advisory levels — see cli.ts's own header
//     comment) — v3's `crSchema` narrows `entry_point` to the closed enum
//     `'vision' | 'requirement'`, so a `'solution'` value fails `parseFile`
//     too (this is a plain enum mismatch, not a `.strict()` extra-key
//     rejection — `crSchemaV2` below widens just that one field back to a
//     free string for the read).
// A page that already parses under the CURRENT schema (a fresh v3-authored
// CR, or a WP already migrated by a prior `migrateV3` run) needs no shape
// fix — this is the whole of this module's idempotence story for CR shape;
// WP idempotence instead falls out of `wp/<id>.md` files no longer EXISTING
// once folder-moved (see `migrateWps`'s own comment).
//
// **Snapshot-based parity (controller item 1):** a byte-identical post-hoc
// comparison of "old" vs "new" canon is impossible once the transform has
// run in place (the v2 shapes are gone) — so `migrateV3` writes its OWN
// pre-migration snapshot (`snapshotForParity`) to
// `<canonDir>/.ba/cache/migrate-v3-snapshot.json` as the FIRST thing it does,
// before any transform touches a byte, and NEVER overwrites that file on a
// later run (idempotence: the snapshot must keep recording the TRUE
// pre-migration state, even across repeated `migrateV3` invocations, so a
// later `migrate-v3 --verify` still checks against the real starting point).
// `verifyParityV3` is a pure function over an already-loaded snapshot plus
// the CURRENT (post-migration) canon — it never reads/writes the snapshot
// file itself; that I/O lives in `cli.ts`'s verb handler.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, type Dirent } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import matter from 'gray-matter'
import { parse as yamlParse, stringify as yamlStringify } from 'yaml'
import { z } from 'zod'
import { readCanonConfig, walkCanonFiles } from './fs.js'
import type { Graph } from './graph.js'
import type { FrontmatterFor } from './graph.js'
import { ENTRY_HEADING, HISTORY_HEADING_LINE, demoteHeadings } from './history.js'
import { readCounters, writeCounters, type Counters } from './ids.js'
import { parseFile, parsePage, peekType } from './parse.js'
import { reconcileCrs } from './reconcile.js'
import { atomicWrite, crPath, loadGraph, wpPath } from './writer.js'
import { BUG_ID, CR_ID, WP_ID, countersSchema, crImpactSchema, crSchema, wpSchema, type CrImpact } from './schema.js'
import { pageAnchors, parseScope } from './scopelinks.js'
import { emitPage, naturalCompare } from './serialize.js'
import type { Check, Verdict } from './types.js'

// ==========================================================================
// backfill map — the v2→v3 CR `impacts` reconstruction Task 10 authors
// (§ controller item 5).
// ==========================================================================

export type BackfillEntry = { impacts: CrImpact[] }
export type BackfillMap = Record<string, BackfillEntry>

export const backfillEntrySchema = z.object({ impacts: z.array(crImpactSchema) })
export const backfillMapSchema = z.record(z.string().regex(CR_ID), backfillEntrySchema)

export type MigrateV3Result = {
  written: string[]
  moved: Array<{ from: string; to: string }>
  advisories: string[]
}

// ==========================================================================
// parity snapshot — captured BEFORE any transform (see file header).
// ==========================================================================

/** Structural validation for a snapshot read back off disk (`cli.ts`'s
 * `migrate-v3 --verify`, per this package's "never silently coerce a
 * machine-written artifact" convention — same posture as `ids.ts`'s
 * `readCounters`/`writer.ts`'s `pendingMarkerSchema`). Kept intentionally
 * loose on `versions`/`statuses`/`planFiles` (plain string-keyed records) —
 * their VALUES are cross-checked against live canon by `verifyParityV3`
 * itself, not by this shape check. */
export const paritySnapshotSchema = z.object({
  ids: z.array(z.string()),
  statuses: z.record(z.string(), z.string()),
  versions: z.record(z.string(), z.number()),
  rtmEdges: z.array(z.object({ from: z.string(), to: z.string() })),
  planFiles: z.record(z.string(), z.string()),
  counters: countersSchema,
})

export type ParitySnapshot = z.infer<typeof paritySnapshotSchema>

// ==========================================================================
// legacy (v2) schemas — local to this module, used ONLY to read a page this
// migration is about to fix; never registered in schema.ts's live dispatch
// table (see file header).
// ==========================================================================

const wpSchemaV2 = z.object({
  id: z.string().regex(WP_ID),
  type: z.literal('wp'),
  role: z.enum(['developer', 'qa']),
  status: z.enum(['draft', 'ready', 'plan-approved', 'accepted', 'abandoned']),
  fr_ids: z.array(z.string()).optional(),
  extra_brs: z.array(z.string()).optional(),
  extra_nfrs: z.array(z.string()).optional(),
  plan: z.string().optional(),
})

const crSchemaV2 = z.object({
  id: z.string().regex(CR_ID),
  type: z.literal('cr'),
  status: z.enum(['captured', 'confirmed', 'resolved']),
  entry_point: z.string().optional(),
  entry_point_confirmed: z.boolean().optional(),
  spawned_from_bug: z.string().regex(BUG_ID).optional(),
})

// gray-matter's `engines` option, wrapping the eemeli `yaml` parser — the
// same construction parse.ts/migrate.ts's own `v1YamlEngine` use (the
// "Norway problem" guard), reproduced locally here (parse.ts's own copy isn't
// exported) so a raw legacy read never goes through the DEFAULT gray-matter
// YAML-1.1 engine.
const legacyYamlEngine = { parse: (input: string): object => yamlParse(input) }

/** Reads a page's frontmatter+body WITHOUT any schema validation — the one
 * read path this migration uses for a page it suspects is in a legacy shape
 * the CURRENT schema would reject outright (`parseFile` cannot be reused
 * there: it dispatches straight to `validateFrontmatter`, which is exactly
 * what fails on `fr_ids` / `entry_point: solution`). `undefined` on a read
 * failure (ENOENT etc.), never a throw — callers decide what "unreadable"
 * means for their own step. */
function readRawPage(path: string): { frontmatter: unknown; body: string } | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  const { data, content } = matter(raw, { engines: { yaml: legacyYamlEngine } })
  return { frontmatter: data as unknown, body: content }
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** The directory a Scope link's `path` resolves against — identical formula
 * to `cli.ts`'s own `resolveLinkRoot` (not cross-imported; a one-line path
 * helper, same posture `migrate.ts` already takes toward not reaching into
 * `cli.ts`). Resolved ONCE per `migrateV3` run and reused for both Scope-link
 * generation and the config-seeding step, so the two can never disagree: on
 * a first run `readCanonConfig` has no `link_root` yet, so this falls back to
 * exactly the value `seedLinkRootIfAbsent` is about to seed; on a later run
 * it reads that same seeded value back. */
function resolveLinkRoot(canonDir: string): string {
  return readCanonConfig(canonDir)?.link_root ?? basename(resolve(canonDir))
}

/** Moves `src` -> `dst` via `git mv` (so a real repo keeps rename/blame
 * history for the unchanged parts), falling back to a plain `renameSync` +
 * best-effort `git add -A` when `git mv` fails — an untracked source file, a
 * non-git `repoRoot`, or `git` being unavailable at all. Never throws on the
 * fallback path: a non-git `repoRoot` (or one where the file was never
 * staged) still gets the file moved, just without a git-recorded rename.
 * Both git invocations go through `execFileSync` with an ARGS ARRAY — no
 * shell is ever involved, so a path containing `$`, backticks, spaces, or
 * any other shell-special character passes through byte-verbatim (this
 * module runs against the real production canon; string-interpolated shell
 * quoting is exactly the kind of latent hazard that survives every fixture
 * and detonates on one exotic real path). */
function gitMove(src: string, dst: string, repoRoot: string): void {
  mkdirSync(dirname(dst), { recursive: true })
  try {
    execFileSync('git', ['mv', '--', src, dst], { cwd: repoRoot, stdio: 'pipe' })
  } catch {
    renameSync(src, dst)
    try {
      execFileSync('git', ['add', '-A'], { cwd: repoRoot, stdio: 'pipe' })
    } catch {
      // repoRoot isn't a git repo (or git isn't on PATH) — best-effort only,
      // per this function's own contract; the file is still moved.
    }
  }
}

function flatWpPath(canonDir: string, id: string): string {
  return join(canonDir, 'wp', `${id}.md`)
}

// ==========================================================================
// WP Scope generation (controller item 3) — a legacy WP's `fr_ids`/
// `extra_brs`/`extra_nfrs` frontmatter becomes a `## Scope` body section.
// ==========================================================================

type LegacyWpRefs = { frIds: string[]; extraBrs: string[]; extraNfrs: string[] }

/** Builds the exact `## Scope` block (controller item 3): `### Change
 * requests` = the union of CR ids in the Delivers FRs' `traces_to` (dedup,
 * natural-sorted — "include whatever traces exist, they're factual"); a
 * `### Delivers` FR link is version-stamped at the FR's CURRENT version and
 * carries a `#acceptance-criteria` anchor only when that heading actually
 * exists on the target page (`pageAnchors`); `### Constraints` is the union
 * of those FRs' `enforces`/`references_nfr` plus the WP's own legacy
 * `extra_brs`/`extra_nfrs`, an NFR link similarly anchored `#planguage` only
 * when present, a BR link never anchored (no such heading convention for
 * BRs). A ref that doesn't resolve (dangling `fr_ids`/`extra_*`, or a
 * resolving FR with no recorded canon path) is dropped from its section and
 * reported as an advisory rather than aborting the whole migration — the
 * real corpus's `fr_ids` are internally consistent, but a hand-broken
 * fixture (or a stray typo six months from now) should degrade, not crash. */
function buildScopeSection(graph: Graph, refs: LegacyWpRefs, linkRoot: string, wpId: string, advisories: string[]): string {
  const frById = new Map(graph.frs.map((n) => [n.frontmatter.id, n] as const))
  const nfrById = new Map(graph.nfrs.map((n) => [n.frontmatter.id, n] as const))
  const brById = new Map(graph.brs.map((n) => [n.frontmatter.id, n] as const))

  const frIds = [...new Set(refs.frIds)].sort(naturalCompare)
  const crIds = new Set<string>()
  const nfrIds = new Set<string>(refs.extraNfrs)
  const brIds = new Set<string>(refs.extraBrs)

  const deliversLines: string[] = []
  for (const frId of frIds) {
    const fr = frById.get(frId)
    if (!fr) {
      advisories.push(`${wpId}: fr_ids references unknown FR '${frId}' — omitted from Delivers`)
      continue
    }
    for (const cr of fr.frontmatter.traces_to) crIds.add(cr)
    for (const br of fr.frontmatter.enforces) brIds.add(br)
    for (const nfr of fr.frontmatter.references_nfr) nfrIds.add(nfr)
    const path = graph.pathOf(frId)
    if (!path) {
      advisories.push(`${wpId}: FR '${frId}' has no resolvable canon path — omitted from Delivers`)
      continue
    }
    const anchor = pageAnchors(fr.body).has('acceptance-criteria') ? '#acceptance-criteria' : ''
    deliversLines.push(`- [${frId} v${fr.frontmatter.version}](${linkRoot}/${path}${anchor})`)
  }

  const crLines = [...crIds].sort(naturalCompare).map((crId) => `- [${crId}](${linkRoot}/cr/${crId}.md)`)

  const constraintIds = [...new Set([...nfrIds, ...brIds])].sort(naturalCompare)
  const constraintLines: string[] = []
  for (const id of constraintIds) {
    const nfr = nfrById.get(id)
    const br = brById.get(id)
    if (nfr) {
      const path = graph.pathOf(id)
      if (!path) {
        advisories.push(`${wpId}: NFR '${id}' has no resolvable canon path — omitted from Constraints`)
        continue
      }
      const anchor = pageAnchors(nfr.body).has('planguage') ? '#planguage' : ''
      constraintLines.push(`- [${id} v${nfr.frontmatter.version}](${linkRoot}/${path}${anchor})`)
    } else if (br) {
      const path = graph.pathOf(id)
      if (!path) {
        advisories.push(`${wpId}: BR '${id}' has no resolvable canon path — omitted from Constraints`)
        continue
      }
      constraintLines.push(`- [${id} v${br.frontmatter.version}](${linkRoot}/${path})`)
    } else {
      advisories.push(`${wpId}: Constraints ref '${id}' does not resolve to any NFR/BR — omitted`)
    }
  }

  const sections: string[] = []
  if (crLines.length > 0) sections.push(['### Change requests', ...crLines].join('\n'))
  sections.push(['### Delivers', ...deliversLines].join('\n'))
  if (constraintLines.length > 0) sections.push(['### Constraints', ...constraintLines].join('\n'))

  return ['## Scope', '', sections.join('\n\n')].join('\n')
}

// ==========================================================================
// WP transform (controller items 3-4) — folder move + Scope generation +
// plan-file relocation.
// ==========================================================================

const WP_FLAT_FILE = /^WP-\d{8}-\d{3}\.md$/

/** Migrates every legacy FLAT `wp/<id>.md` page under `canonDir` into its v3
 * `wp/<id>/index.md` folder form. Idempotent by construction: a page this
 * migration has already folder-moved is no longer a flat file directly under
 * `wp/`, so a second run's own `readdirSync` simply finds none — there is no
 * "already migrated?" branch to get wrong here, unlike the CR step. */
function migrateWps(
  canonDir: string,
  repoRoot: string,
  graph: Graph,
  linkRoot: string,
  written: string[],
  moved: Array<{ from: string; to: string }>,
  advisories: string[]
): void {
  const wpDir = join(canonDir, 'wp')
  let entries: Dirent[]
  try {
    entries = readdirSync(wpDir, { withFileTypes: true })
  } catch {
    return
  }
  const filenames = entries
    .filter((e) => e.isFile() && WP_FLAT_FILE.test(e.name))
    .map((e) => e.name)
    .sort(naturalCompare)

  for (const filename of filenames) {
    const id = filename.slice(0, -'.md'.length)
    const oldPath = flatWpPath(canonDir, id)
    const raw = readRawPage(oldPath)
    if (!raw) throw new Error(`migrate-v3: cannot read legacy WP at ${oldPath}`)
    const legacy = wpSchemaV2.safeParse(raw.frontmatter)
    if (!legacy.success) {
      const issues = legacy.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      throw new Error(`migrate-v3: ${oldPath} failed legacy wp schema validation: ${issues.join('; ')}`)
    }
    const fm = legacy.data
    const newPath = wpPath(canonDir, id)
    const newDir = dirname(newPath)

    // ---- plan move (controller item 4) ----
    let planValue = fm.plan
    if (fm.plan !== undefined) {
      const srcAbs = join(repoRoot, fm.plan)
      if (existsSync(srcAbs)) {
        const dstAbs = join(newDir, 'plan.md')
        gitMove(srcAbs, dstAbs, repoRoot)
        moved.push({ from: fm.plan, to: `wp/${id}/plan.md` })
        planValue = `wp/${id}/plan.md`
      } else {
        // Missing plan file on disk: advisory, `plan:` left UNCHANGED — never
        // rewritten to point at a file that doesn't exist (controller item 4).
        advisories.push(`${id}: plan '${fm.plan}' not found at ${srcAbs} — leaving plan: unchanged`)
      }
    }

    // ---- Scope generation (controller item 3) ----
    const scope = buildScopeSection(
      graph,
      { frIds: fm.fr_ids ?? [], extraBrs: fm.extra_brs ?? [], extraNfrs: fm.extra_nfrs ?? [] },
      linkRoot,
      id,
      advisories
    )
    const oldBody = raw.body.trim()
    const newBody = `${oldBody === '' ? '' : `${oldBody}\n\n`}${scope}\n`

    const newFm: Record<string, unknown> = { id, type: 'wp' as const, role: fm.role, status: fm.status }
    if (planValue !== undefined) newFm.plan = planValue
    const validatedFm = wpSchema.parse(newFm)

    // Move the flat file into its folder first (git-aware — controller item
    // 4's "old flat wp/<id>.md deleted via git-aware move"), THEN overwrite
    // its content in place: preserves git rename/blame history for whatever
    // part of the page doesn't change, the same two-step shape the plan move
    // above uses.
    gitMove(oldPath, newPath, repoRoot)
    atomicWrite(newPath, emitPage('wp', validatedFm, newBody))
    moved.push({ from: `wp/${filename}`, to: `wp/${id}/index.md` })
    written.push(newPath)
  }
}

// ==========================================================================
// CR transform (controller item 5) — `entry_point: solution` (or any other
// legacy free-text level) -> `requirement`; backfill map application.
// ==========================================================================

const CR_FILE = /^CR-\d{3}\.md$/

/** Migrates every CR page's shape + applies the backfill map. Idempotent via
 * a "does it already parse under the CURRENT schema?" probe (unlike WP, a
 * CR's path never changes, so presence/absence of the file can't signal
 * idempotence — the shape itself has to): a CR already in v3 shape
 * (`entry_point` already `vision`/`requirement`, or entirely absent — a
 * still-`captured` CR) needs no rewrite for ITS shape, but may still be a
 * confirmed-or-resolved requirement-entry CR newly eligible for backfill (or
 * newly flagged as lacking one) on this same pass.
 *
 * The backfill step applies to a `confirmed` OR a `resolved` requirement-entry
 * CR alike (real-canon defect: CR-005/CR-010 are `resolved` and were silently
 * skipped when this only looked at `confirmed` — `cr-impacts-consistent` then
 * hard-fails a `resolved` CR with no impacts, since "resolved" is supposed to
 * mean every impact is provably delivered). The idempotence key stays exactly
 * "impacts absent + a map entry exists" regardless of which of the two
 * statuses the CR is in. */
function migrateCrs(canonDir: string, backfill: BackfillMap, written: string[], advisories: string[]): void {
  const crDir = join(canonDir, 'cr')
  let entries: Dirent[]
  try {
    entries = readdirSync(crDir, { withFileTypes: true })
  } catch {
    return
  }
  const filenames = entries
    .filter((e) => e.isFile() && CR_FILE.test(e.name))
    .map((e) => e.name)
    .sort(naturalCompare)

  for (const filename of filenames) {
    const id = filename.slice(0, -'.md'.length)
    const path = crPath(canonDir, id)
    const current = parseFile(path, 'cr')

    let fm: Record<string, unknown>
    let body: string
    let changed = false

    if ('error' in current) {
      const raw = readRawPage(path)
      if (!raw) throw new Error(`migrate-v3: cannot read legacy CR at ${path}`)
      const legacy = crSchemaV2.safeParse(raw.frontmatter)
      if (!legacy.success) {
        const issues = legacy.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        throw new Error(`migrate-v3: ${path} failed legacy cr schema validation: ${issues.join('; ')}`)
      }
      fm = { ...legacy.data }
      body = raw.body
      // `needsTransform` (we're in this branch at all) can only mean
      // `entry_point` is present and holds something the v3 enum rejects
      // (`'solution'`/`'epic'`/`'feature'`, never `'vision'`/`'requirement'`
      // — those parse fine under the current schema) — but this guard is
      // kept explicit rather than assumed, so a CR that somehow failed
      // `parseFile` for an unrelated reason never gets an `entry_point`
      // fabricated onto it.
      if (fm.entry_point !== undefined && fm.entry_point !== 'vision') {
        fm.entry_point = 'requirement'
      }
      changed = true
    } else {
      fm = { ...(current.frontmatter as Record<string, unknown>) }
      body = current.body
    }

    if ((fm.status === 'confirmed' || fm.status === 'resolved') && fm.entry_point === 'requirement') {
      const currentImpacts = (fm.impacts as unknown[] | undefined) ?? []
      if (currentImpacts.length === 0) {
        const entry = backfill[id]
        if (entry) {
          fm.impacts = entry.impacts
          fm.provenance = 'backfilled'
          changed = true
        } else {
          advisories.push(`${id}: ${fm.status as string} requirement-entry CR has no backfill entry — impacts left unset`)
        }
      }
    }

    if (changed) {
      const validated = crSchema.parse(fm)
      atomicWrite(path, emitPage('cr', validated, body))
      written.push(path)
    }
  }
}

// ==========================================================================
// History demotion (controller item 6) — retroactively demotes un-demoted
// `##`/`###` headings trapped INSIDE legacy archived History entries (this
// package's own `demoteHeadings`/history-archival step only shipped in v3;
// a body that already carried a `## History` section before that never got
// its embedded content demoted).
// ==========================================================================

/** Demotes every `##`/`###` heading that is content BETWEEN `### v{N} — … —
 * …` entry headings — the entry headings themselves are matched and passed
 * through byte-identical (`ENTRY_HEADING`, imported from history.ts so this
 * can never drift from the one true entry-heading grammar). Reuses
 * `demoteHeadings` (also from history.ts) for every between-entry segment,
 * INCLUDING the segment before the first entry heading (if any) and the one
 * after the last — so a nested, never-demoted `## History` block buried
 * inside an older archived entry demotes right along with everything else in
 * its segment (it's just "content between entry headings," same as any
 * other stray heading — no special-casing by heading TEXT anywhere here). */
function demoteNonEntryHeadingsInHistory(section: string): string {
  const matches = [...section.matchAll(ENTRY_HEADING)]
  if (matches.length === 0) return demoteHeadings(section)
  let out = ''
  let cursor = 0
  for (const m of matches) {
    // Non-null: every element of `matches` came from `section.matchAll`, so
    // its `.index` is always a real offset into `section`.
    const start = m.index!
    out += demoteHeadings(section.slice(cursor, start))
    out += m[0]
    cursor = start + m[0].length
  }
  out += demoteHeadings(section.slice(cursor))
  return out
}

/** Finds the page's `## History` heading (never itself touched — it stays a
 * literal, permanent `## History` across every future archive cycle, exactly
 * as `archiveIntoHistory` already assumes) and demotes only what comes AFTER
 * it. A page with no `## History` section at all is returned unchanged. */
function demoteLegacyHistoryBody(body: string): string {
  const match = HISTORY_HEADING_LINE.exec(body)
  if (!match) return body
  const headEnd = match.index + match[0].length
  return body.slice(0, headEnd) + demoteNonEntryHeadingsInHistory(body.slice(headEnd))
}

function demoteOne<T extends 'fr' | 'nfr' | 'br'>(
  canonDir: string,
  type: T,
  frontmatter: FrontmatterFor<T>,
  body: string,
  path: string | undefined,
  written: string[]
): void {
  if (!HISTORY_HEADING_LINE.test(body)) return
  const demoted = demoteLegacyHistoryBody(body)
  if (demoted === body) return // already fully demoted (idempotent re-run) — no write
  if (!path) return // no recorded canon path for this id — nothing to write back to
  const abs = join(canonDir, ...path.split('/'))
  atomicWrite(abs, emitPage(type, frontmatter, demoted))
  written.push(abs)
}

function demoteLegacyHistories(canonDir: string, graph: Graph, written: string[]): void {
  for (const fr of graph.frs) {
    demoteOne(canonDir, 'fr', fr.frontmatter, fr.body, graph.pathOf(fr.frontmatter.id), written)
  }
  for (const nfr of graph.nfrs) {
    demoteOne(canonDir, 'nfr', nfr.frontmatter, nfr.body, graph.pathOf(nfr.frontmatter.id), written)
  }
  for (const br of graph.brs) {
    demoteOne(canonDir, 'br', br.frontmatter, br.body, graph.pathOf(br.frontmatter.id), written)
  }
}

// ==========================================================================
// counters + config seeding (controller items 7)
// ==========================================================================

/** `product.bug = Math.max(current, 13)` — BUG-013 (dock overlap) is open in
 * the real corpus by owner decision (project memory), so a freshly-migrated
 * ledger must never under-count it. A no-op (no write at all — idempotence)
 * once the floor is already met. */
function bumpBugCounterFloor(canonDir: string, written: string[]): void {
  const counters = readCounters(canonDir)
  if (counters.product.bug >= 13) return
  writeCounters(canonDir, { ...counters, product: { ...counters.product, bug: 13 } })
  written.push(join(canonDir, '.ba', 'counters.yaml'))
}

/** Seeds `link_root` into `.ba/config.yaml` when absent, preserving every
 * other existing key (and its order) via read-parse-mutate-stringify rather
 * than reconstructing the file from scratch. A no-op when `link_root` is
 * already set (idempotence) or, for the rare no-config-at-all case, seeds a
 * minimal `{ link_root }` config rather than silently doing nothing (this
 * migration never fabricates `canon_roots` from nothing — that's
 * `migrate.ts`'s v1->v2 job, not this one's). */
function seedLinkRootIfAbsent(canonDir: string, written: string[]): void {
  const path = join(canonDir, '.ba', 'config.yaml')
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    const seeded = { link_root: basename(resolve(canonDir)) }
    atomicWrite(path, yamlStringify(seeded, { lineWidth: 0 }))
    written.push(path)
    return
  }
  const parsed: unknown = yamlParse(raw)
  const obj: Record<string, unknown> = typeof parsed === 'object' && parsed !== null ? { ...(parsed as Record<string, unknown>) } : {}
  if (obj.link_root !== undefined) return
  obj.link_root = basename(resolve(canonDir))
  atomicWrite(path, yamlStringify(obj, { lineWidth: 0 }))
  written.push(path)
}

// ==========================================================================
// reconcile — final step (controller item 8)
// ==========================================================================

/** Runs `reconcileCrs` over every CR id in the corpus (a directory listing,
 * not a schema-valid graph read — by this point in `migrateV3` every CR
 * SHOULD already be v3-shaped, but there's no reason to make this step
 * depend on that having gone perfectly; `reconcileCrs` itself already
 * no-ops gracefully on an id that doesn't resolve). Tracks which CRs'
 * status actually flipped (e.g. a freshly-backfilled CR resolving) into
 * `written`, by diffing status before/after — `reconcileCrs` itself has no
 * return value to report this from. */
function reconcileAllCrs(canonDir: string, date: string, written: string[]): void {
  const crDir = join(canonDir, 'cr')
  let entries: Dirent[]
  try {
    entries = readdirSync(crDir, { withFileTypes: true })
  } catch {
    return
  }
  const ids = entries
    .filter((e) => e.isFile() && CR_FILE.test(e.name))
    .map((e) => e.name.slice(0, -'.md'.length))
    .sort(naturalCompare)

  const statusBefore = new Map<string, string>()
  for (const id of ids) {
    const parsed = parseFile(crPath(canonDir, id), 'cr')
    if (!('error' in parsed)) statusBefore.set(id, (parsed.frontmatter as { status: string }).status)
  }

  reconcileCrs(canonDir, ids, date)

  for (const id of ids) {
    const parsed = parseFile(crPath(canonDir, id), 'cr')
    if ('error' in parsed) continue
    const after = (parsed.frontmatter as { status: string }).status
    if (statusBefore.get(id) !== after) written.push(crPath(canonDir, id))
  }
}

// ==========================================================================
// migrateV3 — the assembled transform.
// ==========================================================================

/**
 * Transforms a v2 canon under `canonDir` (folder epics already in place; flat
 * `wp/<id>.md` pages; free-text CR `entry_point`) into v3 shape, in place.
 * Every step is individually idempotent (see each helper's own doc comment);
 * a second call with the same arguments produces an EMPTY `written`/`moved`
 * (the ONE exception, the pre-migration snapshot, is durable-once-written by
 * design — see the file header) — `advisories` may legitimately repeat (a
 * still-unresolved gap, e.g. a confirmed CR the backfill map still doesn't
 * cover, is reported again every run until it's actually fixed, which is not
 * a written-side effect).
 *
 * `date` (YYYYMMDD) feeds ONLY the final reconcile step — see this file's
 * header for why this parameter exists beyond the task-9 brief's original
 * 3-argument interface line. Never read from the clock inside this module.
 */
export function migrateV3(canonDir: string, repoRoot: string, backfill: BackfillMap, date: string): MigrateV3Result {
  const written: string[] = []
  const moved: Array<{ from: string; to: string }> = []
  const advisories: string[] = []

  // Step 0: pre-migration snapshot, written FIRST (before any transform) and
  // NEVER overwritten on a later run.
  const snapshotPath = join(canonDir, '.ba', 'cache', 'migrate-v3-snapshot.json')
  if (!existsSync(snapshotPath)) {
    const snapshot = snapshotForParity(canonDir, repoRoot)
    atomicWrite(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`)
    written.push(snapshotPath)
  }

  // Resolved once, consistently reused by both Scope-link generation (below)
  // and the config-seeding step — see `resolveLinkRoot`'s own comment.
  const linkRoot = resolveLinkRoot(canonDir)

  // FR/NFR/BR pages are untouched in SHAPE by this migration (only their
  // `## History` bodies get retroactively demoted, below) — a single
  // `loadGraph` read up front stays valid for both the WP Scope-generation
  // step and the History-demotion step, even though `graph.crs`/`graph.wps`
  // themselves are necessarily incomplete at this point (the pages they'd
  // come from haven't been shape-fixed yet) — neither of those two steps
  // reads `graph.crs`/`graph.wps`.
  const graph = loadGraph(canonDir)

  migrateWps(canonDir, repoRoot, graph, linkRoot, written, moved, advisories)
  migrateCrs(canonDir, backfill, written, advisories)
  demoteLegacyHistories(canonDir, graph, written)
  bumpBugCounterFloor(canonDir, written)
  seedLinkRootIfAbsent(canonDir, written)
  reconcileAllCrs(canonDir, date, written)

  return { written, moved, advisories }
}

// ==========================================================================
// snapshotForParity — tolerant of EITHER shape (legacy or already-v3), since
// it's meant to run against the pre-migration state but has no other way to
// prove that's when it's being called; see each per-type branch below.
// ==========================================================================

type WpSnapshotInfo = { id: string; status?: string; frIds: string[]; plan?: string }

/** Reads one WP page (either shape) for snapshot purposes: tries the CURRENT
 * schema first (an already-migrated, or freshly-authored, v3 WP), falling
 * back to the legacy `wpSchemaV2`. `undefined` if neither parses. */
function readWpForSnapshot(path: string): WpSnapshotInfo | undefined {
  const raw = readRawPage(path)
  if (!raw) return undefined
  const current = wpSchema.safeParse(raw.frontmatter)
  if (current.success) {
    return { id: current.data.id, status: current.data.status, frIds: parseScope(raw.body).frs.map((r) => r.id), plan: current.data.plan }
  }
  const legacy = wpSchemaV2.safeParse(raw.frontmatter)
  if (legacy.success) {
    return { id: legacy.data.id, status: legacy.data.status, frIds: legacy.data.fr_ids ?? [], plan: legacy.data.plan }
  }
  return undefined
}

type CrSnapshotInfo = { id: string; status: string }

function readCrForSnapshot(path: string): CrSnapshotInfo | undefined {
  const raw = readRawPage(path)
  if (!raw) return undefined
  const current = crSchema.safeParse(raw.frontmatter)
  if (current.success) return { id: current.data.id, status: current.data.status }
  const legacy = crSchemaV2.safeParse(raw.frontmatter)
  if (legacy.success) return { id: legacy.data.id, status: legacy.data.status }
  return undefined
}

/** A WP's `plan` value is repo-root-relative pre-migration
 * (`thoughts/shared/plans/x.md`) and canon-relative post-migration (always
 * exactly `wp/<id>/plan.md`) — this distinguishes the two conventions by
 * exact-match against the latter, rather than a heuristic path-shape guess. */
function resolvePlanAbsPath(canonDir: string, repoRoot: string, wpId: string, plan: string): string {
  return plan === `wp/${wpId}/plan.md` ? join(canonDir, plan) : join(repoRoot, plan)
}

/**
 * Captures everything the six `verifyParityV3` checks need, tolerant of
 * either a legacy or already-migrated shape for WP/CR pages (see the
 * per-branch comments below) — intended to be called BEFORE `migrateV3`'s
 * own transform steps run (that's how `migrateV3` itself uses it, per the
 * file header), but has no dependency on that timing to behave correctly.
 */
export function snapshotForParity(canonDir: string, repoRoot: string): ParitySnapshot {
  const files = walkCanonFiles(canonDir)
  const ids: string[] = []
  const statuses: Record<string, string> = {}
  const versions: Record<string, number> = {}
  const rtmEdges: Array<{ from: string; to: string }> = []
  const planFiles: Record<string, string> = {}

  for (const file of files) {
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const type = peekType(raw)

    if (type === 'fr' || type === 'nfr' || type === 'br') {
      const parsed = parsePage(raw, type)
      if ('error' in parsed) continue
      const fm = parsed.frontmatter as { id: string; status: string; version: number; traces_to?: string[] }
      ids.push(fm.id)
      statuses[fm.id] = fm.status
      versions[fm.id] = fm.version
      for (const crId of fm.traces_to ?? []) rtmEdges.push({ from: fm.id, to: crId })
    } else if (type === 'wp') {
      const info = readWpForSnapshot(file)
      if (!info) continue
      ids.push(info.id)
      if (info.status !== undefined) statuses[info.id] = info.status
      for (const frId of info.frIds) rtmEdges.push({ from: frId, to: info.id })
      if (info.plan !== undefined) {
        const planAbs = resolvePlanAbsPath(canonDir, repoRoot, info.id, info.plan)
        try {
          planFiles[info.id] = sha256Hex(readFileSync(planAbs, 'utf8'))
        } catch {
          // referenced plan file not found pre-migration — nothing to hash;
          // migrateV3 reports this same gap as its own advisory.
        }
      }
    } else if (type === 'cr') {
      const info = readCrForSnapshot(file)
      if (!info) continue
      ids.push(info.id)
      statuses[info.id] = info.status
    } else if (type === 'epic' || type === 'bug') {
      const parsed = parsePage(raw, type)
      if ('error' in parsed) continue
      const fm = parsed.frontmatter as { id: string; status: string }
      ids.push(fm.id)
      statuses[fm.id] = fm.status
    }
  }

  const dedupedEdges = rtmEdges.filter(
    (edge, i, arr) => arr.findIndex((o) => o.from === edge.from && o.to === edge.to) === i
  )

  return {
    ids: [...new Set(ids)].sort(naturalCompare),
    statuses,
    versions,
    rtmEdges: dedupedEdges.sort((a, b) => naturalCompare(a.from, b.from) || naturalCompare(a.to, b.to)),
    planFiles,
    counters: readCounters(canonDir),
  }
}

// ==========================================================================
// verifyParityV3 — the six named parity checks (controller item 10).
// ==========================================================================

function counterRegressions(oldCounters: Counters, newCounters: Counters): string[] {
  const out: string[] = []
  const cmp = (key: string, before: number, after: number): void => {
    if (after < before) out.push(`${key}: ${before} -> ${after}`)
  }
  cmp('product.epic', oldCounters.product.epic, newCounters.product.epic)
  cmp('product.cr', oldCounters.product.cr, newCounters.product.cr)
  cmp('product.wp', oldCounters.product.wp, newCounters.product.wp)
  cmp('product.bug', oldCounters.product.bug, newCounters.product.bug)
  for (const [date, seq] of Object.entries(oldCounters.product.baselineSeq)) {
    cmp(`baselineSeq.${date}`, seq, newCounters.product.baselineSeq[date] ?? 0)
  }
  for (const [epicId, epicCounters] of Object.entries(oldCounters.epics)) {
    const after = newCounters.epics[epicId] ?? { fr: 0, nfr: 0, br: 0 }
    cmp(`epics.${epicId}.fr`, epicCounters.fr, after.fr)
    cmp(`epics.${epicId}.nfr`, epicCounters.nfr, after.nfr)
    cmp(`epics.${epicId}.br`, epicCounters.br, after.br)
  }
  return out
}

/**
 * Compares a pre-migration `snapshot` (see `snapshotForParity`) against the
 * CURRENT (post-migration) canon under `canonDir`, as six named `Check`s:
 *   - `same-id-set` — every id preserved (a WP's PATH moving folder-form is
 *     explicitly not an id change, so this never even looks at paths).
 *   - `statuses-preserved` — exception: a CR going `confirmed` -> `resolved`
 *     (the reconcile step's own legitimate effect on a newly-backfilled CR).
 *   - `versions-untouched` — no FR/NFR/BR `version` ever changes.
 *   - `rtm-superset` — every pre-migration FR->CR / FR->WP edge still exists
 *     post-migration (a WP's Delivers set is preserved; an FR's traces_to is
 *     never touched by this migration at all).
 *   - `plan-content-identical` — a migrated plan file's bytes at its new
 *     `wp/<id>/plan.md` location sha256-match its pre-migration content.
 *   - `counters-monotonic` — no ledger counter (nor any per-epic/baseline-seq
 *     sub-counter) ever goes backwards.
 * `repoRoot` is accepted (matching the task-9 brief's pinned 3-arg
 * interface) but unused by any of the six checks above — once migration has
 * completed, every plan file this parity check cares about already lives
 * under `canonDir` (a plan whose move never happened, because its source was
 * missing pre-migration, was never recorded into `snapshot.planFiles` either
 * — see `snapshotForParity`'s own comment — so there is no "check the OLD
 * location" fallback that would ever legitimately apply here).
 */
export function verifyParityV3(snapshot: ParitySnapshot, canonDir: string, repoRoot: string): Verdict {
  void repoRoot
  const graph = loadGraph(canonDir)
  const checks: Check[] = []

  const newIds = new Set<string>([
    ...graph.epics.map((n) => n.frontmatter.id),
    ...graph.frs.map((n) => n.frontmatter.id),
    ...graph.nfrs.map((n) => n.frontmatter.id),
    ...graph.brs.map((n) => n.frontmatter.id),
    ...graph.crs.map((n) => n.frontmatter.id),
    ...graph.wps.map((n) => n.frontmatter.id),
    ...graph.bugs.map((n) => n.frontmatter.id),
  ])
  const oldIds = new Set(snapshot.ids)
  const missingIds = [...oldIds].filter((id) => !newIds.has(id)).sort(naturalCompare)
  const extraIds = [...newIds].filter((id) => !oldIds.has(id)).sort(naturalCompare)
  checks.push({
    name: 'same-id-set',
    ok: missingIds.length === 0 && extraIds.length === 0,
    reason:
      missingIds.length === 0 && extraIds.length === 0
        ? `all ${oldIds.size} id(s) preserved`
        : [missingIds.length > 0 ? `missing: ${missingIds.join(', ')}` : '', extraIds.length > 0 ? `extra: ${extraIds.join(', ')}` : '']
            .filter((s) => s.length > 0)
            .join('; '),
  })

  const newStatusOf = new Map<string, string>([
    ...graph.epics.map((n) => [n.frontmatter.id, n.frontmatter.status] as const),
    ...graph.frs.map((n) => [n.frontmatter.id, n.frontmatter.status] as const),
    ...graph.nfrs.map((n) => [n.frontmatter.id, n.frontmatter.status] as const),
    ...graph.brs.map((n) => [n.frontmatter.id, n.frontmatter.status] as const),
    ...graph.crs.map((n) => [n.frontmatter.id, n.frontmatter.status] as const),
    ...graph.wps.map((n) => [n.frontmatter.id, n.frontmatter.status] as const),
    ...graph.bugs.map((n) => [n.frontmatter.id, n.frontmatter.status] as const),
  ])
  const statusViolations: string[] = []
  for (const [id, oldStatus] of Object.entries(snapshot.statuses)) {
    if (!newIds.has(id)) continue // already reported by same-id-set
    const newStatus = newStatusOf.get(id)
    if (newStatus === undefined || newStatus === oldStatus) continue
    if (CR_ID.test(id) && oldStatus === 'confirmed' && newStatus === 'resolved') continue // the one allowed transition
    statusViolations.push(`${id}: ${oldStatus} -> ${newStatus}`)
  }
  checks.push({
    name: 'statuses-preserved',
    ok: statusViolations.length === 0,
    reason:
      statusViolations.length === 0
        ? "every status preserved (or the allowed CR confirmed->resolved)"
        : statusViolations.join('; '),
  })

  const frNfrBrById = new Map([
    ...graph.frs.map((n) => [n.frontmatter.id, n.frontmatter.version] as const),
    ...graph.nfrs.map((n) => [n.frontmatter.id, n.frontmatter.version] as const),
    ...graph.brs.map((n) => [n.frontmatter.id, n.frontmatter.version] as const),
  ])
  const versionViolations: string[] = []
  for (const [id, oldVersion] of Object.entries(snapshot.versions)) {
    const newVersion = frNfrBrById.get(id)
    if (newVersion === undefined || newVersion === oldVersion) continue
    versionViolations.push(`${id}: v${oldVersion} -> v${newVersion}`)
  }
  checks.push({
    name: 'versions-untouched',
    ok: versionViolations.length === 0,
    reason: versionViolations.length === 0 ? 'no FR/NFR/BR version changed' : versionViolations.join('; '),
  })

  // SYMMETRY INVARIANT (review fix, Task 9): this reconstruction must cover
  // every edge KIND `snapshotForParity` records, or the subset check below
  // reports "dropped" edges that were never dropped. The snapshot side walks
  // `traces_to` for fr AND nfr alike (a br has no such field — vacuously
  // covered), plus the FR->WP delivered edges — so BOTH `traces_to` loops
  // appear here, mirroring graph.ts's own forward-edge construction. The
  // original implementation rebuilt only `graph.frs`, making any NFR with a
  // non-empty `traces_to` (≥12 pages in the real corpus, e.g. E1-NFR5..11 ->
  // CR-001) a guaranteed false VERIFY-FAIL.
  const newEdges = new Set<string>()
  for (const fr of graph.frs) {
    for (const cr of fr.frontmatter.traces_to) newEdges.add(`${fr.frontmatter.id}->${cr}`)
  }
  for (const nfr of graph.nfrs) {
    for (const cr of nfr.frontmatter.traces_to) newEdges.add(`${nfr.frontmatter.id}->${cr}`)
  }
  for (const wp of graph.wps) {
    for (const frId of graph.wpDelivers(wp.frontmatter.id)) newEdges.add(`${frId}->${wp.frontmatter.id}`)
  }
  const droppedEdges = snapshot.rtmEdges.filter((e) => !newEdges.has(`${e.from}->${e.to}`)).map((e) => `${e.from}->${e.to}`)
  checks.push({
    name: 'rtm-superset',
    ok: droppedEdges.length === 0,
    reason: droppedEdges.length === 0 ? 'every pre-migration FR->CR/WP edge survives' : `dropped: ${droppedEdges.join(', ')}`,
  })

  const planViolations: string[] = []
  for (const [wpId, oldHash] of Object.entries(snapshot.planFiles)) {
    const newPath = join(canonDir, 'wp', wpId, 'plan.md')
    let content: string
    try {
      content = readFileSync(newPath, 'utf8')
    } catch {
      planViolations.push(`${wpId}: plan.md missing at ${newPath}`)
      continue
    }
    if (sha256Hex(content) !== oldHash) planViolations.push(`${wpId}: plan.md content changed`)
  }
  checks.push({
    name: 'plan-content-identical',
    ok: planViolations.length === 0,
    reason:
      planViolations.length === 0
        ? 'every migrated plan file is byte-identical to its pre-migration content'
        : planViolations.join('; '),
  })

  const counterViolations = counterRegressions(snapshot.counters, readCounters(canonDir))
  checks.push({
    name: 'counters-monotonic',
    ok: counterViolations.length === 0,
    reason: counterViolations.length === 0 ? 'no counter regressed' : counterViolations.join('; '),
  })

  const verdict: Verdict['verdict'] = checks.every((c) => c.ok) ? 'VERIFY-OK' : 'VERIFY-FAIL'
  return { verdict, checks }
}
