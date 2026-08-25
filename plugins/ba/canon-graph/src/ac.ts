// ---- the "## Acceptance Criteria" block grammar (design spec §6.2) ----
// Pure, no-IO parser: isolates the AC section from a rendered node body, splits
// it into per-AC entries keyed by the literal `N` in `- AC-N:`, folds indented
// continuation lines into the owning AC's text, and reports duplicate ids
// (fatal — upstream treats this as VERIFY-FAIL) and non-AC bullets (advisory).

// Exported: versiondiff.ts reuses these two to locate the same section span
// (for canonicalization/replacement) without re-deriving the AC grammar —
// the {acId, text} extraction below remains the single source of truth.
export const SECTION_HEADING = /^##\s+Acceptance Criteria\s*$/
export const NEXT_HEADING = /^## /
const AC_BULLET = /^- AC-(\d+): (.+)$/
const TOP_LEVEL_BULLET = /^- (.+)$/
const CONTINUATION = /^ {2,}(.+)$/

export type Ac = { acId: number; text: string }
export type AcBlockResult = { acs: Ac[]; warnings: string[]; error?: string }

export function parseAcBlock(body: string): AcBlockResult {
  const lines = body.split('\n').map((line) => line.replace(/\r$/, ''))
  const headingIndex = lines.findIndex((line) => SECTION_HEADING.test(line))
  if (headingIndex === -1) return { acs: [], warnings: [] }

  const acs: Ac[] = []
  const warnings: string[] = []
  const seenIds = new Set<number>()
  let error: string | undefined
  let current: Ac | undefined

  for (let i = headingIndex + 1; i < lines.length; i++) {
    // Non-null: `i < lines.length` is the loop's own bound.
    const line = lines[i]!
    if (NEXT_HEADING.test(line)) break

    const acMatch = AC_BULLET.exec(line)
    if (acMatch) {
      // Non-null: AC_BULLET has exactly two unconditional (non-`?`) capture
      // groups, so a successful match always populates both indices.
      const acId = Number(acMatch[1]!)
      const text = acMatch[2]!
      if (seenIds.has(acId)) {
        error = error ?? `duplicate AC id: AC-${acId}`
      }
      seenIds.add(acId)
      current = { acId, text }
      acs.push(current)
      continue
    }

    const continuationMatch = CONTINUATION.exec(line)
    if (continuationMatch && current) {
      // Non-null: CONTINUATION's single capture group is unconditional.
      current.text = `${current.text} ${continuationMatch[1]!}`
      continue
    }

    const bulletMatch = TOP_LEVEL_BULLET.exec(line)
    if (bulletMatch) {
      warnings.push(`non-AC bullet in Acceptance Criteria section: "${line}"`)
      current = undefined
      continue
    }

    // blank line / stray prose / under-indented text: not part of the
    // grammar, silently ignored.
  }

  return error === undefined ? { acs, warnings } : { acs, warnings, error }
}

/** True when an AC line is verifiable in Gherkin form: given/when/then
 * (English) or Дано/Когда/Тогда (Russian). Case-insensitive; whole-word
 * for English tokens, substring for Russian. WBS 1.12. */
export function isVerifiableAc(text: string): boolean {
  const t = text.toLowerCase()
  const hasGiven = /\bgiven\b/.test(t) || t.includes('дано')
  const hasWhen = /\bwhen\b/.test(t) || t.includes('когда')
  const hasThen = /\bthen\b/.test(t) || t.includes('тогда')
  return hasGiven && hasWhen && hasThen
}

/** Returns the AC ids whose text is not Gherkin-verifiable, or an empty
 * list when every AC passes (or there are no ACs). */
export function unverifiableAcIds(acs: readonly Ac[]): number[] {
  return acs.filter((ac) => !isVerifiableAc(ac.text)).map((ac) => ac.acId)
}
