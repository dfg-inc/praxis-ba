// ---- ids.ts: the counters ledger, id allocation, and the `.ba/.lock`
// lockfile (design spec §10 "Id allocation & single-writer").
//
// Three exported entry points, each with a narrow, deliberately-scoped job:
//   - `allocateId`         — O(1) mint. Reads ONLY the ledger high-water mark
//                            (`counters.yaml`), never the corpus.
//   - `allocateBaselineId` — same O(1) shape, over `baselineSeq[date]`.
//   - `maxGuard`           — the ONLY function in this module (or this
//                            package) that scans the corpus. Validate-time
//                            only; never called by either allocate function.
// This split is the whole point of the design: minting is cheap and never
// touches the page corpus; the expensive full-corpus consistency check is an
// explicit, separate, validate-time operation.
//
// **Ids are never reused.** A failed page-write after a successful
// `allocateId` burns an id — a gap in the sequence — and that is the
// intentionally safe failure mode (gaps allowed, reuse forbidden).
//
// **Zero ambient nondeterminism at the value level:** neither allocate
// function ever reads `Date.now()`/RNG to construct the id it returns — the
// WP creation date and the baseline date are both caller-supplied inputs
// (see the `allocateId` wp-scope note below, and `allocateBaselineId`'s
// `date` parameter). `crypto.randomUUID()` is used ONLY for temp-file naming
// in the atomic-write mechanics (transient plumbing that never appears in
// persisted output) — that is not a value-determinism violation.

import { closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { z } from 'zod'
import { parse as yamlParse, stringify as yamlStringify } from 'yaml'
import { countersSchema, baselineManifestSchema } from './schema.js'
import type { Scope } from './types.js'
import type { ParsedPage } from './parse.js'

export type Counters = z.infer<typeof countersSchema>
type BaselineManifest = z.infer<typeof baselineManifestSchema>

// ---- paths (both under the machine-owned `<repo>/.ba/`, §5) ----
function countersPath(repo: string): string {
  return join(repo, '.ba', 'counters.yaml')
}
function lockPath(repo: string): string {
  return join(repo, '.ba', '.lock')
}

// ==========================================================================
// Ledger read/persist — plain, no locking here (callers that mutate wrap
// these in acquireLock/releaseLock below; `maxGuard` reads read-only, and a
// torn read is impossible against an atomic renameSync'd file, so it needs
// no lock of its own).
// ==========================================================================

/** Reads + zod-validates `<repo>/.ba/counters.yaml`. Throws with the joined
 * zod issues on a corrupt/hand-tampered ledger — never silently coerces. */
export function readCounters(repo: string): Counters {
  const raw = readFileSync(countersPath(repo), 'utf8')
  const parsed: unknown = yamlParse(raw)
  const result = countersSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    throw new Error(`ids: ${countersPath(repo)} failed schema validation: ${issues.join('; ')}`)
  }
  return result.data
}

/** Atomic temp-write + rename (never a partial write) — also the exported
 * seam Task 13's `migrate` uses to seed a fresh ledger from `_counters`, and
 * Task 12's CLI could use to hand-edit it (both callers still go through
 * `countersSchema.parse` here, so a malformed seed fails loudly at write
 * time, not silently at the next `allocateId`). */
export function writeCounters(repo: string, counters: Counters): void {
  const validated = countersSchema.parse(counters)
  const dest = countersPath(repo)
  const tmp = join(repo, '.ba', `.counters.yaml.tmp-${process.pid}-${randomUUID()}`)
  writeFileSync(tmp, yamlStringify(validated, { lineWidth: 0 }), 'utf8')
  renameSync(tmp, dest)
}

// ==========================================================================
// Lockfile — `<repo>/.ba/.lock`, O_EXCL create, 10s acquisition timeout,
// mtime-based stale-break (>30s), always released via `finally`.
// ==========================================================================

const LOCK_ACQUIRE_TIMEOUT_MS = 10_000
const STALE_LOCK_MS = 30_000
const LOCK_RETRY_INTERVAL_MS = 25

function errno(err: unknown): string | undefined {
  return err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined
}
function isEexist(err: unknown): boolean {
  return errno(err) === 'EEXIST'
}
function isEnoent(err: unknown): boolean {
  return errno(err) === 'ENOENT'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Best-effort liveness check on the lock's recorded owner pid (§10 stale
 * detection is mtime-based; this is the belt-and-braces complement asked for
 * in review — a lock older than 30s but whose owner is demonstrably still
 * running must NOT be broken). Reads the pid `acquireLock` wrote into the
 * lock file and probes it with the null signal (`process.kill(pid, 0)`):
 *   - no throw            → the process exists and is signalable → ALIVE
 *   - throws EPERM        → the process exists (owned by another user) → ALIVE
 *   - throws ESRCH        → no such process → dead → breakable
 *   - unreadable / garbage pid → treat as breakable (a corrupt lock body
 *     shouldn't be able to wedge allocation forever)
 * Pids recycle, so this is explicitly best-effort — it narrows, never
 * replaces, the mtime staleness gate + the atomic rename-claim below. */
function ownerIsAlive(lock: string): boolean {
  let raw: string
  try {
    raw = readFileSync(lock, 'utf8')
  } catch {
    return false // unreadable (e.g. vanished under us) → not a reason to keep waiting
  }
  const pid = Number(raw.trim())
  if (!Number.isInteger(pid) || pid <= 0) return false // garbage payload → breakable
  try {
    process.kill(pid, 0)
    return true // signalable → alive
  } catch (err) {
    return errno(err) === 'EPERM' // EPERM = exists-but-not-ours (alive); ESRCH/other = dead
  }
}

/** Attempts to force-break `lock` if it's stale (mtime older than
 * `STALE_LOCK_MS` AND its owner pid is not alive). Returns whether THIS
 * caller successfully claimed+removed the stale lock, so the caller can
 * retry `openSync('wx')` immediately.
 *
 * The break is **atomic w.r.t. identity** (the HIGH review fix): rather than
 * blindly `unlinkSync(lock)` — which, across two racing waiters, lets the
 * loser delete the WINNER's freshly-re-created lock and both end up "holding"
 * it — we `renameSync(lock, <unique-claim>)` first. `renameSync` throws
 * `ENOENT` if the source path is already gone (another racer moved/broke it),
 * so **only the one racer whose rename actually moved this file instance
 * returns true**; everyone else gets ENOENT and just retries the loop without
 * deleting anything. The winner then unlinks its private claim file. */
function breakIfStale(lock: string): boolean {
  let mtimeMs: number
  try {
    mtimeMs = statSync(lock).mtimeMs
  } catch {
    // Disappeared between our failed open() and this stat() — its owner (or
    // another waiter) already released/broke it; nothing to do, let the
    // caller's loop retry the open().
    return false
  }
  const age = Date.now() - mtimeMs
  if (age <= STALE_LOCK_MS) return false
  if (ownerIsAlive(lock)) return false // stale by clock, but the owner is still running — keep waiting

  console.warn(`ids: breaking stale lock ${lock} (age ${Math.round(age)}ms > ${STALE_LOCK_MS}ms)`)
  const claim = `${lock}.stale-${process.pid}-${randomUUID()}`
  try {
    renameSync(lock, claim)
  } catch (err) {
    // ENOENT → another racer already atomically claimed/broke this exact file
    // instance; do NOT delete whatever is at `lock` now (it may be that
    // racer's fresh lock). Just report "not broken by me" and let the loop
    // retry. Any other rename error is a genuine fs fault worth surfacing.
    if (isEnoent(err)) return false
    throw err
  }
  try {
    unlinkSync(claim)
  } catch {
    // The claim is private to this call; a failure to remove it leaks a
    // harmless stray file at worst — never blocks acquisition.
  }
  return true
}

/** Acquires `<repo>/.ba/.lock` via `O_EXCL` create, retrying (with a
 * non-blocking async sleep, never a CPU busy-wait) until either it succeeds
 * or `LOCK_ACQUIRE_TIMEOUT_MS` elapses. A stale lock is atomically broken
 * inline (see `breakIfStale`) and retried immediately, no sleep consumed. */
async function acquireLock(repo: string): Promise<void> {
  const lock = lockPath(repo)
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS
  for (;;) {
    let fd: number
    try {
      fd = openSync(lock, 'wx')
    } catch (err) {
      if (!isEexist(err)) throw err
      if (breakIfStale(lock)) continue
      if (Date.now() >= deadline) {
        throw new Error(`ids: timed out acquiring lock ${lock} after ${LOCK_ACQUIRE_TIMEOUT_MS}ms`)
      }
      await sleep(LOCK_RETRY_INTERVAL_MS)
      continue
    }
    // The lock file now exists and is ours. Guard the pid write + close so a
    // failure AFTER the O_EXCL create never orphans the file (the caller's
    // try/finally only wraps the critical section, not this acquisition) —
    // clean it up before rethrowing (the LOW review fix).
    try {
      // Best-effort diagnostic payload (the owning pid) — read back only by
      // `ownerIsAlive`'s liveness probe, never for allocation logic.
      writeSync(fd, String(process.pid))
      closeSync(fd)
    } catch (err) {
      try {
        closeSync(fd)
      } catch {
        // fd may already be closed (if closeSync itself threw above) — ignore
      }
      try {
        unlinkSync(lock)
      } catch {
        // best-effort orphan cleanup
      }
      throw err
    }
    return
  }
}

/** Best-effort release — always called from a `finally`, so a lock this
 * process holds is never left behind on any exit path (including a thrown
 * error from the critical section). Absence (e.g. force-broken by a waiter
 * that misjudged staleness, a genuine bug we don't want to compound with a
 * second throw) is swallowed, matching `breakIfStale`'s own tolerance. */
function releaseLock(repo: string): void {
  try {
    unlinkSync(lockPath(repo))
  } catch {
    // already gone — releasing is best-effort by design
  }
}

// ==========================================================================
// allocateId — O(1) mint, no corpus scan.
// ==========================================================================

const DATE_KEY = /^\d{8}$/

function pad3(n: number): string {
  return String(n).padStart(3, '0')
}

/** Formats the id for `scope` and returns the next `Counters` value (pure —
 * the caller persists it). `date` is required (and validated `YYYYMMDD`)
 * ONLY for `scope.kind === 'wp'`.
 *
 * DESIGN NOTE for Tasks 10/12/13 (WP minting): `types.ts`'s `Scope` (Task 1,
 * pinned "verbatim" per the plan) has no date field on its `wp` arm — WP ids
 * embed a date (`WP-YYYYMMDD-NNN`, §6.6: date is informational, NNN is the
 * flat monotonic counter) but this module must never read the clock to
 * produce it. Rather than widen the already-committed `Scope` union, the
 * date travels as `allocateId`'s own 3rd parameter — a COMPILE-time
 * requirement for the wp scope via the overloads below (belt: this runtime
 * guard also validates the format), and validated only when
 * `scope.kind === 'wp'`:
 *   `allocateId(repo, { kind: 'wp' }, '20260713')`
 * This keeps the pinned `(repo, scope)` contract intact for every other
 * scope kind and mirrors `allocateBaselineId`'s own explicit `date`
 * parameter (also caller-supplied, never read from the clock). */
function bump(counters: Counters, scope: Scope, date: string | undefined): { id: string; next: Counters } {
  switch (scope.kind) {
    case 'epic': {
      const n = counters.product.epic + 1
      const id = `E${n}`
      return {
        id,
        next: {
          ...counters,
          product: { ...counters.product, epic: n },
          // Proactively seed the epic's own fr/nfr/br bucket so a later
          // `{kind:'fr'|'nfr'|'br', epic: id}` allocation always finds an
          // entry (also harmless/idempotent if one already existed).
          epics: { ...counters.epics, [id]: counters.epics[id] ?? { fr: 0, nfr: 0, br: 0 } },
        },
      }
    }
    case 'cr': {
      const n = counters.product.cr + 1
      return { id: `CR-${pad3(n)}`, next: { ...counters, product: { ...counters.product, cr: n } } }
    }
    case 'bug': {
      const n = counters.product.bug + 1
      return { id: `BUG-${pad3(n)}`, next: { ...counters, product: { ...counters.product, bug: n } } }
    }
    case 'wp': {
      if (date === undefined || !DATE_KEY.test(date)) {
        throw new Error(
          "ids: allocateId scope 'wp' requires a 3rd argument — an explicit YYYYMMDD creation date " +
            "(e.g. allocateId(repo, {kind:'wp'}, '20260713')) — this module never reads the clock"
        )
      }
      const n = counters.product.wp + 1
      return { id: `WP-${date}-${pad3(n)}`, next: { ...counters, product: { ...counters.product, wp: n } } }
    }
    case 'fr':
    case 'nfr':
    case 'br': {
      const prior = counters.epics[scope.epic] ?? { fr: 0, nfr: 0, br: 0 }
      const n = prior[scope.kind] + 1
      const nextEpicCounters = { ...prior, [scope.kind]: n }
      const suffix = scope.kind === 'fr' ? 'FR' : scope.kind === 'nfr' ? 'NFR' : 'BR'
      return {
        id: `${scope.epic}-${suffix}${n}`,
        next: { ...counters, epics: { ...counters.epics, [scope.epic]: nextEpicCounters } },
      }
    }
  }
}

// ---- The wp-arm of `Scope` embeds a date in its id (`WP-YYYYMMDD-NNN`), but
// this module must never read the clock, so the date is a caller-supplied
// argument (see the design note on `bump`). These overloads make that a
// COMPILE-time contract (the MEDIUM review fix) rather than a runtime throw:
//   allocateId(repo, {kind:'wp'}, '20260713')   ✓
//   allocateId(repo, {kind:'wp'})                ✗ compile error (date required)
//   allocateId(repo, {kind:'cr'})                ✓
// `Scope` itself is untouched (it's consumed by other tasks). `NonWpScope`
// can't be `Exclude<Scope,{kind:'wp'}>` because Scope's non-requirement arm
// packs epic/cr/wp/bug into a single union-typed `kind` (not distributable),
// so the non-wp kinds are spelled out here.
type NonWpScope = { kind: 'epic' | 'cr' | 'bug' } | { kind: 'fr' | 'nfr' | 'br'; epic: string }

/** Mints the next id for a WP — `date` (YYYYMMDD) is REQUIRED and forms the
 * informational date segment of `WP-YYYYMMDD-NNN` (NNN is the flat monotonic
 * counter). */
export async function allocateId(repo: string, scope: { kind: 'wp' }, date: string): Promise<string>
/** Mints the next id for any non-WP scope. */
export async function allocateId(repo: string, scope: NonWpScope): Promise<string>
/** Mints the next id for `scope`. O(1): reads only `counters.yaml`'s
 * high-water mark under the `.ba/.lock` mutex, increments, persists
 * atomically, releases — never scans the page corpus (that's `maxGuard`'s
 * job, at validate time only). `date` (YYYYMMDD) is required when
 * `scope.kind === 'wp'` — see the design note on `bump` above. */
export async function allocateId(repo: string, scope: Scope, date?: string): Promise<string> {
  await acquireLock(repo)
  try {
    const counters = readCounters(repo)
    const { id, next } = bump(counters, scope, date)
    writeCounters(repo, next)
    return id
  } finally {
    releaseLock(repo)
  }
}

/** Mints the next baseline id for `date` (YYYYMMDD, caller-supplied — never
 * `Date.now()`) via `counters.product.baselineSeq[date]`: first-of-day omits
 * the suffix (`BL-<date>`), the 2nd+ get `-2`, `-3`, … Same lock + atomic
 * persist as `allocateId` (shares the one `.ba/.lock` — both mutate the same
 * `counters.yaml`, so they must serialize against each other too). */
export async function allocateBaselineId(repo: string, date: string): Promise<string> {
  if (!DATE_KEY.test(date)) throw new Error(`ids: allocateBaselineId date must be YYYYMMDD, got ${JSON.stringify(date)}`)
  await acquireLock(repo)
  try {
    const counters = readCounters(repo)
    const prevSeq = counters.product.baselineSeq[date] ?? 0
    const seq = prevSeq + 1
    const id = seq === 1 ? `BL-${date}` : `BL-${date}-${seq}`
    const next: Counters = {
      ...counters,
      product: { ...counters.product, baselineSeq: { ...counters.product.baselineSeq, [date]: seq } },
    }
    writeCounters(repo, next)
    return id
  } finally {
    releaseLock(repo)
  }
}

// ==========================================================================
// maxGuard — the validate-time corpus scan. The ONLY place in this module
// (or this package) that walks the page corpus for id purposes.
// ==========================================================================

// Capture-group counterparts of schema.ts's anchored (no-capture) id
// regexes, used here to both classify AND extract the numeric high-water
// value in one pass. Kept local (schema.ts's exports are validation-only,
// full-match, no groups) rather than retrofitting capture groups onto the
// pinned validation regexes there.
const EPIC_NUM = /^E(\d+)$/
const FR_NUM = /^E(\d+)-FR(\d+)$/
const NFR_NUM = /^E(\d+)-NFR(\d+)$/
const BR_NUM = /^E(\d+)-BR(\d+)$/
const CR_NUM = /^CR-(\d+)$/
const WP_NUM = /^WP-(\d{8})-(\d+)$/
const BUG_NUM = /^BUG-(\d+)$/
const BASELINE_NUM = /^BL-(\d{8})(?:-(\d+))?$/

type HighWaterEntry = { n: number; id: string }

/** Records `id`'s contribution to the flattened high-water map (keyed the
 * same way `flattenCounters` below flattens the ledger, so the two are
 * directly diffable), keeping the id string alongside the number so a
 * violation message can name a concrete offending id. Anything that isn't
 * one of the eight id shapes this ledger tracks (an AC id, a stray string in
 * a loosely-typed field, a malformed value) is silently ignored — `maxGuard`
 * only asserts on ids the ledger is actually responsible for. */
function noteId(hwm: Map<string, HighWaterEntry>, id: string): void {
  // Named distinctly from the module-level `bump` (which formats+increments
  // a *counter*, for allocation) — this one only ever raises a recorded max,
  // never decrements it, and never persists anything.
  const raiseMax = (key: string, n: number): void => {
    const existing = hwm.get(key)
    if (!existing || n > existing.n) hwm.set(key, { n, id })
  }
  let m: RegExpExecArray | null
  if ((m = WP_NUM.exec(id))) {
    raiseMax('product.wp', Number(m[2]))
    return
  }
  if ((m = FR_NUM.exec(id))) {
    raiseMax(`epics.E${m[1]}.fr`, Number(m[2]))
    return
  }
  if ((m = NFR_NUM.exec(id))) {
    raiseMax(`epics.E${m[1]}.nfr`, Number(m[2]))
    return
  }
  if ((m = BR_NUM.exec(id))) {
    raiseMax(`epics.E${m[1]}.br`, Number(m[2]))
    return
  }
  if ((m = EPIC_NUM.exec(id))) {
    raiseMax('product.epic', Number(m[1]))
    return
  }
  if ((m = CR_NUM.exec(id))) {
    raiseMax('product.cr', Number(m[1]))
    return
  }
  if ((m = BUG_NUM.exec(id))) {
    raiseMax('product.bug', Number(m[1]))
    return
  }
  if ((m = BASELINE_NUM.exec(id))) {
    const seq = m[2] !== undefined ? Number(m[2]) : 1
    raiseMax(`baselineSeq.${m[1]}`, seq)
    return
  }
}

/** Flattens `counters` into the same `key -> n` shape `noteId` populates, so
 * the corpus-derived high-water map diffs directly against the ledger. */
function flattenCounters(counters: Counters): Map<string, number> {
  const flat = new Map<string, number>()
  flat.set('product.epic', counters.product.epic)
  flat.set('product.cr', counters.product.cr)
  flat.set('product.wp', counters.product.wp)
  flat.set('product.bug', counters.product.bug)
  for (const [date, seq] of Object.entries(counters.product.baselineSeq)) flat.set(`baselineSeq.${date}`, seq)
  for (const [epicId, epicCounters] of Object.entries(counters.epics)) {
    flat.set(`epics.${epicId}.fr`, epicCounters.fr)
    flat.set(`epics.${epicId}.nfr`, epicCounters.nfr)
    flat.set(`epics.${epicId}.br`, epicCounters.br)
  }
  return flat
}

/** Same boundary-widening pattern `graph.ts`'s `nodeTypeOf` uses for the
 * statically-`unknown` `ParsedPage.frontmatter`: every schema in schema.ts
 * that carries an id names the field `id: string`, so this is safe for any
 * page that passed `parsePage`'s zod validation. A `vision` page (no `id`)
 * correctly yields `undefined` and is skipped. */
function idOf(fm: unknown): string | undefined {
  if (typeof fm !== 'object' || fm === null || !('id' in fm)) return undefined
  const id = (fm as { id: unknown }).id
  return typeof id === 'string' ? id : undefined
}

/** The validate-time corpus max-guard (§10): asserts `counters[scope] ≥`
 * every id ever seen across the live canon (`pages`), every baseline
 * snapshot (`baselines` — both each snapshot's own `BL-…` id and every
 * frozen item id it lists), AND `counters.retired`. This is O(corpus) by
 * design and is NEVER called from `allocateId`/`allocateBaselineId` — it
 * exists solely to catch hand-tampering or a rewound ledger at `validate`
 * time. Read-only: takes no lock (an atomic renameSync'd `counters.yaml` can
 * never be observed torn, so a concurrent `allocateId` elsewhere poses no
 * risk here). */
export function maxGuard(
  repo: string,
  pages: readonly ParsedPage[],
  baselines: readonly BaselineManifest[]
): { ok: boolean; violations: string[] } {
  const counters = readCounters(repo)
  const hwm = new Map<string, HighWaterEntry>()

  for (const page of pages) {
    const id = idOf(page.frontmatter)
    if (id !== undefined) noteId(hwm, id)
  }
  for (const baseline of baselines) {
    noteId(hwm, baseline.id)
    for (const item of baseline.items) noteId(hwm, item.id)
  }
  for (const id of counters.retired) noteId(hwm, id)

  const ledger = flattenCounters(counters)
  const violations: string[] = []
  for (const [key, { n, id }] of hwm) {
    const ledgerN = ledger.get(key) ?? 0
    if (n > ledgerN) violations.push(`${key}: ledger=${ledgerN} but corpus has ${id} (${n})`)
  }
  violations.sort()
  return { ok: violations.length === 0, violations }
}
