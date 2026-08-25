// ---- history.ts: `## History` string mechanics (spec §2.2/§2.3) — the one
// home for heading format/parse, archived-body heading demotion, and the
// archive splice writer.ts calls. String-level only; bodies stay opaque
// everywhere else (fmt never touches them — the demotion invariant is
// enforced corpus-wide by validate's `history-anchor-unique` check).

// Exported (migrate-v3.ts, Task 9): the v2→v3 migration needs to retroactively
// demote un-demoted `##`/`###` headings trapped inside LEGACY archived History
// entries (bodies that predate this module's own `demoteHeadings` step, which
// only shipped in v3) — it must locate the exact same History-heading/
// entry-heading boundaries this module already parses against, rather than
// re-deriving a parallel (and possibly drifting) copy of either pattern.
// PINNED (byte-for-byte, finding #2/#3/#6): migrate-v3.ts's retroactive
// demotion segmentation depends on these two regexes' EXACT current
// semantics — never relax them here. A citation-recovery scan that tolerates
// a DEMOTED (nested) entry heading lives separately, in `historyCrRefs` below.
export const HISTORY_HEADING_LINE = /^## History[ \t]*$/m
export const ENTRY_HEADING = /^### v(\d+) — (\S+) — (\S+)[ \t]*$/gm

/** Marks the MACHINE-MANAGED `## History` section — the one `archiveIntoHistory`
 * itself splices into — so a coincidentally-identical PROSE `## History`
 * heading an author writes as part of their own requirement content (this
 * exact product ships a feature literally called "History", the /history
 * Journal screen — finding #2) is never mistaken for the archive anchor.
 * Every page this module itself creates carries the sentinel; a page
 * migrated pre-sentinel (every v3-migrated page — `locateHistorySection`'s
 * "legacy machine shape" branch) is upgraded with it in place the next time
 * it's touched. */
export const SENTINEL = '<!-- praxis-ba:history -->'

type HistoryLocation = {
  /** index of the start of the `## History` heading LINE itself (its first `#`) */
  readonly headingStart: number
  /** index immediately after the heading line's matched text (before its trailing newline) */
  readonly headingEnd: number
  /** true when this location was found via the un-sentineled legacy shape and needs the sentinel inserted on write */
  readonly legacy: boolean
}

const SENTINELED_HISTORY = /^<!-- praxis-ba:history -->\n(## History[ \t]*)$/m

/** Locates the ONE machine-managed `## History` section in `body`, distinct
 * from any coincidental prose heading of the same text (finding #2):
 *   (a) a `## History` heading immediately preceded by the sentinel line
 *       wins outright — unambiguous regardless of what else the body says;
 *   (b) else, the FIRST bare `## History` line whose first non-blank
 *       following line looks like an entry heading (`^### v\d+ — `) — the
 *       legacy (pre-sentinel) machine shape every v3-migrated page has;
 *   (c) else `null` — no machine section exists yet (including: the body has
 *       A `## History` heading, but it's neither sentineled nor followed by
 *       what looks like an archive entry — i.e. it's prose).
 */
function locateHistorySection(body: string): HistoryLocation | null {
  const sentineled = SENTINELED_HISTORY.exec(body)
  if (sentineled) {
    // Non-null: SENTINELED_HISTORY's one capture group is unconditional
    // whenever the regex matches.
    const heading = sentineled[1]!
    const headingStart = sentineled.index + SENTINEL.length + 1
    return { headingStart, headingEnd: headingStart + heading.length, legacy: false }
  }
  const bareHeading = /^## History[ \t]*$/gm
  let m: RegExpExecArray | null
  while ((m = bareHeading.exec(body))) {
    const headingEnd = m.index + m[0].length
    const rest = body.slice(headingEnd).replace(/^\n+/, '')
    if (/^### v\d+ — /.test(rest)) {
      return { headingStart: m.index, headingEnd, legacy: true }
    }
  }
  return null
}

export function formatHistoryHeading(version: number, date: string, ref: string): string {
  return `### v${version} — ${date} — ${ref}`
}

export function parseHistoryHeadings(body: string): Array<{ version: number; date: string; ref: string }> {
  const loc = locateHistorySection(body)
  if (!loc) return []
  const section = body.slice(loc.headingEnd)
  const out: Array<{ version: number; date: string; ref: string }> = []
  for (const m of section.matchAll(ENTRY_HEADING)) {
    out.push({ version: Number(m[1]), date: m[2]!, ref: m[3]! })
  }
  return out
}

/** A citation, once written, is a historical fact — demotion (`demoteHeadings`,
 * below) is presentation only. Unlike `parseHistoryHeadings` (which stays
 * strict to the live, un-demoted `### vN` shape — structural consumers keep
 * that exact regex, see `ENTRY_HEADING`'s own comment), this scans the
 * located History section at ANY demoted depth: `demoteHeadings` only ever
 * pushes an entry heading from level 3 to level 5 once, then leaves it there
 * (it never matches an already-4-or-5-hash line again) — `#{3,6}` covers
 * that with margin — so a citation from an earlier bump is never lost just
 * because a LATER, unrelated bump landed on the same page (finding #3/#6). */
export function historyCrRefs(body: string): string[] {
  const loc = locateHistorySection(body)
  if (!loc) return []
  const section = body.slice(loc.headingEnd)
  const refs: string[] = []
  for (const m of section.matchAll(/^#{3,6} v\d+ — \S+ — (\S+)[ \t]*$/gm)) {
    const ref = m[1]!
    if (/^CR-\d{3}$/.test(ref)) refs.push(ref)
  }
  return [...new Set(refs)]
}

/** Demotes `##`→`####` and `###`→`#####` (top-of-line only). Applied exactly
 * once, to a PRIOR body about to be embedded under a `### v{N}` entry, so the
 * archive never re-introduces `##`/`###`-level anchors (spec §2.3). */
export function demoteHeadings(text: string): string {
  return text.replace(/^###? /gm, (m) => (m === '## ' ? '#### ' : '##### '))
}

/** Prepends a new `### v{N} — {date} — {ref}` entry (embedding
 * `demoteHeadings(priorBody)`, so the archived content's own `##`/`###`
 * headings never collide with the live document's heading levels) into
 * `body`'s machine-managed `## History` section (`locateHistorySection`),
 * creating that section (sentineled, at the end of `body`) if none exists
 * yet. Append-AT-TOP: this new entry always lands immediately after the
 * heading, ahead of whatever was already there — see writer.ts's header for
 * why. A section found via the legacy (un-sentineled) shape is upgraded
 * in-place with the sentinel as part of this same write (finding #2). */
export function archiveIntoHistory(body: string, heading: string, priorBody: string): string {
  const newEntry = `${heading}\n\n${demoteHeadings(priorBody)}`
  const loc = locateHistorySection(body)
  if (!loc) {
    const head = body.replace(/\n+$/, '')
    const prefix = head === '' ? '' : `${head}\n\n`
    return `${prefix}${SENTINEL}\n## History\n\n${newEntry}\n`
  }
  const beforeHistory = body.slice(0, loc.headingEnd)
  const rest = body.slice(loc.headingEnd).replace(/^\n+/, '')
  const restBlock = rest === '' ? '' : `\n\n${rest}`
  const spliced = `${beforeHistory}\n\n${newEntry}${restBlock}`
  if (!loc.legacy) return spliced
  // Legacy upgrade-on-touch: insert the sentinel line immediately above the
  // heading — `loc.headingStart` is still a valid offset into `spliced`
  // (everything up to `loc.headingEnd`, which is >= `headingStart`, is
  // untouched by the splice above).
  return `${spliced.slice(0, loc.headingStart)}${SENTINEL}\n${spliced.slice(loc.headingStart)}`
}
