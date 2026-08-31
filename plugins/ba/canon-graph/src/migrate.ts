// ---- migrate.ts: the v1 JSON->md codemod + parity checker (design spec
// §4.1 `migrate`, §12 "Migration & parity", Task 13).
//
// `migrate(v1Dir, outDir)` reads a v1 canon laid out exactly like today's
// `product/` (`product.json`, `br-registry.json`, `cr/*.json`,
// `baselines/*.json`, `work-packages/WP-*.{json,md}`) and emits the v2 md
// canon (§5 layout) through `emitPage` — never hand-concatenated — seeding
// `.ba/counters.yaml` from v1's `_counters` via `ids.ts`'s own
// `writeCounters` (reused, not duplicated). Per the task's ambiguity
// resolution #1, migrate writes DIRECTLY: ids are already known from v1, so
// there is no `allocateId`/`addRequirement` round-trip here — only the
// atomic single-file write mechanics (`writer.ts`'s `atomicWrite`) are
// reused, never the minting functions.
//
// `verifyParity(v1Dir, outDir)` proves the conversion lost nothing: it
// independently reconstructs BOTH sides on every call (v1 JSON parsed fresh;
// the md canon via `writer.ts`'s `loadGraph`) and compares — id
// set-equality per type, a per-item content-hash of the normalized
// statement (+ AC text for FRs), each baseline's frozen-id list, and each
// WP's `fr_ids`. Both functions are PURE w.r.t. the clock: no `Date.now()`/
// RNG anywhere in this module — every date is transcribed straight from the
// v1 JSON's own date fields.
//
// **`product/vision.md` (gap fix, post-initial-migration):** unlike every
// other v1 input above, vision.md is already hand-authored markdown — rich
// prose, not JSON — so its BODY is carried over completely verbatim, opaque,
// never reflowed (same "never hand-concatenated, never re-flowed" discipline
// as every other emitted page here). Only its FRONTMATTER is reshaped: v1's
// frontmatter (`status`/`created`/`confirmed`/`confirmed_by`/`cr`/
// `confirm_with_kate`) collapses into v2's minimal `visionSchema`
// (`type: 'vision'`, `status`) — every other v1-only field is dropped, never
// fabricated into a v2 field that doesn't exist. A v1 corpus with no
// vision.md at all (some test fixtures) is not an error: this step is
// skipped, not migrate failing wholesale. See `readV1Vision`/step 0 below.
//
// Likewise `prd.json` is read only during this task's research, never as a
// migration INPUT: v1's own diagnosis (design doc §1) names `prd.json` as
// one leg of the "triple-copy denormalization" disease (FR text duplicated
// across `product.json` and `prd.json`, occasionally drifting stale) — v2's
// PRD is a derived render (`exportPrd`, serialize.ts), never a migrated
// page, so `product.json`'s `requirement_db` is the sole authoritative FR/
// NFR content source here.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative, sep } from 'node:path'
import matter from 'gray-matter'
import { parse as yamlParse, stringify as yamlStringify } from 'yaml'
import { NEXT_HEADING, parseAcBlock } from './ac.js'
import { emitPage, naturalCompare, type FrontmatterFor } from './serialize.js'
import { baselineManifestSchema, countersSchema, validateFrontmatter } from './schema.js'
import { writeCounters, type Counters } from './ids.js'
import { atomicWrite, loadGraph } from './writer.js'
import { DEFAULT_CANON_ROOTS } from './fs.js'
import type { Check, NodeType, Status, Verdict } from './types.js'

// ==========================================================================
// v1 shapes — loose, local types over the JSON this module reads. Not
// zod-validated on the way IN (v1 has no schema of its own); every emitted
// OUTPUT frontmatter object, by contrast, IS validated via `schema.ts`'s
// `validateFrontmatter` before it is ever handed to `emitPage` (the task
// brief's own instruction: "your emitted frontmatter must validate against
// these [schemas]") — see `emitValidated` below, the one seam every page
// write in this module funnels through.
// ==========================================================================

type V1EpicCounters = { fr: number; nfr: number; br: number }

type V1Epic = {
  id: string
  title: string
  status: string
  _counters: V1EpicCounters
}

type V1RequirementCurrent = {
  version: string
  text: string
  acceptance_criteria: string[]
}

type V1Requirement = {
  id: string
  type: 'fr' | 'nfr'
  epic_id: string
  status: string
  current: V1RequirementCurrent
  baseline_ref: string | null
  cr_refs: string[]
}

type V1Product = {
  epics: V1Epic[]
  requirement_db: V1Requirement[]
  _counters: { epic: number; cr: number; wp: number }
}

type V1RuleCurrent = {
  version: string
  rule_text: string
  rationale: string
  enforcement: string
}

type V1Rule = {
  id: string
  epic_id: string
  status: string
  current: V1RuleCurrent
}

type V1BrRegistry = {
  rules: V1Rule[]
}

type V1Cr = {
  id: string
  status: string
  client_words: string
  entry_point_advisory?: string | null
  entry_point_confirmed?: string | null
}

type V1Baseline = {
  baseline_id: string
  date: string
  wp_ref: string
  frozen_requirement_ids: string[]
}

/** `status` is the only v1 vision field this module carries forward (see
 * the file header's "gap fix" note) — every other v1-only field
 * (`created`/`confirmed`/`confirmed_by`/`cr`/`confirm_with_kate`) has no
 * counterpart in v2's minimal `visionSchema` and is simply dropped, never
 * fabricated into one. `body` is the raw markdown after the frontmatter
 * fence, kept fully opaque. */
type V1Vision = { status: unknown; body: string }

type V1WpJson = { wp_id: string; role: string; fr_ids: string[] }
type V1WpMdFrontmatter = { wp_id: string; role: string; fr_ids: string[] }
type V1Wp = { id: string; role: 'developer' | 'qa'; frIds: string[] }

// ==========================================================================
// small IO/parsing helpers
// ==========================================================================

/** Boundary-widening JSON read (same pattern as parse.ts's `frontmatterInput:
 * unknown = data`): `JSON.parse`'s return type is `any` in lib.es5.d.ts, so
 * it is captured through an explicit `unknown` local before the one narrow
 * cast to the caller's expected v1 shape — never a bare `any` escapes this
 * function. v1 has no schema of its own to validate against; a malformed
 * file surfaces later as a thrown error from whatever field access fails. */
function readJson<T>(path: string): T {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  return raw as T
}

function tryReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

// gray-matter's `engines` option, wrapping the eemeli `yaml` parser — the
// same construction parse.ts uses for the real v2 read path, applied here to
// the OLD-style WP `.md` frontmatter (product_id/fr_ids/etc.) so an
// unquoted date-shaped scalar never gets silently coerced to a JS `Date` by
// a default YAML-1.1 schema (the "Norway problem" parse.ts's own header
// warns about). Kept as a local copy (parse.ts's own engine object isn't
// exported) — a three-line construction, not a re-implementation of any
// parsing logic.
const v1YamlEngine = { parse: (input: string): object => yamlParse(input) }

function readV1WpMdFrontmatter(raw: string): V1WpMdFrontmatter {
  const { data } = matter(raw, { engines: { yaml: v1YamlEngine } })
  const fmUnknown: unknown = data
  return fmUnknown as V1WpMdFrontmatter
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** Every emitted page funnels through here: build the frontmatter object,
 * validate it against `schema.ts` (the brief's own requirement — "your
 * emitted frontmatter must validate against these [schemas]"), THEN emit via
 * `emitPage` (never hand-concatenated) and write atomically. Throws with the
 * joined zod issues on a mapping bug — loud failure, not a silently-invalid
 * page written to disk. */
function emitValidated(path: string, type: NodeType, frontmatter: Record<string, unknown>, body: string): void {
  const validation = validateFrontmatter(type, frontmatter)
  if (!validation.ok) {
    throw new Error(`migrate: emitted ${type} frontmatter for ${path} failed schema validation: ${validation.issues.join('; ')}`)
  }
  const content = emitPage(type, frontmatter as unknown as FrontmatterFor<NodeType>, body)
  atomicWrite(path, content)
}

// ==========================================================================
// path + naming helpers (mirrors writer.ts's own conventions; not exported
// there, so reproduced locally — this is path-formatting, not the
// serialization/validation logic the task's reuse constraint is about)
// ==========================================================================

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug === '' ? 'epic' : slug
}

function epicDir(outDir: string, epicId: string, slug: string): string {
  return join(outDir, 'epics', `${epicId}-${slug}`)
}

// ==========================================================================
// value mapping — v1 -> v2 (documented per-field in Task 13's report)
// ==========================================================================

const V1_STATUS_TO_V2: Record<string, Status> = {
  active: 'active',
  draft: 'draft',
  baseline: 'baselined',
  superseded: 'superseded',
  retired: 'retired',
}

function mapRequirementStatus(v1Status: string, id: string): Status {
  const mapped = V1_STATUS_TO_V2[v1Status]
  if (!mapped) throw new Error(`migrate: ${id} has an unrecognized v1 status '${v1Status}'`)
  return mapped
}

function parseVersion(v: string, id: string): number {
  const m = /^v(\d+)$/.exec(v)
  if (!m) throw new Error(`migrate: ${id} has an unparseable version '${v}' (expected 'v<N>')`)
  // Non-null: the regex's one capture group is unconditional, so a successful
  // match always populates it (same reasoning as ac.ts's AC_BULLET parse).
  return Number(m[1]!)
}

/** v1 baseline/CR dates are ISO (`2026-07-08`); every v2 date-keyed field
 * (counters.yaml's `baselineSeq`, a baseline manifest's `date`) is the plain
 * `YYYYMMDD` `DATE_KEY` shape (schema.ts) — this is a pure string transform,
 * never a clock read. */
function toDateKey(isoDate: string, context: string): string {
  const digits = isoDate.replace(/-/g, '')
  if (!/^\d{8}$/.test(digits)) throw new Error(`migrate: cannot parse date '${isoDate}' (${context}) into YYYYMMDD`)
  return digits
}

/** v1's `current.text` embeds its goal-trace/priority/rationale narrative as
 * a trailing bracket — `"...so that X. [goal-trace: ... | priority: ... |
 * rationale: ...]"` — never a structured field. §6.2's FR body wants this as
 * prose under `## Rationale`, separate from the leading user-story
 * statement; this splits the two, verbatim (no reformatting of the
 * statement itself — that's a human `shape-requirement` job, not a
 * mechanical codemod's). */
const GOAL_TRACE_BRACKET = /\s*\[goal-trace:\s*([\s\S]*?)\]\s*$/

function splitStatementAndRationale(text: string): { statement: string; rationale?: string } {
  const trimmed = text.trim()
  const m = GOAL_TRACE_BRACKET.exec(trimmed)
  if (!m) return { statement: trimmed }
  const rationale = m[1]?.trim()
  const statement = trimmed.slice(0, m.index).trim()
  return rationale ? { statement, rationale } : { statement }
}

/** Reflows the bracket's `|`-separated segments (`goal-trace: ... | priority:
 * ... | rationale: ...`) into a small bullet list — no content invented,
 * just re-punctuated for a `## Rationale` section instead of a single
 * run-on bracket. */
function formatRationale(rationale: string): string {
  return rationale
    .split('|')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map((segment) => `- ${segment}`)
    .join('\n')
}

function buildFrBody(text: string, acs: readonly string[]): string {
  const { statement, rationale } = splitStatementAndRationale(text)
  const lines: string[] = [statement, '', '## Acceptance Criteria', '']
  acs.forEach((ac, index) => lines.push(`- AC-${index + 1}: ${ac.trim()}`))
  if (rationale) lines.push('', '## Rationale', '', formatRationale(rationale))
  return lines.join('\n')
}

// NFR: v1 has no structured Planguage (Tag/Scale/Meter/Goal) fields — its
// `current.text` is already flattened prose ("Tag: description. Measure:
// ..."). Synthesizing a fake Tag/Scale/Meter/Goal split from unstructured
// prose would be inventing structure the source doesn't have (a human
// `shape-requirement` judgment call, not a deterministic codemod's); this
// carries the prose over verbatim instead, same rationale-split as FR in
// case a future NFR ever carries the bracket (none does in the live corpus
// today, per this task's inspection of product.json).
function buildNfrBody(text: string): string {
  const { statement, rationale } = splitStatementAndRationale(text)
  const lines: string[] = [statement]
  if (rationale) lines.push('', '## Rationale', '', formatRationale(rationale))
  return lines.join('\n')
}

const PLACEHOLDER_RATIONALE = '(to be completed)'

function buildBrBody(ruleText: string, rationale: string): string {
  const lines: string[] = [ruleText.trim()]
  if (rationale.trim() !== '' && rationale.trim() !== PLACEHOLDER_RATIONALE) {
    lines.push('', '## Rationale', '', rationale.trim())
  }
  return lines.join('\n')
}

// ==========================================================================
// v1 readers
// ==========================================================================

function readCrs(v1Dir: string): V1Cr[] {
  const dir = join(v1Dir, 'cr')
  return tryReaddir(dir)
    .filter((f) => /^CR-\d{3}\.json$/.test(f))
    .map((f) => readJson<V1Cr>(join(dir, f)))
    .sort((a, b) => naturalCompare(a.id, b.id))
}

function readBaselines(v1Dir: string): V1Baseline[] {
  const dir = join(v1Dir, 'baselines')
  return tryReaddir(dir)
    .filter((f) => /^BL-\d{8}(-\d+)?\.json$/.test(f))
    .map((f) => readJson<V1Baseline>(join(dir, f)))
    .sort((a, b) => naturalCompare(a.baseline_id, b.baseline_id))
}

/** Reads `<v1Dir>/vision.md` if present — absent is not an error (returns
 * `undefined`), matching every other `tryReaddir`-backed reader in this
 * module: a v1 corpus that hasn't authored a vision yet must not fail the
 * whole migration. Uses the same gray-matter + eemeli-`yaml`-engine
 * construction as `readV1WpMdFrontmatter` above (the "Norway problem"
 * guard), parsed only far enough to read `status` — every other field, and
 * the body itself, is never inspected, just carried through. */
function readV1Vision(v1Dir: string): V1Vision | undefined {
  const path = join(v1Dir, 'vision.md')
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  const { data, content } = matter(raw, { engines: { yaml: v1YamlEngine } })
  const fmUnknown: unknown = data
  return { status: (fmUnknown as { status?: unknown }).status, body: content }
}

/** v1's `status` is free-text (`confirmed`/`draft`/anything a human typed);
 * v2's `visionSchema` only accepts `'draft' | 'confirmed'`. Per the task's
 * mapping rule: pass through a recognized v1 status verbatim, else default
 * to `'confirmed'` (the real corpus's own vision.md is `status: confirmed`,
 * and a hand-authored vision reaching migration is presumptively the
 * settled one — never silently downgraded to `draft`). */
function mapVisionStatus(v1Status: unknown): 'draft' | 'confirmed' {
  return v1Status === 'draft' || v1Status === 'confirmed' ? v1Status : 'confirmed'
}

/** WP `fr_ids` are transcribed 1:1 from BOTH real v1 shapes (design doc §12):
 * the newer WPs carry `fr_ids` directly in their `.md` frontmatter; the
 * older ones have a sibling `WP-*.json` with `fr_ids`. The `-ac-matrix.json`
 * companion files (`WP-*-ac-matrix.json`) are a distinct artifact (per-AC
 * verification mappings, not a WP page) and are excluded by the anchored
 * `WP-\d{8}-\d{3}\.json$` regex below (an `-ac-matrix` suffix never matches
 * it).
 *
 * On the real corpus most WPs have BOTH a `.json` and a `.md` for the same
 * id (the `.md` is v1's generated batch document; the `.json` is the
 * structured sidecar `ba-flow` also wrote). This function is keyed by WP id
 * — one `V1Wp` per id, never two — and when both siblings exist for an id,
 * the `.json` wins: it is the clean, authoritative source (`{wp_id, role,
 * fr_ids}`, exactly what a v2 WP page needs) and is read INSTEAD of the
 * `.md`, not merely preferred once both are parsed. That matters because a
 * real v1 `.md` can carry a v1 `ba-flow` frontmatter defect (e.g. an
 * unquoted colon inside a free-text field, tripping the strict eemeli YAML
 * parser) that must never fail the whole migration when a clean `.json`
 * sibling already has everything required — the `.md` is only ever parsed
 * as a fallback, for the id's with no `.json` sibling at all. */
function readWps(v1Dir: string): V1Wp[] {
  const dir = join(v1Dir, 'work-packages')
  const idsWithJson = new Set<string>()
  const idsWithMd = new Set<string>()
  for (const f of tryReaddir(dir)) {
    if (/^WP-\d{8}-\d{3}\.json$/.test(f)) idsWithJson.add(f.slice(0, -'.json'.length))
    else if (/^WP-\d{8}-\d{3}\.md$/.test(f)) idsWithMd.add(f.slice(0, -'.md'.length))
  }
  const wps: V1Wp[] = []
  for (const filenameId of new Set([...idsWithJson, ...idsWithMd])) {
    if (idsWithJson.has(filenameId)) {
      const data = readJson<V1WpJson>(join(dir, `${filenameId}.json`))
      wps.push({ id: data.wp_id, role: asRole(data.role, data.wp_id), frIds: [...data.fr_ids] })
    } else {
      const raw = readFileSync(join(dir, `${filenameId}.md`), 'utf8')
      const fm = readV1WpMdFrontmatter(raw)
      wps.push({ id: fm.wp_id, role: asRole(fm.role, fm.wp_id), frIds: [...fm.fr_ids] })
    }
  }
  return wps.sort((a, b) => naturalCompare(a.id, b.id))
}

function asRole(role: string, wpId: string): 'developer' | 'qa' {
  if (role !== 'developer' && role !== 'qa') {
    throw new Error(`migrate: ${wpId} has an unrecognized role '${role}' (expected developer|qa)`)
  }
  return role
}

/** Reconciles a v1 baseline's TRUE frozen-id set — a real v1 data defect,
 * traced to `ba-flow.js`'s `accept()` handler: it mints the baseline id as
 * a plain calendar-date string (`BL-${today()}`, no per-accept sequence) and
 * then unconditionally overwrites `baselines/<id>.json` with THIS accept's
 * own `frozen_requirement_ids` (`safeWriteJSON(baselineFile, baseline)`).
 * When two DIFFERENT WPs are accepted on the SAME calendar day, they collide
 * onto the same baseline id and the second accept's write clobbers the
 * first's item list wholesale — on the real corpus this happened for all
 * three baselines (e.g. `BL-20260708`'s file lists only `E3-FR1`, the LAST
 * WP accepted that day; an earlier same-day accept's `E1-FR1`/`E1-FR7` are
 * silently missing from the file).
 *
 * The lost ids are recoverable, though: `accept()` ALSO stamps
 * `rec.baseline_ref = baselineId` on every requirement it touches,
 * unconditionally, per-item — and a requirement's OWN `baseline_ref` is
 * never touched again by an unrelated accept (only a LATER accept of that
 * SAME requirement would change it). So every requirement whose
 * `baseline_ref` names this baseline id was, in fact, frozen by it,
 * regardless of whether the (possibly-clobbered) baseline file's own list
 * still says so. The true frozen set is therefore the UNION of the file's
 * list and every fr/nfr whose `baseline_ref` equals this baseline's id —
 * invents nothing (both halves come straight from v1's own data) and is a
 * no-op union when no same-day collision occurred (the common case).
 *
 * Shared by `migrate` (so the emitted manifest's `items[]` is complete, not
 * lossy of the clobbered ids) and `verifyParity` (so its own expectation is
 * reconciled the SAME way — never a blind trust of the collision-lossy file
 * field alone, which would just re-encode the v1 tool's own bug as a
 * "passing" parity check). */
function trueFrozenIds(baselineId: string, fileList: readonly string[], requirements: readonly V1Requirement[]): string[] {
  const fromRequirements = requirements.filter((r) => r.baseline_ref === baselineId).map((r) => r.id)
  return [...new Set([...fileList, ...fromRequirements])].sort(naturalCompare)
}

// ==========================================================================
// migrate — the codemod
// ==========================================================================

export type MigrateResult = { written: string[] }

// ---- canon-path scoping (Plan-2 Task 0): the standard v2 canon-layout
// roots seeded into `outDir/.ba/config.yaml` (schema.ts's `configSchema`) so
// a freshly migrated repo is IMMEDIATELY self-describing for
// `validate`/`loadGraph`/the VitePress loaders — no separate
// config-authoring step, and no risk of a real `product/`'s VitePress
// **prose** (`process/`, `architecture/`, …) being mistaken for canon.
//
// `epics/`, `br/`, `cr/`, `wp/` are exactly the directories THIS function
// writes pages into (steps 0-5 below; step 0 is vision.md). `vision.md`
// itself is a single file, populated by step 0 whenever `<v1Dir>/vision.md`
// exists (the real-corpus case) — listed here regardless, since an absent
// root simply resolves to zero files (`fs.ts`'s `walkRoot`), so a v1 corpus
// with no vision.md yet still gets a config that's ready the moment one is
// authored. `bugs/` is also listed even though this run never populates it:
// v1 has no bug-tracking concept at all (`bugs/` is a v2-only addition,
// populated later via `bug capture`). Both are legitimate canon locations
// the seeded config should cover up front — so it never needs a follow-up
// edit the first time either is used.
//
// `baselines/` is deliberately ABSENT from this list: frozen baseline
// snapshots are excluded from canon discovery UNCONDITIONALLY
// (`fs.ts`'s `walkCanonFiles`, never overridable via config) — a real
// `accept()`-produced baseline dir holds frozen `<id>.md` copies with
// perfectly valid fr/nfr/br frontmatter, and scanning it would double-count
// those ids into the live graph. Listing it as a "canon root" here would
// do nothing but misleadingly suggest it's just another scannable root.
const MIGRATED_CANON_ROOTS: readonly string[] = [...DEFAULT_CANON_ROOTS]

/**
 * Reads a v1 canon under `v1Dir` (laid out like today's `product/`) and
 * emits the v2 md canon under `outDir` (design spec §5), including a
 * reshaped `vision.md` when one exists (its hand-authored body carried over
 * verbatim — see the file header), and seeding `outDir/.ba/counters.yaml`
 * from v1's `_counters` and `outDir/.ba/config.yaml` with the standard
 * canon-path-scoping roots (see `MIGRATED_CANON_ROOTS` above). Pure w.r.t.
 * the clock — every date is transcribed from a v1 JSON date field, never
 * `Date.now()`. Returns every path written (pages + the counters/config
 * ledgers).
 */
export function migrate(v1Dir: string, outDir: string): MigrateResult {
  const written: string[] = []
  const product = readJson<V1Product>(join(v1Dir, 'product.json'))
  const brRegistry = readJson<V1BrRegistry>(join(v1Dir, 'br-registry.json'))
  const crs = readCrs(v1Dir)
  const baselines = readBaselines(v1Dir)
  const wps = readWps(v1Dir)
  // Read BEFORE any write below (same in-place-safety discipline as every
  // other v1 read here): `migrate` may run with `v1Dir === outDir`, so
  // `<v1Dir>/vision.md` must be fully read into memory before step 0 below
  // ever calls `atomicWrite` on `<outDir>/vision.md` (potentially that same
  // path) — `atomicWrite`'s temp-file+rename is what makes the eventual
  // overwrite itself safe, but only if the read already happened.
  const v1Vision = readV1Vision(v1Dir)

  const epicSlugById = new Map(product.epics.map((e) => [e.id, slugify(e.title)] as const))
  // fr/nfr/br id -> {version, path} — populated while writing those pages,
  // consumed by the baseline-manifest step below (which needs both the
  // CURRENT version number and the exact emitted bytes' content-hash of
  // every item a v1 baseline froze).
  const versionById = new Map<string, number>()
  const pathById = new Map<string, string>()
  // fr/nfr id -> v1 status, used only to derive a migrated WP's status.
  const reqStatusById = new Map(product.requirement_db.map((r) => [r.id, r.status] as const))

  // ---- 0. vision (optional — skipped, not a failure, when v1Dir has no
  // vision.md at all; see `readV1Vision`/`V1Vision` above) ----
  if (v1Vision) {
    const path = join(outDir, 'vision.md')
    const status = mapVisionStatus(v1Vision.status)
    emitValidated(path, 'vision', { type: 'vision', status }, v1Vision.body)
    written.push(path)
  }

  // ---- 1. epics ----
  for (const epic of product.epics) {
    // Non-null: `epicSlugById` was just built from this same `product.epics`
    // array, so every `epic.id` it contains resolves.
    const path = join(epicDir(outDir, epic.id, epicSlugById.get(epic.id)!), 'index.md')
    emitValidated(path, 'epic', { id: epic.id, type: 'epic', title: epic.title, status: epic.status }, '')
    written.push(path)
  }

  // ---- 2. fr / nfr ----
  // `requirement_db` on the real corpus also carries `type: 'br'` entries
  // (e.g. `E1-BR1`) — redundant duplicates of the SAME rule that is
  // authoritatively defined in `br-registry.json` and emitted by step 3
  // below. `V1Requirement`'s type only models `'fr' | 'nfr'`; a `br` entry
  // has no `acceptance_criteria`-shaped `current` the FR/NFR branch expects
  // and, more fundamentally, lacks `kind`/`enforcement` entirely (those
  // live only on `br-registry.json`'s `V1Rule`), so building br frontmatter
  // from THIS record would either fabricate values or fail
  // `brSchema`'s required fields. `verifyParity` below already filters to
  // `r.type === 'fr'` / `r.type === 'nfr'` for exactly this reason (see
  // `v1Frs`/`v1Nfrs`); this loop mirrors that filter so the two stay
  // consistent about what `requirement_db` actually authoritatively
  // contains. Skipping these duplicates loses nothing: every `br` id here
  // has a real counterpart in `br-registry.json`, migrated by step 3.
  for (const req of product.requirement_db.filter((r) => r.type === 'fr' || r.type === 'nfr')) {
    const slug = epicSlugById.get(req.epic_id)
    if (slug === undefined) throw new Error(`migrate: ${req.id} references unknown epic '${req.epic_id}'`)
    const path = join(epicDir(outDir, req.epic_id, slug), `${req.id}.md`)
    const version = parseVersion(req.current.version, req.id)
    const status = mapRequirementStatus(req.status, req.id)
    const tracesTo = [...req.cr_refs]
    const hasDerivedTrace = tracesTo.length > 0

    const fm: Record<string, unknown> = {
      id: req.id,
      type: req.type,
      epic: req.epic_id,
      status,
      version,
      traces_to: tracesTo,
      ...(req.type === 'fr' ? { enforces: [], references_nfr: [], related: [] } : { verified_by: [], related: [] }),
    }
    if (req.baseline_ref) fm.baseline = req.baseline_ref
    // Ref-backfill grandfathering (design spec §12 / ambiguity resolution
    // #3): a trace that ISN'T derivable from a structured v1 field (an empty
    // `cr_refs` — the goal-trace bracket is prose only) is stamped
    // `provenance: migrated`, downgrading the orphan/no-CR-trace check to
    // advisory until the item is next re-authored through
    // `shape-requirement`.
    if (!hasDerivedTrace) fm.provenance = 'migrated'

    const body = req.type === 'fr' ? buildFrBody(req.current.text, req.current.acceptance_criteria) : buildNfrBody(req.current.text)
    emitValidated(path, req.type, fm, body)
    written.push(path)
    versionById.set(req.id, version)
    pathById.set(req.id, path)
  }

  // ---- 3. br ----
  for (const rule of brRegistry.rules) {
    const path = join(outDir, 'br', `${rule.id}.md`)
    const version = parseVersion(rule.current.version, rule.id)
    const status = mapRequirementStatus(rule.status, rule.id)
    const enforcement = rule.current.enforcement
    if (enforcement !== 'advisory' && enforcement !== 'hard') {
      throw new Error(`migrate: ${rule.id} has an unrecognized enforcement '${enforcement}'`)
    }
    // `kind` (structural|operative) has NO v1 source field at all — v1's
    // `domain_source` ("client-stated") describes PROVENANCE, not the
    // structural/operative distinction §6.4 draws. No default is named by
    // the task's ambiguity resolutions, so this mirrors the one precedent
    // already in the codebase: writer.ts's own `addRequirement` defaults a
    // freshly-authored BR's `kind` to `'operative'` when the caller doesn't
    // specify one. Flagged in the Task 13 report for reviewer scrutiny.
    const fm: Record<string, unknown> = {
      id: rule.id,
      type: 'br',
      epic: rule.epic_id,
      kind: 'operative',
      enforcement,
      status,
      version,
    }
    const body = buildBrBody(rule.current.rule_text, rule.current.rationale)
    emitValidated(path, 'br', fm, body)
    written.push(path)
    versionById.set(rule.id, version)
    pathById.set(rule.id, path)
  }

  // ---- 4. cr ----
  for (const cr of crs) {
    const path = join(outDir, 'cr', `${cr.id}.md`)
    const fm: Record<string, unknown> = { id: cr.id, type: 'cr', status: cr.status }
    // v1 carries TWO separate string-valued fields — `entry_point_advisory`
    // (the machine-suggested level) and `entry_point_confirmed` (the
    // HUMAN-confirmed level, a string, once set) — where v2 instead has ONE
    // string (`entry_point`, written only at confirm time — see cli.ts's own
    // `cr confirm` handler, which sets `entry_point: entry` from the
    // human's `--entry` flag) plus a boolean `entry_point_confirmed` flag.
    // So a v1 CR already at `confirmed`/`resolved` maps its CONFIRMED level
    // (falling back to the advisory one only if that's somehow missing)
    // into v2's `entry_point`, and sets the boolean flag true; a `captured`
    // CR (never confirmed) gets neither field, exactly mirroring what `cr
    // capture` itself would have written. Flagged in the Task 13 report.
    if (cr.status === 'confirmed' || cr.status === 'resolved') {
      const level = cr.entry_point_confirmed ?? cr.entry_point_advisory
      if (level) {
        fm.entry_point = level
        fm.entry_point_confirmed = true
      }
    }
    const body = `${cr.client_words.trim()}\n`
    emitValidated(path, 'cr', fm, body)
    written.push(path)
  }

  // ---- 5. wp ----
  for (const wp of wps) {
    const path = join(outDir, 'wp', `${wp.id}.md`)
    // v1 has no WP-status concept matching v2's draft/ready/plan-approved/
    // accepted/abandoned enum. Derived rule: if EVERY fr_id this WP scoped
    // is already `baseline` in v1 (i.e. this WP's work was, in fact, frozen
    // into a v1 baseline), the migrated WP is `accepted`; otherwise `draft`
    // (the conservative default — "not yet known to be frozen").
    const allBaselined = wp.frIds.length > 0 && wp.frIds.every((id) => reqStatusById.get(id) === 'baseline')
    const status = allBaselined ? 'accepted' : 'draft'
    // v3 (Task 4): `fr_ids` is retired from WP frontmatter entirely — a WP's
    // delivered-FR set now lives in the body's machine-readable `## Scope` /
    // `### Delivers` link list (scopelinks.ts's `parseScope`, graph.ts's
    // `wpDelivers`). Each link resolves against the CANON-RELATIVE path this
    // same migration already wrote that FR to (`pathById`, populated in step
    // 2 above) — never a fabricated/guessed path.
    const fm: Record<string, unknown> = { id: wp.id, type: 'wp', role: wp.role, status }
    const deliversLines = wp.frIds
      .map((id) => {
        const itemPath = pathById.get(id)
        if (!itemPath) throw new Error(`migrate: wp ${wp.id} scopes unknown FR '${id}'`)
        return `- [${id}](${relative(outDir, itemPath).split(sep).join('/')})`
      })
      .join('\n')
    // v1's own WP doc is the full generated batch document (ephemeral-cache
    // shaped in v2 terms, not a canon body) — §6.6 wants a SHORT goal/intent
    // instead, so this synthesizes one rather than carrying the huge
    // generated prose over as if it were hand-authored canon content.
    const body =
      `Migrated from v1 ${wp.id} (role: ${wp.role}). FR scope: ${wp.frIds.join(', ')}.\n\n` +
      `## Scope\n\n### Delivers\n\n${deliversLines}\n`
    emitValidated(path, 'wp', fm, body)
    written.push(path)
  }

  // ---- 6. baselines (manifest only — see report for why no separate
  // frozen-content snapshot dir is written) ----
  for (const baseline of baselines) {
    const frozenIds = trueFrozenIds(baseline.baseline_id, baseline.frozen_requirement_ids, product.requirement_db)
    const items = frozenIds.map((id) => {
      const version = versionById.get(id)
      const itemPath = pathById.get(id)
      if (version === undefined || itemPath === undefined) {
        throw new Error(`migrate: baseline ${baseline.baseline_id} references unknown item '${id}'`)
      }
      const content = readFileSync(itemPath, 'utf8')
      return { id, version, content_hash: sha256Hex(content) }
    })
    const manifest = baselineManifestSchema.parse({
      id: baseline.baseline_id,
      date: toDateKey(baseline.date, baseline.baseline_id),
      wp_ids: [baseline.wp_ref],
      triggered_by: baseline.wp_ref,
      items,
      // No v1 field corresponds to either of these — v1 predates the
      // VERIFY-EVIDENCE artifact (§6.9) entirely. A plain, honest constant
      // (never a fabricated evidence-ref path) so nothing downstream ever
      // mistakes this for a real accept()-produced evidence trail.
      accepted_by: 'migrated-from-v1',
      verify_evidence_ref: 'migrated-from-v1 (no VERIFY-EVIDENCE artifact; predates the v2 harness)',
    })
    const path = join(outDir, 'baselines', baseline.baseline_id, 'manifest.yaml')
    atomicWrite(path, yamlStringify(manifest, { lineWidth: 0 }))
    written.push(path)
  }

  // ---- 7. seed .ba/counters.yaml from v1's _counters ----
  const counters = seedCounters(product, baselines)
  mkdirSync(join(outDir, '.ba'), { recursive: true })
  writeCounters(outDir, counters)
  written.push(join(outDir, '.ba', 'counters.yaml'))

  // ---- 8. seed .ba/config.yaml (canon-path scoping — see
  // `MIGRATED_CANON_ROOTS` above for what's listed and why) ----
  const configPath = join(outDir, '.ba', 'config.yaml')
  atomicWrite(configPath, yamlStringify({ canon_roots: [...MIGRATED_CANON_ROOTS] }, { lineWidth: 0 }))
  written.push(configPath)

  return { written }
}

function seedCounters(product: V1Product, baselines: readonly V1Baseline[]): Counters {
  const baselineSeq: Record<string, number> = {}
  for (const b of baselines) {
    const m = /^BL-(\d{8})(?:-(\d+))?$/.exec(b.baseline_id)
    if (!m) throw new Error(`migrate: cannot parse baseline id '${b.baseline_id}'`)
    // Non-null: the first capture group is unconditional (only the second,
    // the optional `-N` suffix, can be absent).
    const date = m[1]!
    const seq = m[2] !== undefined ? Number(m[2]) : 1
    baselineSeq[date] = Math.max(baselineSeq[date] ?? 0, seq)
  }
  const epics: Counters['epics'] = {}
  for (const epic of product.epics) {
    epics[epic.id] = { fr: epic._counters.fr, nfr: epic._counters.nfr, br: epic._counters.br }
  }
  return countersSchema.parse({
    product: {
      epic: product._counters.epic,
      cr: product._counters.cr,
      wp: product._counters.wp,
      // v1 has no bug tracking at all (client bugs are a v2-only concept —
      // design spec §6.7) — seeded at zero, never inferred.
      bug: 0,
      baselineSeq,
    },
    epics,
    retired: [],
  })
}

// ==========================================================================
// verifyParity — the parity checker
// ==========================================================================

/** Content extracted before the FIRST `## `-level heading — the "statement"
 * half of a page's body, excluding whatever the migrate step appended under
 * `## Acceptance Criteria` / `## Rationale`. Generic across fr/nfr/br: none
 * of those sections' internal wording is meant to participate in the
 * statement's own hash (ACs are hashed separately, for FR). */
function mdStatementOf(body: string): string {
  const lines = body.split('\n')
  const headingIndex = lines.findIndex((line) => NEXT_HEADING.test(line))
  const statementLines = headingIndex === -1 ? lines : lines.slice(0, headingIndex)
  return statementLines.join('\n')
}

/** Collapse to a single normalized line: trim each line, drop blank lines,
 * join with a single space. Both v1's `current.text`/`rule_text` and the
 * migrated body's own leading paragraph are single-paragraph prose, so this
 * is a robust, whitespace-insensitive equality check without needing a full
 * markdown-aware diff. */
function normalizeText(s: string): string {
  return s
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ')
    .trim()
}

function hashStatement(statement: string, acs: readonly string[] = []): string {
  const payload = JSON.stringify({ statement: normalizeText(statement), acs: acs.map(normalizeText) })
  return sha256Hex(payload)
}

function idSetCheck(name: string, expected: readonly string[], actual: readonly string[]): Check {
  const expectedSet = new Set(expected)
  const actualSet = new Set(actual)
  const missing = [...expectedSet].filter((id) => !actualSet.has(id)).sort(naturalCompare)
  const extra = [...actualSet].filter((id) => !expectedSet.has(id)).sort(naturalCompare)
  const ok = missing.length === 0 && extra.length === 0
  const parts: string[] = []
  if (missing.length > 0) parts.push(`missing: ${missing.join(', ')}`)
  if (extra.length > 0) parts.push(`extra: ${extra.join(', ')}`)
  return { name, ok, reason: ok ? `all ${expectedSet.size} id(s) present` : parts.join('; ') }
}

function setEquals(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((v) => b.has(v))
}

function readOutBaselineIds(outDir: string): string[] {
  const dir = join(outDir, 'baselines')
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

type OutBaselineManifest = ReturnType<typeof baselineManifestSchema.parse>

function readOutBaselineManifest(outDir: string, id: string): OutBaselineManifest | undefined {
  const path = join(outDir, 'baselines', id, 'manifest.yaml')
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  return baselineManifestSchema.parse(yamlParse(raw))
}

/**
 * Independently reconstructs both sides on every call — the v1 JSON parsed
 * fresh from `v1Dir`, the md canon via `writer.ts`'s `loadGraph(outDir)` —
 * and compares. Never trusts anything `migrate` may have cached; a hand-edit
 * to `outDir` after `migrate` ran (e.g. a reworded FR statement) is caught
 * exactly the same way a from-scratch parity run would catch it.
 */
export function verifyParity(v1Dir: string, outDir: string): Verdict {
  const product = readJson<V1Product>(join(v1Dir, 'product.json'))
  const brRegistry = readJson<V1BrRegistry>(join(v1Dir, 'br-registry.json'))
  const crs = readCrs(v1Dir)
  const baselines = readBaselines(v1Dir)
  const wps = readWps(v1Dir)

  const graph = loadGraph(outDir)
  const checks: Check[] = []

  const v1Frs = product.requirement_db.filter((r) => r.type === 'fr')
  const v1Nfrs = product.requirement_db.filter((r) => r.type === 'nfr')

  checks.push(
    idSetCheck(
      'epic-ids',
      product.epics.map((e) => e.id),
      graph.epics.map((n) => n.frontmatter.id)
    )
  )
  checks.push(
    idSetCheck(
      'fr-ids',
      v1Frs.map((r) => r.id),
      graph.frs.map((n) => n.frontmatter.id)
    )
  )
  checks.push(
    idSetCheck(
      'nfr-ids',
      v1Nfrs.map((r) => r.id),
      graph.nfrs.map((n) => n.frontmatter.id)
    )
  )
  checks.push(
    idSetCheck(
      'br-ids',
      brRegistry.rules.map((r) => r.id),
      graph.brs.map((n) => n.frontmatter.id)
    )
  )
  checks.push(
    idSetCheck(
      'cr-ids',
      crs.map((c) => c.id),
      graph.crs.map((n) => n.frontmatter.id)
    )
  )
  checks.push(
    idSetCheck(
      'baseline-ids',
      baselines.map((b) => b.baseline_id),
      readOutBaselineIds(outDir)
    )
  )
  checks.push(
    idSetCheck(
      'wp-ids',
      wps.map((w) => w.id),
      graph.wps.map((n) => n.frontmatter.id)
    )
  )

  // ---- per-item content-hash: normalized statement (+ AC text for FRs) ----
  const frById = new Map(graph.frs.map((n) => [n.frontmatter.id, n] as const))
  const frMismatches: string[] = []
  for (const req of v1Frs) {
    const node = frById.get(req.id)
    if (!node) continue // already reported by fr-ids above
    const v1Hash = hashStatement(splitStatementAndRationale(req.current.text).statement, req.current.acceptance_criteria)
    const mdAcs = [...parseAcBlock(node.body).acs].sort((a, b) => a.acId - b.acId).map((ac) => ac.text)
    const mdHash = hashStatement(mdStatementOf(node.body), mdAcs)
    if (v1Hash !== mdHash) frMismatches.push(req.id)
  }
  checks.push({
    name: 'fr-content-hash',
    ok: frMismatches.length === 0,
    reason: frMismatches.length === 0 ? 'every FR statement + AC text matches v1' : `reworded: ${frMismatches.join(', ')}`,
  })

  const nfrById = new Map(graph.nfrs.map((n) => [n.frontmatter.id, n] as const))
  const nfrMismatches: string[] = []
  for (const req of v1Nfrs) {
    const node = nfrById.get(req.id)
    if (!node) continue
    const v1Hash = hashStatement(splitStatementAndRationale(req.current.text).statement)
    const mdHash = hashStatement(mdStatementOf(node.body))
    if (v1Hash !== mdHash) nfrMismatches.push(req.id)
  }
  checks.push({
    name: 'nfr-content-hash',
    ok: nfrMismatches.length === 0,
    reason: nfrMismatches.length === 0 ? 'every NFR statement matches v1' : `reworded: ${nfrMismatches.join(', ')}`,
  })

  const brById = new Map(graph.brs.map((n) => [n.frontmatter.id, n] as const))
  const brMismatches: string[] = []
  for (const rule of brRegistry.rules) {
    const node = brById.get(rule.id)
    if (!node) continue
    const v1Hash = hashStatement(rule.current.rule_text)
    const mdHash = hashStatement(mdStatementOf(node.body))
    if (v1Hash !== mdHash) brMismatches.push(rule.id)
  }
  checks.push({
    name: 'br-content-hash',
    ok: brMismatches.length === 0,
    reason: brMismatches.length === 0 ? 'every BR statement matches v1' : `reworded: ${brMismatches.join(', ')}`,
  })

  // ---- baseline frozen-id lists ----
  const baselineMismatches: string[] = []
  for (const b of baselines) {
    const manifest = readOutBaselineManifest(outDir, b.baseline_id)
    if (!manifest) {
      baselineMismatches.push(`${b.baseline_id}: manifest missing`)
      continue
    }
    const expected = new Set(trueFrozenIds(b.baseline_id, b.frozen_requirement_ids, product.requirement_db))
    const actual = new Set(manifest.items.map((i) => i.id))
    if (!setEquals(expected, actual)) baselineMismatches.push(`${b.baseline_id}: frozen id list mismatch`)
  }
  checks.push({
    name: 'baseline-frozen-ids',
    ok: baselineMismatches.length === 0,
    reason: baselineMismatches.length === 0 ? 'every baseline frozen-id list matches v1' : baselineMismatches.join('; '),
  })

  // ---- WP fr_ids (v3: read via the Scope-body `wpDelivers` query — a WP's
  // delivered-FR set is no longer a frontmatter field, see migrate()'s WP
  // step above) ----
  const wpById = new Map(graph.wps.map((n) => [n.frontmatter.id, n] as const))
  const wpMismatches: string[] = []
  for (const wp of wps) {
    const node = wpById.get(wp.id)
    if (!node) {
      wpMismatches.push(`${wp.id}: not found in md canon`)
      continue
    }
    const expected = new Set(wp.frIds)
    const actual = new Set(graph.wpDelivers(wp.id))
    if (!setEquals(expected, actual)) wpMismatches.push(`${wp.id}: fr_ids mismatch`)
  }
  checks.push({
    name: 'wp-fr-ids',
    ok: wpMismatches.length === 0,
    reason: wpMismatches.length === 0 ? "every WP's fr_ids matches v1" : wpMismatches.join('; '),
  })

  const verdict: Verdict['verdict'] = checks.every((c) => c.ok) ? 'VERIFY-OK' : 'VERIFY-FAIL'
  return { verdict, checks }
}
