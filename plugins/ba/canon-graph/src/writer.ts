// ---- writer.ts: the SOLE canon mutator (design spec §7/§8a, §10 "single-
// writer") — mint (via ids.ts), stamp frontmatter (via serialize.ts's
// `emitPage`, never hand-serialized), archive superseded content into
// `## History`, and validate every status transition. Nothing else in this
// package (or its consumers) may write a canon page — skills/CLI verbs
// (Task 12+) commit exclusively through the functions below.
//
// **Determinism (repo-wide invariant):** this module never reads
// `Date.now()`/clock/RNG for a VALUE that ends up in a page — every date is
// a caller-supplied parameter, exactly like `ids.ts`'s `allocateBaselineId`
// and the wp-scope overload of `allocateId`. `editRequirement`/
// `setVisionConfirmed` stamp a date (`## History`'s `{date}` segment;
// `confirmed_at`) that the brief's own interface line doesn't spell out as a
// parameter — both take an explicit `date` for exactly this reason (see each
// function's doc comment for the call-site contract). The v3 CR mutators
// (`confirmCr`, `realizeCrSpawn`, Task 5) need no date of their own — neither
// stamps a `## History` entry or any other date-bearing field.
//
// **Atomicity:** every write goes through `atomicWrite` below — temp-file
// (same directory, so the rename is same-filesystem) + `renameSync`, the
// same pattern `ids.ts`'s `writeCounters` uses. A crash mid-write leaves
// either the old file or nothing (a stray `.tmp-*`), never a torn file.
//
// **History placement (pinned choice, §8a):** append-AT-TOP — the newest
// `### v{N} — {date} — {ref}` entry lands immediately under the `## History`
// heading, ahead of any older entries, so reading top-to-bottom is
// newest-first (matches a conventional CHANGELOG). `{ref}` is the CITING CR's
// id — v3 (Task 5) makes this universal: `editRequirement` requires a
// confirmed `--cr` for EVERY bump (active or baselined), and the heading
// always cites that CR, never the item's `baseline:` field (which stays
// untouched by a bump). The archived content is the PRIOR page's full body,
// embedded as an opaque string — never re-parsed, never re-flowed, except for
// ONE mechanical transform: `history.ts`'s `demoteHeadings` shifts its
// `##`/`###` headings down two levels (`####`/`#####`) before embedding, so a
// prior body that itself already carries a (nested) `## History` section from
// an earlier bump never collides with the live document's own heading levels.
// Entries nest across repeated edits — an intentional consequence of "the
// body is opaque, we never look inside it, we only demote its heading
// levels," not a bug.

import type { Dirent } from 'node:fs'
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, relative, sep } from 'node:path'
import { stringify as yamlStringify } from 'yaml'
import type { z } from 'zod'
import { allocateBaselineId, allocateId } from './ids.js'
import { archiveIntoHistory, formatHistoryHeading, historyCrRefs } from './history.js'
import { walkCanonFiles } from './fs.js'
import { parseFile, parsePage, peekType, type ParsedPage } from './parse.js'
import { emitPage, naturalCompare, type FrontmatterFor } from './serialize.js'
import { shouldBump } from './versiondiff.js'
import { buildGraph, type Graph, type GraphNode } from './graph.js'
import { acceptGate, type VerifyEvidence } from './gates.js'
import {
  mergeReferencesNfr,
  stripAllLeadingFrontmatter,
} from './body-refs.js'
import {
  BR_ID,
  CR_ID,
  EPIC_ID,
  FR_ID,
  NFR_ID,
  baselineManifestSchema,
  pendingMarkerSchema,
  schemas,
  verifyEvidenceSchema,
  type CrImpact,
} from './schema.js'
import type { NodeType, Status, Verdict } from './types.js'

// ==========================================================================
// path layout (§5 "Canon layout" — `repo` is the canon root, i.e. the
// directory that directly contains `.ba/`, `epics/`, `br/`, `cr/`, `wp/`).
// ==========================================================================

function visionPath(repo: string): string {
  return join(repo, 'vision.md')
}
function epicsRoot(repo: string): string {
  return join(repo, 'epics')
}
function brPath(repo: string, id: string): string {
  return join(repo, 'br', `${id}.md`)
}
/** Exported (unlike its sibling path helpers) because `reconcile.ts` needs it
 * to write a CR's `resolved` transition — `accept`'s own `import()` of
 * `reconcile.js` is dynamic specifically so `reconcile.ts` can statically
 * import THIS file without a circular top-level dependency (see this file's
 * header and `reconcile.ts`'s own header for the full rationale). */
export function crPath(repo: string, id: string): string {
  return join(repo, 'cr', `${id}.md`)
}
/** Exported (like `crPath`) — `cli.ts` imports this rather than keeping its
 * own private copy (Task 5's WP-path seam). v3: folder-per-item, matching
 * `epics/E{n}-slug/index.md`'s shape — `wp/<id>/index.md`, not a flat
 * `wp/<id>.md` file. */
export function wpPath(repo: string, id: string): string {
  return join(repo, 'wp', id, 'index.md')
}

/** Kebab-cases an epic title for its directory slug (`E{n}-slug/`, §6.8).
 * Never throws on pathological input (all-punctuation title, etc.) — falls
 * back to the literal `epic` slug rather than minting a directory with an
 * empty/malformed name segment. */
function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug === '' ? 'epic' : slug
}

/** Resolves `epics/E{n}-slug/` for an already-minted epic id by listing
 * `epics/` and matching the `E{n}` prefix — the slug itself is never stored
 * anywhere else, so this directory listing is the only way back to it. Not
 * a corpus-wide scan (ids.ts's `maxGuard` caveat doesn't apply here): this
 * reads one directory's immediate children, not the page corpus. */
function findEpicDir(repo: string, epicId: string): string {
  const root = epicsRoot(repo)
  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    throw new Error(`writer: no epics directory under ${repo} (looking for ${epicId})`)
  }
  const match = entries.find((e) => e.isDirectory() && (e.name === epicId || e.name.startsWith(`${epicId}-`)))
  if (!match) throw new Error(`writer: no epic directory found for ${epicId} under ${root}`)
  return join(root, match.name)
}

function epicOfRequirementId(id: string): string {
  const m = /^(E\d+)-/.exec(id)
  if (!m) throw new Error(`writer: cannot derive an epic id from ${id}`)
  // Non-null: the regex has exactly one unconditional capture group.
  return m[1]!
}

function requirementFilePath(repo: string, type: 'fr' | 'nfr', epicId: string, id: string): string {
  return join(findEpicDir(repo, epicId), `${id}.md`)
}

type RequirementType = 'fr' | 'nfr' | 'br'

function requirementTypeOf(id: string): RequirementType {
  if (FR_ID.test(id)) return 'fr'
  if (NFR_ID.test(id)) return 'nfr'
  if (BR_ID.test(id)) return 'br'
  throw new Error(`writer: ${id} is not a requirement id (expected an FR/NFR/BR id)`)
}

/** Resolves an already-minted requirement's on-disk path from its id alone
 * (used by every mutator that takes just an `id`: `editRequirement`,
 * `retireRequirement`, `setStatus`). BR is flat under `br/`; FR/NFR live
 * inside their epic's slugged directory (`findEpicDir`). */
function pathForRequirement(repo: string, id: string): { type: RequirementType; path: string } {
  const type = requirementTypeOf(id)
  if (type === 'br') return { type, path: brPath(repo, id) }
  return { type, path: requirementFilePath(repo, type, epicOfRequirementId(id), id) }
}

// ==========================================================================
// atomic write — the ONE place any byte reaches disk in this module.
// ==========================================================================

/** Exported for `reconcile.ts` — see `crPath`'s doc comment for why that
 * module needs a direct, non-circular import of writer.ts's own primitives
 * rather than re-implementing them. */
export function atomicWrite(path: string, content: string): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.tmp-${process.pid}-${randomUUID()}`)
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, path)
}

/** `emitPage`'s generic type parameter must be a compile-time literal to
 * infer the right `FrontmatterFor<T>`; fr/nfr/br dispatch happens over a
 * runtime-determined `RequirementType`, so this is the one narrow, explicit,
 * non-`any` dispatch point that bridges the two (same boundary-widening
 * pattern as `graph.ts`'s per-type push calls and `ids.ts`'s `idOf`). */
function emitRequirement(type: RequirementType, frontmatter: Record<string, unknown>, body: string): string {
  switch (type) {
    case 'fr':
      return emitPage('fr', frontmatter as unknown as FrontmatterFor<'fr'>, body)
    case 'nfr':
      return emitPage('nfr', frontmatter as unknown as FrontmatterFor<'nfr'>, body)
    case 'br':
      return emitPage('br', frontmatter as unknown as FrontmatterFor<'br'>, body)
  }
}

// ==========================================================================
// status-transition legality (§7 unified fr/nfr/br enum) — used by
// `setStatus`/`retireRequirement`. `editRequirement`'s own `activate` rule
// is intentionally narrower than this general matrix (see that function's
// comment) so it is NOT routed through here.
// ==========================================================================

/** Shared `YYYYMMDD` date-shape guard (finding #19) — this module's own two
 * date-taking mutators (`editRequirement`'s CR-bump path, `accept`) both
 * validate against it BEFORE any write, rather than each keeping a private
 * copy (or worse, relying solely on a downstream module's later check —
 * `reconcile.ts`'s own `DATE_KEY`, which fires too late for a bump that's
 * already landed on disk by the time `reconcileCrs` runs). */
const DATE_KEY = /^\d{8}$/

const LEGAL_TRANSITIONS: Record<Status, ReadonlySet<Status>> = {
  // draft → batched: allowed so `wp prepare` can batch freshly authored
  // members that were never activated; prefer activate-first in skills.
  draft: new Set<Status>(['active', 'batched', 'retired']),
  active: new Set<Status>(['batched', 'retired']),
  // batched -> active is the `wp abandon` revert edge (§7); batched ->
  // baselined is `accept` (§8a). Both are future (Task 11+) call sites of
  // this same matrix, not exercised by any Task 10 verb, but pinned here now
  // so `setStatus` is correct for them without a later revisit.
  batched: new Set<Status>(['baselined', 'active', 'retired']),
  // A content edit to a baselined item never changes its *status* (see
  // `editRequirement`) — the only legal bare status transition off
  // `baselined` is a soft retire. Supersede/split (a NEW id, this one ->
  // `superseded`) is a distinct, not-yet-built verb — deliberately out of
  // Task 10's scope (no interface name was given for it); `superseded` is
  // therefore not a legal target of `setStatus` from anywhere yet.
  baselined: new Set<Status>(['retired']),
  superseded: new Set<Status>([]),
  retired: new Set<Status>([]),
}

function assertLegalTransition(id: string, from: Status, to: Status): void {
  if (from === to) throw new Error(`writer: ${id} is already '${to}'`)
  if (!LEGAL_TRANSITIONS[from].has(to)) {
    throw new Error(`writer: illegal status transition for ${id}: '${from}' -> '${to}'`)
  }
}

/** `--cr`'s full write-time guard (finding #1): `crId` must be `confirmed`
 * (as before) AND — since `impacts` is reconcile's ONLY source of truth for
 * "what this CR touches" (reconcile.ts's own header) — its own `entry_point`
 * must be `'requirement'` (a `vision`-entry CR, required to carry an EMPTY
 * impacts set, can never drive a requirement edit) AND its `impacts` array
 * must contain an `{amends: reqId}` entry naming THIS SPECIFIC requirement.
 * Without this, any confirmed CR of any kind — including an unrelated one —
 * could be cited to falsely amend any FR/NFR/BR with no cross-check. */
function assertConfirmedCr(repo: string, crId: string, reqId: string): void {
  if (!CR_ID.test(crId)) throw new Error(`writer: ${crId} is not a valid CR id`)
  const parsed = parseFile(crPath(repo, crId), 'cr')
  if ('error' in parsed) throw new Error(`writer: cannot read CR ${crId}: ${parsed.error}`)
  const fm = parsed.frontmatter as Record<string, unknown>
  const status = fm.status
  if (status !== 'confirmed') {
    throw new Error(`writer: CR ${crId} must be 'confirmed' to drive a requirement edit (was '${String(status)}')`)
  }
  if (fm.entry_point !== 'requirement') {
    throw new Error(
      `writer: CR ${crId} has entry_point '${String(fm.entry_point)}', not 'requirement' — it cannot drive an edit to ${reqId}`
    )
  }
  const impacts = (fm.impacts as CrImpact[] | undefined) ?? []
  const amendsThis = impacts.some((impact) => 'amends' in impact && impact.amends === reqId)
  if (!amendsThis) {
    throw new Error(`writer: CR ${crId}'s impacts do not declare an 'amends' entry for ${reqId} — it cannot drive this edit`)
  }
}

// ==========================================================================
// public mutators — the seven names Task 11/the CLI (Task 12) depend on.
// ==========================================================================

export type AddRequirementInput =
  | {
      epic: string
      type: 'fr'
      body: string
      refs?: { tracesTo?: string[]; enforces?: string[]; referencesNfr?: string[]; related?: string[] }
    }
  | { epic: string; type: 'nfr'; body: string; refs?: { tracesTo?: string[]; verifiedBy?: string[]; related?: string[] } }
  | { epic: string; type: 'br'; body: string; refs?: { kind?: 'structural' | 'operative'; enforcement?: 'advisory' | 'hard' } }

export type AddRequirementResult = { id: string; path: string }

/** Mints an FR/NFR/BR under `epic` (via `ids.ts`'s per-epic counter), writes
 * `status: draft`, `version: 1`. A malformed `epic` id is rejected before
 * minting; an `epic` that mints fine but has no directory on disk yet burns
 * the id and throws on write — the same "gaps allowed, reuse forbidden"
 * failure mode `ids.ts` documents for any post-mint write failure. */
export async function addRequirement(repo: string, input: AddRequirementInput): Promise<AddRequirementResult> {
  const { epic, body } = input
  if (!EPIC_ID.test(epic)) throw new Error(`writer: ${epic} is not a valid epic id`)
  const id = await allocateId(repo, { kind: input.type, epic })

  let type: RequirementType
  let frontmatter: Record<string, unknown>
  switch (input.type) {
    case 'fr': {
      type = 'fr'
      const refs = input.refs ?? {}
      frontmatter = {
        id,
        type: 'fr',
        epic,
        status: 'draft',
        version: 1,
        traces_to: refs.tracesTo ?? [],
        enforces: refs.enforces ?? [],
        references_nfr: refs.referencesNfr ?? [],
        related: refs.related ?? [],
      }
      break
    }
    case 'nfr': {
      type = 'nfr'
      const refs = input.refs ?? {}
      frontmatter = {
        id,
        type: 'nfr',
        epic,
        status: 'draft',
        version: 1,
        traces_to: refs.tracesTo ?? [],
        verified_by: refs.verifiedBy ?? [],
        related: refs.related ?? [],
      }
      break
    }
    case 'br': {
      type = 'br'
      const refs = input.refs ?? {}
      frontmatter = {
        id,
        type: 'br',
        epic,
        kind: refs.kind ?? 'operative',
        enforcement: refs.enforcement ?? 'advisory',
        status: 'draft',
        version: 1,
      }
      break
    }
  }

  const path = type === 'br' ? brPath(repo, id) : requirementFilePath(repo, type, epic, id)
  atomicWrite(path, emitRequirement(type, frontmatter, body))
  return { id, path }
}

export type EditRequirementInput = {
  id: string
  body: string
  cr?: string
  activate?: boolean
  /** Required (throws if omitted) only when a `cr`-driven edit actually bumps
   * (`shouldBump` true) — v3 (Task 5): that's ANY `cr` edit that changes
   * content, active or baselined alike, not just a baselined one. It feeds
   * the `## History` entry's `{date}` segment. Never read from the clock
   * (determinism, file header); not in the brief's terse interface line but
   * required by its own "dates are injected params" constraint. */
  date?: string
}

export type EditRequirementResult = { id: string; path: string; bumped: boolean }

/** In-place edit of an FR/NFR/BR body.
 *
 * **v3 (Task 5): the CR-driven version bump is UNIVERSAL, not baselined-only**
 * — `--cr` is now legal against BOTH an `active` item and a `baselined` one
 * (previously only the latter). Passing `cr` always means "this edit is a
 * CR-driven amendment": it requires the CR to be `confirmed`
 * (`assertConfirmedCr`), it requires the edit to actually change content
 * (`shouldBump` — a no-op `--cr` edit is rejected outright, since a CR-driven
 * edit that changes nothing can't be a real amendment), and on a genuine
 * change it archives the PRIOR body verbatim into `## History`
 * (`archiveIntoHistory`), increments `version`, and — for an FR/NFR — appends
 * `cr` to `traces_to` (deduped, so re-amending the same item against the same
 * CR twice doesn't duplicate the ref). The `## History` heading always cites
 * the CR id (`formatHistoryHeading(oldVersion, date, cr)`), never the item's
 * `baseline:` field — which itself stays completely untouched by a bump (a
 * supersede/split, out of this function's scope, is the only thing that ever
 * changes `baseline:`). `cr` is illegal against a `draft` item outright (draft
 * authoring is free-form; a CR-driven edit there would fabricate an
 * amendment that never happened), and mandatory (throws if omitted) against a
 * `baselined` item (the v2 rule, unchanged). A non-CR edit of an `active` or
 * `draft` item remains completely free-form, exactly as before: rewritten in
 * place with no version bump, ever. `batched`/`superseded`/`retired` sources
 * and an `activate` on anything but `draft` are rejected outright (illegal
 * transitions, per the task's global constraint).
 *
 * **Reconcile trigger (gap fix, post-Task-6):** an `{amends: id}` impact is
 * REALIZED the instant the CR-cited bump lands on a page that is ALREADY
 * `baselined` — so once the write above succeeds, if this edit actually
 * bumped (`bumped === true`) AND the item's status AT ENTRY was `baselined`
 * AND a `cr` was given, this function fires `reconcileCrs(repo, [cr],
 * bumpDate)` itself (dynamic `import('./reconcile.js')`, the exact pattern
 * `accept` uses — see that function's own doc comment for why the import is
 * dynamic). Without this, a CR whose ONLY impact is an amend of an
 * already-baselined item would never auto-resolve: nothing about a bare
 * `editRequirement` bump on a baselined page routes through `accept`, which
 * was previously reconcile's one and only caller. A bump on an `active`
 * item deliberately does NOT fire reconcile here — an amend isn't
 * "delivered" yet while its target is still active (`reconcileCrs`'s own
 * predicate requires `baselined`); that item's eventual `accept` is what
 * reconciles the CR later, same as any other batched item. */
export async function editRequirement(repo: string, input: EditRequirementInput): Promise<EditRequirementResult> {
  const { id, cr, activate, date } = input
  // Strip a leading FM fence so `--body-file` may be a full page without
  // creating a second YAML block on emit (acceptance defect).
  const body = stripAllLeadingFrontmatter(input.body)
  const { type, path } = pathForRequirement(repo, id)
  const parsed = parseFile(path, type)
  if ('error' in parsed) throw new Error(`writer: failed to read ${id} at ${path}: ${parsed.error}`)

  const fm = parsed.frontmatter as Record<string, unknown>
  const currentStatus = fm.status as Status

  if (currentStatus === 'batched') {
    throw new Error(`writer: cannot edit ${id} in place — status is 'batched' (frozen pending accept/abandon)`)
  }
  if (currentStatus === 'superseded' || currentStatus === 'retired') {
    throw new Error(`writer: cannot edit ${id} — status '${currentStatus}' is terminal`)
  }
  if (activate === true && currentStatus !== 'draft') {
    throw new Error(`writer: cannot activate ${id} — status is '${currentStatus}', not 'draft'`)
  }

  const nextFm: Record<string, unknown> = { ...fm }
  let nextBody = body
  let bumped = false
  let bumpDate: string | undefined

  if (cr !== undefined && currentStatus === 'draft') {
    throw new Error(`writer: ${id} is a draft — draft authoring is free-form; do not pass --cr (it would fabricate an amendment)`)
  }
  if (currentStatus === 'baselined' && cr === undefined) {
    throw new Error(`writer: editing baselined ${id} requires a confirmed --cr`)
  }
  if (cr !== undefined) {
    assertConfirmedCr(repo, cr, id)
    bumped = shouldBump(type, { frontmatter: fm, body: parsed.body }, { frontmatter: fm, body })
    if (!bumped) {
      throw new Error(`writer: no content change to ${id} against ${cr} — a CR-driven edit must change the requirement (spec §4)`)
    }
    if (!date) throw new Error(`writer: bumping ${id} requires a date`)
    // finding #19: shape-validate BEFORE any write — `reconcileCrs`'s OWN
    // date guard (reconcile.ts) fires too late (after `atomicWrite` below has
    // already landed), permanently baking a malformed date into a History
    // heading. Catching it here means NOTHING is written on a bad date.
    if (!DATE_KEY.test(date)) {
      throw new Error(`writer: bumping ${id} requires a YYYYMMDD date, got ${JSON.stringify(date)}`)
    }
    bumpDate = date
    const oldVersion = fm.version as number
    const heading = formatHistoryHeading(oldVersion, bumpDate, cr)
    nextBody = archiveIntoHistory(body, heading, parsed.body)
    nextFm.version = oldVersion + 1
    if (type === 'fr' || type === 'nfr') {
      const traces = (fm.traces_to as string[] | undefined) ?? []
      if (!traces.includes(cr)) nextFm.traces_to = [...traces, cr]
    }
  }

  if (activate === true) {
    nextFm.status = 'active'
  }

  // Keep references_nfr aligned with explicit NFR mentions in the body
  // (canon E#-NFR# and project-catalogue KEY-NFR-NNN).
  if (type === 'fr') {
    nextFm.references_nfr = mergeReferencesNfr(
      nextFm.references_nfr as string[] | undefined,
      nextBody,
    )
  }

  // Heal a body that still starts with a YAML fence (duplicate-frontmatter
  // smell from a prior bad edit) — never re-emit a second block.
  nextBody = stripAllLeadingFrontmatter(nextBody)

  atomicWrite(path, emitRequirement(type, nextFm, nextBody))

  // Gap fix (post-Task-6): fire reconcile from HERE for a bump that lands on
  // an item that was ALREADY baselined at entry — see this function's own
  // doc comment for the full rationale. `bumpDate !== undefined` narrows the
  // dynamic-import call's date param without a non-null assertion; it is
  // always set whenever `bumped` is true (both are only ever set together,
  // inside the `cr !== undefined` branch above).
  if (bumped && currentStatus === 'baselined' && cr !== undefined && bumpDate !== undefined) {
    const { reconcileCrs } = await import('./reconcile.js')
    reconcileCrs(repo, [cr], bumpDate)
  }

  return { id, path, bumped }
}

export type RetireRequirementResult = { id: string; path: string }

/** Soft-retire: `status: retired` (terminal). Delegates to `setStatus` so
 * the legal-transition matrix lives in exactly one place. */
export async function retireRequirement(repo: string, id: string): Promise<RetireRequirementResult> {
  return setStatus(repo, id, 'retired')
}

export type AddEpicResult = { id: string }

/** Mints `E#` and writes `epics/E#-slug/index.md` from a minimal template
 * (`status: active`, empty body — the brief's interface takes only a
 * `title`, no body/description param). */
export async function addEpic(repo: string, title: string): Promise<AddEpicResult> {
  const id = await allocateId(repo, { kind: 'epic' })
  const dir = join(epicsRoot(repo), `${id}-${slugify(title)}`)
  const path = join(dir, 'index.md')
  const frontmatter = { id, type: 'epic', title, status: 'active' }
  atomicWrite(path, emitPage('epic', frontmatter as unknown as FrontmatterFor<'epic'>, ''))
  return { id }
}

export type SetStatusResult = { id: string; path: string }

/** Generic validated status transition for an FR/NFR/BR (the unified §7
 * enum) — the one place `LEGAL_TRANSITIONS` is enforced against live canon.
 * Body is untouched; only `status` changes. */
export async function setStatus(repo: string, id: string, status: Status): Promise<SetStatusResult> {
  const { type, path } = pathForRequirement(repo, id)
  const parsed = parseFile(path, type)
  if ('error' in parsed) throw new Error(`writer: failed to read ${id} at ${path}: ${parsed.error}`)
  const fm = parsed.frontmatter as Record<string, unknown>
  const currentStatus = fm.status as Status
  assertLegalTransition(id, currentStatus, status)
  const nextFm: Record<string, unknown> = { ...fm, status }
  let nextBody = stripAllLeadingFrontmatter(parsed.body)
  if (type === 'fr') {
    nextFm.references_nfr = mergeReferencesNfr(
      nextFm.references_nfr as string[] | undefined,
      nextBody,
    )
  }
  atomicWrite(path, emitRequirement(type, nextFm, nextBody))
  return { id, path }
}

export type SetVisionConfirmedResult = { path: string }

/** Sets `product/vision.md` `status: confirmed`, `confirmed_at: date`,
 * `confirmed_by: by`. `date` is a 3rd, explicit param beyond the brief's
 * `(repo, by)` line, for the same determinism reason as `editRequirement`'s
 * `date` — `confirmed_at` cannot be stamped without SOME date, and this
 * module never reads the clock. Rejects re-confirming an already-confirmed
 * vision (no legal transition back to `draft` exists, so `confirmed` is
 * terminal here too). */
export async function setVisionConfirmed(repo: string, by: string, date: string): Promise<SetVisionConfirmedResult> {
  const path = visionPath(repo)
  const parsed = parseFile(path, 'vision')
  if ('error' in parsed) throw new Error(`writer: failed to read vision at ${path}: ${parsed.error}`)
  const fm = parsed.frontmatter as Record<string, unknown>
  if (fm.status === 'confirmed') throw new Error('writer: vision is already confirmed')
  const nextFm = { ...fm, status: 'confirmed', confirmed_at: date, confirmed_by: by }
  atomicWrite(path, emitPage('vision', nextFm as unknown as FrontmatterFor<'vision'>, parsed.body))
  return { path }
}

// ==========================================================================
// corpus loading — the full-repo read side `accept`/`reconcileCrs` need to
// build a `Graph` from live disk state (to run `acceptGate` and to walk
// `closure`/`crSpawned`). No earlier task built a general corpus walker
// (`ids.ts`'s `maxGuard` is id-focused and takes pages as a parameter rather
// than reading them itself); `validate` (Task 12) will likely want the same
// capability, so this is exported rather than kept file-private.
// ==========================================================================

/** Builds a `Graph` from every parseable `.md` page under `repo`'s canon
 * roots (`fs.ts`'s `walkCanonFiles` — scoped to `<repo>/.ba/config.yaml`'s
 * `canon_roots` when present, else the whole repo minus `.ba/`+
 * `baselines/`, the original pre-scoping default). A page whose `type`
 * doesn't resolve to a known `NodeType`, or that fails `parsePage`'s schema
 * validation, is silently skipped — the same tolerance `graph.ts`'s own
 * `nodeTypeOf` already has for an unrecognized/malformed frontmatter shape.
 * Validating the WHOLE corpus end-to-end is `validate`'s job (Task 12), not
 * this loader's — `accept`/`reconcileCrs` only need the ids relevant to a
 * given WP/CR to resolve correctly, and a malformed unrelated page simply
 * won't resolve (surfacing as "not found" wherever it's looked up, same as
 * any other missing id).
 *
 * v3 (Task 4): also builds the `paths` map `buildGraph`'s second argument
 * takes — each page's CANON-RELATIVE path (`relative(repo, file)`, separators
 * normalized to `/` so a Windows-run CLI still produces the POSIX-style paths
 * a WP's `## Scope` links use), keyed by the exact `ParsedPage` object pushed
 * into `pages` — so `graph.pathOf(id)` resolves for every page this loader
 * reads. */
export function loadGraph(repo: string): Graph {
  const files = walkCanonFiles(repo)
  const pages: ParsedPage[] = []
  const paths = new Map<ParsedPage, string>()
  for (const file of files) {
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const type = peekType(raw)
    // Narrowing point (same boundary-widening pattern as graph.ts's
    // `nodeTypeOf`/ids.ts's `idOf`): `type in schemas` proves `type` is one
    // of `schemas`'s own keys, which are exactly `NodeType` — safe to cast.
    if (type === undefined || !(type in schemas)) continue
    const parsed = parsePage(raw, type as NodeType)
    if ('error' in parsed) continue
    pages.push(parsed)
    paths.set(parsed, relative(repo, file).split(sep).join('/'))
  }
  return buildGraph(pages, paths)
}

// ==========================================================================
// v3 CR mutators (Task 5) — `confirmCr`/`realizeCrSpawn` both need a live
// `Graph` (`loadGraph`, just above) to resolve an impact's `amends`/`spawns`
// target, so they're defined here rather than up in the "public mutators"
// section above. `cli.ts`'s OWN `cr confirm` verb keeps its current inline
// implementation this task (composed from the same exported primitives, per
// that file's header) — Task 8 rewires it onto `confirmCr` below.
// ==========================================================================

export type ConfirmCrInput = { crId: string; entry: 'vision' | 'requirement'; impacts?: CrImpact[] }
export type ConfirmCrResult = { id: string; path: string }

/** The CR entry-point human gate (design spec §7's "confirm CR entry-point"):
 * flips a `captured` CR to `confirmed`, stamping `entry_point`,
 * `entry_point_confirmed: true`, and (for `entry: 'requirement'`) its typed
 * `impacts` set (schema.ts's `CrImpact`, Task 1).
 *
 * Requires the CR to be `captured` (the one legal source state — confirming
 * an already-`confirmed`/`resolved` CR, or one that doesn't exist, throws).
 * `entry: 'requirement'` requires a NON-EMPTY `impacts` array, each entry
 * resolving against a FRESH `loadGraph(repo)` read: an `amends` impact's id
 * must already exist as a FR/NFR/BR; a `spawns` impact's `epic` must already
 * exist. `entry: 'vision'` is the inverse — `impacts` must be absent or
 * empty (a vision-level CR amends/spawns nothing yet; that's what
 * `entry: 'requirement'` is for). Neither branch inspects `realized` — a
 * spawn's realized id is stamped later, by `realizeCrSpawn`, once the actual
 * page has been minted. */
export async function confirmCr(repo: string, input: ConfirmCrInput): Promise<ConfirmCrResult> {
  const { crId, entry, impacts } = input
  const path = crPath(repo, crId)
  const parsed = parseFile(path, 'cr')
  if ('error' in parsed) throw new Error(`writer: cannot read CR ${crId}: ${parsed.error}`)
  const fm = parsed.frontmatter as Record<string, unknown>
  if (fm.status !== 'captured') {
    throw new Error(`writer: CR ${crId} must be 'captured' to confirm (was '${String(fm.status)}')`)
  }

  if (entry === 'requirement') {
    if (!impacts || impacts.length === 0) {
      throw new Error(`writer: confirming ${crId} as entry 'requirement' requires a non-empty impacts set`)
    }
    const graph = loadGraph(repo)
    const reqIds = new Set<string>([
      ...graph.frs.map((n) => n.frontmatter.id),
      ...graph.nfrs.map((n) => n.frontmatter.id),
      ...graph.brs.map((n) => n.frontmatter.id),
    ])
    const epicIds = new Set<string>(graph.epics.map((e) => e.frontmatter.id))
    for (const impact of impacts) {
      if ('amends' in impact) {
        if (!reqIds.has(impact.amends)) {
          throw new Error(`writer: confirming ${crId} — impact amends '${impact.amends}' does not resolve in the graph`)
        }
      } else if (!epicIds.has(impact.epic)) {
        throw new Error(`writer: confirming ${crId} — impact spawns a '${impact.spawns}' under epic '${impact.epic}', which does not exist`)
      }
    }
  } else if (impacts !== undefined && impacts.length > 0) {
    throw new Error(`writer: confirming ${crId} as entry 'vision' must not carry impacts (impacts are a 'requirement'-entry concept)`)
  }

  const nextFm: Record<string, unknown> = { ...fm, entry_point: entry, entry_point_confirmed: true, status: 'confirmed' }
  if (impacts !== undefined) nextFm.impacts = impacts
  atomicWrite(path, emitPage('cr', nextFm as unknown as FrontmatterFor<'cr'>, parsed.body))
  return { id: crId, path }
}

export type RealizeCrSpawnInput = { crId: string; epic: string; type: 'fr' | 'nfr' | 'br'; newId: string }
export type RealizeCrSpawnResult = { id: string; path: string }

/** Stamps `realized: newId` on a CR's FIRST un-realized `{spawns: type, epic}`
 * impact entry — the follow-up to `confirmCr`'s `entry: 'requirement'`
 * spawns, run once the actual FR/NFR/BR page for that spawn has been minted
 * (`addRequirement`) elsewhere. "First" matters when a CR spawns more than
 * one item of the same `{type, epic}` shape: each `realizeCrSpawn` call
 * claims the next still-un-realized one, in the impact array's own order —
 * never re-stamps an already-`realized` entry.
 *
 * Throws if no impact entry matches `{spawns: type, epic}` with `realized`
 * still unset. Otherwise validates `newId` against a fresh `loadGraph(repo)`:
 * the page must exist as the right node type, and — for `fr`/`nfr` (a `br`
 * has no `traces_to` field to check) — its `traces_to` must already include
 * `crId`, proving the amendment actually landed before the CR's own record of
 * it is stamped.
 *
 * Three additional write-time guards (findings #4/#5/#8) close gaps a
 * one-shot migration backfill (which bypasses this function entirely) could
 * otherwise leave uncaught:
 *   - #4: `newId` may not ALREADY be the `realized` value of some OTHER
 *     impact entry on this same CR — the same real page can't double-count
 *     as two distinct declared spawns.
 *   - #5: `newId`'s own id-shape (`FR_ID`/`NFR_ID`/`BR_ID`) must match `type`
 *     (equivalently, the impact's own `spawns` field, since `idx` above only
 *     ever matches an entry where `impact.spawns === type`).
 *   - #8: `newId`'s own epic (`epicOfRequirementId`) must match the impact's
 *     declared `epic` argument — a same-shape id minted under the WRONG epic
 *     must never be stamped as this spawn's realization. */
export async function realizeCrSpawn(repo: string, input: RealizeCrSpawnInput): Promise<RealizeCrSpawnResult> {
  const { crId, epic, type, newId } = input
  const path = crPath(repo, crId)
  const parsed = parseFile(path, 'cr')
  if ('error' in parsed) throw new Error(`writer: cannot read CR ${crId}: ${parsed.error}`)
  const fm = parsed.frontmatter as Record<string, unknown>
  const impacts = ((fm.impacts as CrImpact[] | undefined) ?? []).slice()

  const idx = impacts.findIndex(
    (impact) => 'spawns' in impact && impact.spawns === type && impact.epic === epic && impact.realized === undefined
  )
  if (idx === -1) {
    throw new Error(`writer: ${crId} has no un-realized '${type}' spawn under ${epic} to realize as ${newId}`)
  }

  // #4: reject if `newId` already realizes a DIFFERENT impact entry on `crId`.
  const realizesElsewhere = impacts.some((impact, i) => i !== idx && 'spawns' in impact && impact.realized === newId)
  if (realizesElsewhere) {
    throw new Error(`writer: realizeCrSpawn — ${newId} already realizes a different impact entry on ${crId}`)
  }

  // #5: `newId`'s own id-shape must match the impact's declared spawns type.
  const idClass = type === 'fr' ? FR_ID : type === 'nfr' ? NFR_ID : BR_ID
  if (!idClass.test(newId)) {
    throw new Error(`writer: realizeCrSpawn — ${newId} is not a valid '${type}' id`)
  }

  // #8: `newId`'s own epic must match the impact's declared epic.
  const newIdEpic = epicOfRequirementId(newId)
  if (newIdEpic !== epic) {
    throw new Error(
      `writer: realizeCrSpawn — ${newId}'s epic ('${newIdEpic}') does not match the impact's declared epic '${epic}'`
    )
  }

  const graph = loadGraph(repo)
  const node =
    type === 'fr'
      ? graph.frs.find((n) => n.frontmatter.id === newId)
      : type === 'nfr'
        ? graph.nfrs.find((n) => n.frontmatter.id === newId)
        : graph.brs.find((n) => n.frontmatter.id === newId)
  if (!node) throw new Error(`writer: realizeCrSpawn — ${newId} does not resolve to a '${type}' page in the graph`)
  if (type !== 'br' && !(node as GraphNode<'fr'> | GraphNode<'nfr'>).frontmatter.traces_to.includes(crId)) {
    throw new Error(`writer: realizeCrSpawn — ${newId}'s traces_to does not include ${crId}`)
  }

  const nextImpacts = impacts.map((impact, i) => (i === idx ? { ...impact, realized: newId } : impact))
  const nextFm: Record<string, unknown> = { ...fm, impacts: nextImpacts }
  atomicWrite(path, emitPage('cr', nextFm as unknown as FrontmatterFor<'cr'>, parsed.body))
  return { id: crId, path }
}

function readVisionConfirmed(repo: string): boolean {
  const parsed = parseFile(visionPath(repo), 'vision')
  if ('error' in parsed) return false
  return (parsed.frontmatter as { status?: unknown }).status === 'confirmed'
}

function setWpAccepted(repo: string, wpId: string): void {
  const path = wpPath(repo, wpId)
  const parsed = parseFile(path, 'wp')
  if ('error' in parsed) throw new Error(`writer: accept failed to read WP ${wpId} at ${path}: ${parsed.error}`)
  const fm = parsed.frontmatter as Record<string, unknown>
  const nextFm = { ...fm, status: 'accepted' }
  atomicWrite(path, emitPage('wp', nextFm as unknown as FrontmatterFor<'wp'>, parsed.body))
}

function byId<T extends { frontmatter: { id: string } }>(nodes: readonly T[]): Map<string, T> {
  return new Map(nodes.map((n) => [n.frontmatter.id, n] as const))
}

function baselinesRoot(repo: string): string {
  return join(repo, 'baselines')
}

function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

// ==========================================================================
// pending marker — the durable write-ahead transaction record (§8a crash
// safety). Written (atomically) BEFORE any item/baseline write; deleted as
// the LAST step of a completed accept. Its presence — keyed to the WP id —
// is the SOLE proof a transaction is mid-flight and must be resumed; resume
// reads `baselineId`/`deliveredIds` straight OUT of it, never re-inferring
// them from directory/filename shape (the defect the review flagged). A
// committed baseline has NO marker; a different WP's crash has a marker
// keyed to THAT WP — so neither is ever adopted or overwritten by an
// unrelated accept.
// ==========================================================================

type PendingMarker = z.infer<typeof pendingMarkerSchema>

function cacheDir(repo: string): string {
  return join(repo, '.ba', 'cache')
}

/** `<repo>/.ba/cache/pending-<wpId>.json` — the marker path for one WP's
 * in-flight accept. Exported (like `crPath`/`atomicWrite`/`loadGraph`) so
 * `validate` (Task 12) can locate an orphaned marker as a partial-state
 * signal, and so tests can assert marker presence/absence directly. */
export function pendingMarkerPath(repo: string, wpId: string): string {
  return join(cacheDir(repo), `pending-${wpId}.json`)
}

/** Reads + zod-validates a WP's pending marker; `undefined` if none exists.
 * A present-but-corrupt/tampered marker throws (never silently coerced) —
 * same posture as `ids.ts`'s `readCounters`. */
function readPendingMarker(repo: string, wpId: string): PendingMarker | undefined {
  const path = pendingMarkerPath(repo, wpId)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined // ENOENT (no in-flight transaction) is the normal case
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`writer: pending marker ${path} is not valid JSON`)
  }
  const result = pendingMarkerSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    throw new Error(`writer: pending marker ${path} failed validation: ${issues.join('; ')}`)
  }
  // Defensive: the marker's own `wpId` must match the WP it was read for — a
  // misplaced/copied marker file (e.g. `pending-WP-A.json` whose body names
  // WP-B) must never be allowed to drive the wrong WP's transaction.
  if (result.data.wpId !== wpId) {
    throw new Error(`writer: pending marker ${path} is for ${result.data.wpId}, not ${wpId}`)
  }
  return result.data
}

function writePendingMarker(repo: string, marker: PendingMarker): void {
  atomicWrite(pendingMarkerPath(repo, marker.wpId), `${JSON.stringify(marker, null, 2)}\n`)
}

/** Best-effort delete (a completed transaction's LAST step). Absence is fine
 * — a redundant delete on a resumed-and-completed transaction is a no-op. */
function deletePendingMarker(repo: string, wpId: string): void {
  try {
    unlinkSync(pendingMarkerPath(repo, wpId))
  } catch {
    // already gone — deletion is idempotent by design
  }
}

// ==========================================================================
// accept — the sole baseline writer (design spec §8a).
// ==========================================================================

/** TEST-ONLY crash-window seam. Set only by the crash-resume tests to make a
 * real `accept` throw immediately AFTER a named phase, leaving the exact
 * partial on-disk state a crash at that point would — so a *subsequent* real
 * `accept` can be asserted to resume correctly. Never set in production; the
 * documented interface is the 5-argument form. */
export type AcceptOptions = { crashAfter?: 'marker' | 'firstItemLive' | 'items' | 'manifest' }

/**
 * The sole baseline writer, made crash-safe by a durable **write-ahead
 * pending marker** (`<repo>/.ba/cache/pending-<wpId>.json`, §8a): resume is
 * PROVEN from that marker, never INFERRED from directory/filename shape.
 *
 * **Transaction order:**
 * 0. If a pending marker for THIS `wpId` exists → **resume**: reuse its
 *    `baselineId` as the stable `targetId` (so no fresh/duplicate baseline is
 *    minted) and do NOT re-gate (the marker proves the gate passed at start).
 *    Otherwise: if the WP is already `accepted` (and there's no marker) it's a
 *    completed-transaction no-op; else run `acceptGate` (VERIFY-FAIL ⇒ return,
 *    write nothing), allocate the baseline id, and write the marker.
 * 1. Flip each delivered item's live page → `baselined` + `baseline:target`.
 * 2. Write each delivered item's frozen baseline page.
 * 3. Write `manifest.yaml`.
 * 4. `reconcileCrs` the affected CRs.
 * 5. Set the WP `accepted`.
 * 6. **Delete the pending marker** — the true "transaction complete" marker
 *    (a committed baseline has NO marker).
 *
 * **The delivered set is recomputed from CURRENT status on every (re)invocation
 * — never trusted from the marker's frozen list.** The authoritative filter is
 *   `dedup( closure(wp) ∩ { id : status(id)==='batched'
 *                                OR (status(id)==='baselined' AND baseline(id)===targetId) } )`
 * (`closure.frs` is NOT deduped by graph.ts, so the `Set` here collapses a WP
 * whose `fr_ids` repeats an id). On a FRESH run `targetId` is brand-new so the
 * `baselined@targetId` disjunct matches nothing and the filter is exactly
 * `closure ∩ {batched}`. On RESUME that disjunct re-includes items the crashed
 * run already stamped (their frozen pages are re-written — no dropped item),
 * still-`batched` items are stamped, and an item that was legally changed
 * out-of-band during the crash-to-resume window (e.g. `retired`) is in NEITHER
 * branch and is correctly EXCLUDED — never resurrected back to `baselined`.
 * The marker's own `deliveredIds` is kept only as informational intent; the
 * manifest's `items` reflect what was actually delivered THIS run.
 *
 * **Every step is idempotent on resume:** an item already at `baseline:target`
 * skips its live-write (so `## History` — `editRequirement`'s concern, not
 * accept's — is never a factor and no page is needlessly rewritten); frozen
 * pages + manifest are re-derived; `reconcileCrs`/`setWpAccepted` are each
 * idempotent; the marker delete is best-effort. A fully-completed accept re-run
 * is a no-op via BOTH the already-`accepted` fast-path AND the absence of any
 * marker.
 *
 * This closes the crash windows: (Critical) a crash AFTER the manifest write
 * but before reconcile/setWpAccepted still has its marker, and all items are
 * `baselined@targetId` so the recompute re-includes them → resume runs
 * reconcile (unsticking the CR) + setWpAccepted + marker-delete; no fresh empty
 * baseline. (Major) a crash between an item's live-write and its frozen-write:
 * the recompute picks up both the already-stamped and the still-`batched`
 * members → every frozen page is (re)written, nothing dropped. (Major) hijack
 * is impossible: only a marker keyed to (and self-asserting) the CURRENT `wpId`
 * is ever resumed, so a committed baseline (no marker) or another WP's crash
 * (its own marker) is never adopted. And a legal out-of-band status change
 * during the crash window is never overwritten.
 *
 * **Version rule for a first-time baseline:** every delivered item is being
 * baselined for the FIRST time — `LEGAL_TRANSITIONS` only reaches `batched`
 * from `draft`/`active`, never from `baselined`, so no item with prior
 * accepted history can re-enter a delivered set. With no prior body to diff
 * and no new body supplied here, `shouldBump`/`## History` don't apply:
 * `version` is left as-is (normally `1`) and only `status`/`baseline`
 * change. `shouldBump`/`## History` remain exclusively `editRequirement`'s
 * concern (Task 10), for a later edit to an already-`baselined` item.
 *
 * `accepted_by` = `evidence.producedBy` (the only identity in the pinned
 * interface); `verify_evidence_ref` = the conventional
 * `.ba/cache/verify-<wp-id>.json` (§6.9).
 */
export async function accept(
  repo: string,
  wpId: string,
  evidence: VerifyEvidence,
  date: string,
  headCommit: string,
  options: AcceptOptions = {}
): Promise<Verdict> {
  if (!DATE_KEY.test(date)) {
    throw new Error(`writer: accept date must be YYYYMMDD, got ${JSON.stringify(date)}`)
  }
  verifyEvidenceSchema.parse(evidence)

  const crashAfter = options.crashAfter
  const marker = readPendingMarker(repo, wpId)

  // A WP already `accepted` with NO marker is a completed transaction — a pure
  // no-op (checked before loading the graph, so the common case is cheap).
  if (!marker) {
    const wpPeek = parseFile(wpPath(repo, wpId), 'wp')
    if (!('error' in wpPeek) && (wpPeek.frontmatter as { status?: unknown }).status === 'accepted') {
      return {
        verdict: 'VERIFY-OK',
        checks: [{ name: 'already-accepted', ok: true, reason: `${wpId} is already accepted (idempotent no-op)` }],
      }
    }
  }

  // The graph is (re)loaded from CURRENT disk state on every invocation — the
  // delivered set is recomputed from it, never trusted from the marker.
  const graph = loadGraph(repo)
  const closure = graph.closure(wpId)
  const closureIds = [...new Set<string>([...closure.frs, ...closure.nfrs, ...closure.brs])]
  const frById = byId(graph.frs)
  const nfrById = byId(graph.nfrs)
  const brById = byId(graph.brs)
  const statusBaselineOf = (id: string): { status: string; baseline?: string } | undefined => {
    const node = frById.get(id) ?? nfrById.get(id) ?? brById.get(id)
    return node ? { status: node.frontmatter.status, baseline: node.frontmatter.baseline } : undefined
  }

  let targetId: string
  let effectiveDate: string
  let verdict: Verdict

  if (marker) {
    // ---- RESUME: reuse the marker's stable `baselineId` (no re-mint) and skip
    // the gate (the marker proves it passed at transaction start).
    targetId = marker.baselineId
    effectiveDate = marker.date
    verdict = {
      verdict: 'VERIFY-OK',
      checks: [
        { name: 'resumed-from-pending-marker', ok: true, reason: `resumed ${wpId} from its pending marker (${targetId})` },
      ],
    }
  } else {
    // ---- FRESH: gate, then (on green) allocate the id + write the marker
    // BEFORE any item/baseline write, so a crash from here on is recoverable.
    const gateResult = acceptGate(graph, wpId, readVisionConfirmed(repo), evidence, headCommit)
    if (gateResult.verdict === 'VERIFY-FAIL') return gateResult

    // Pre-allocate empty-check: `targetId` is about to be brand-new, so the
    // authoritative filter below reduces to `closure ∩ {batched}` on a fresh
    // run — compute it here to reject a nothing-to-baseline accept BEFORE
    // burning a baseline id or writing a marker.
    const batched = closureIds.filter((id) => statusBaselineOf(id)?.status === 'batched')
    if (batched.length === 0) {
      throw new Error(`writer: accept found no batched items in ${wpId}'s closure — nothing to baseline`)
    }

    targetId = await allocateBaselineId(repo, date)
    effectiveDate = date
    writePendingMarker(repo, {
      wpId,
      baselineId: targetId,
      // Informational intent only — the authoritative delivered set is
      // recomputed below from current status (this run and every resume).
      deliveredIds: batched,
      date,
      headCommit,
      verifyEvidenceRef: `.ba/cache/verify-${wpId}.json`,
    })
    verdict = gateResult
    if (crashAfter === 'marker') throw new Error('TEST-ONLY crash after marker write')
  }

  // ---- Authoritative delivered set, recomputed from CURRENT status against
  // the now-known `targetId` (identical on both paths). `batched` items are
  // freshly stamped; `baselined@targetId` items are those a crashed run
  // already stamped (re-included so their frozen pages are re-written — no
  // dropped item); anything else (e.g. an out-of-band `retired` item) is
  // EXCLUDED — never resurrected.
  const deliveredIds = closureIds.filter((id) => {
    const sb = statusBaselineOf(id)
    if (!sb) return false
    return sb.status === 'batched' || (sb.status === 'baselined' && sb.baseline === targetId)
  })
  if (deliveredIds.length === 0) {
    // Only reachable on a resume where every delivered item was retired/changed
    // out-of-band during the crash window (a fresh run already threw above).
    throw new Error(`writer: accept found no deliverable items for ${wpId} under ${targetId} — nothing to baseline`)
  }

  const baselineDir = join(baselinesRoot(repo), targetId)
  const items: Array<{ id: string; version: number; content_hash: string }> = []
  const affectedCrIds = new Set<string>()

  // Steps 1-2: flip each delivered item's live page, then write its frozen
  // baseline copy. Both idempotent — an item already stamped `baseline:target`
  // (a resumed item) skips the live-write and just re-emits the frozen copy.
  for (let idx = 0; idx < deliveredIds.length; idx++) {
    const id = deliveredIds[idx]!
    const { type, path } = pathForRequirement(repo, id)
    const parsed = parseFile(path, type)
    if ('error' in parsed) {
      throw new Error(`writer: accept could not read delivered item ${id} at ${path}: ${parsed.error}`)
    }
    const fm = parsed.frontmatter as Record<string, unknown>
    const alreadyStamped = fm.status === 'baselined' && fm.baseline === targetId
    const finalFm: Record<string, unknown> = alreadyStamped ? fm : { ...fm, status: 'baselined', baseline: targetId }

    // Serialize ONCE — the live write and the frozen baseline copy must be
    // byte-identical, so compute the string once and reuse it for both.
    const frozen = emitRequirement(type, finalFm, parsed.body)
    if (!alreadyStamped) atomicWrite(path, frozen)
    if (idx === 0 && crashAfter === 'firstItemLive') {
      throw new Error('TEST-ONLY crash after first item live-write, before its frozen-write')
    }
    atomicWrite(join(baselineDir, `${id}.md`), frozen)
    items.push({ id, version: finalFm.version as number, content_hash: contentHash(frozen) })

    if (type === 'fr' || type === 'nfr') {
      for (const cr of (finalFm.traces_to as string[] | undefined) ?? []) affectedCrIds.add(cr)
    }
    // v3 (Task 5): a delivered BR has no `traces_to` field at all (schema.ts
    // has none for `br`) — its amending CR(s), if any, are recovered from its
    // OWN `## History` (a prior CR-driven `editRequirement` bump stamps a
    // heading citing the CR, `history.ts`'s `formatHistoryHeading`). Read off
    // `parsed.body` (the item's body BEFORE this accept, untouched by a
    // first-time baseline — see this function's own "Version rule for a
    // first-time baseline" doc note) so a BR delivered with no History at all
    // simply contributes nothing here.
    if (type === 'br') {
      for (const crRef of historyCrRefs(parsed.body)) affectedCrIds.add(crRef)
    }
  }
  if (crashAfter === 'items') throw new Error('TEST-ONLY crash after all item/frozen writes, before manifest')

  items.sort((a, b) => naturalCompare(a.id, b.id))

  // Step 3: manifest LAST-of-the-baseline-dir (its presence marks the frozen
  // snapshot complete). `.min(1)` in the schema rejects a zero-item baseline.
  const manifest = baselineManifestSchema.parse({
    id: targetId,
    date: effectiveDate,
    wp_ids: [wpId],
    triggered_by: wpId,
    items,
    accepted_by: evidence.producedBy,
    verify_evidence_ref: `.ba/cache/verify-${wpId}.json`,
  })
  atomicWrite(join(baselineDir, 'manifest.yaml'), yamlStringify(manifest, { lineWidth: 0 }))
  if (crashAfter === 'manifest') throw new Error('TEST-ONLY crash after manifest write, before reconcile/setWpAccepted')

  // Steps 4-5: reconcile CRs, accept the WP. Both idempotent on a resume.
  // Dynamic import breaks the writer.ts <-> reconcile.ts static cycle (see
  // reconcile.ts's header + this file's `crPath`/`atomicWrite` exports).
  const { reconcileCrs } = await import('./reconcile.js')
  reconcileCrs(repo, [...affectedCrIds].sort(naturalCompare), effectiveDate)
  setWpAccepted(repo, wpId)

  // Step 6: the true "transaction complete" marker — a committed baseline has
  // NO pending marker.
  deletePendingMarker(repo, wpId)

  return verdict
}
