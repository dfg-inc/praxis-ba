// ---- version-bump decision: `shouldBump` per node type (design spec §4.1a) ----
// A pure, no-IO comparator over already-parsed page bodies. The `writer`
// calls this before archiving a `baselined` item's prior body into
// `## History` and incrementing `version` — so it must fire ONLY on a real
// content change. Frontmatter is never inspected here: an edit that only
// touches frontmatter (e.g. adding a `traces_to` ref) must never bump. The
// canonicalization below is comparison-only — the stored body stays opaque
// for *writing*, per parse.ts's contract; nothing here re-renders it.

import { parseAcBlock, SECTION_HEADING, NEXT_HEADING, type Ac } from './ac.js'
import type { NodeType } from './types.js'

export type PageBody = { frontmatter: unknown; body: string }

// Normalize = trim each line (drops trailing/leading-whitespace-only diffs)
// + unify line endings to LF + drop trailing blank lines. Pinned by §4.1a.
function normalize(body: string): string {
  const lines = body.split(/\r\n|\r|\n/).map((line) => line.trim())
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines.join('\n')
}

// Rebuild the "## Acceptance Criteria" section from its *parsed* ACs, sorted
// by numeric acId, replacing whatever bullet order/prose/warnings-worthy
// content was in the original section. So AC reordering is not a spurious
// change, but an id or text change is. If there is no AC section, the body
// is returned unchanged (nothing to canonicalize).
function canonicalizeAcBlock(body: string, acs: readonly Ac[]): string {
  const lines = body.split('\n').map((line) => line.replace(/\r$/, ''))
  const headingIndex = lines.findIndex((line) => SECTION_HEADING.test(line))
  if (headingIndex === -1) return body

  let endIndex = lines.length
  for (let i = headingIndex + 1; i < lines.length; i++) {
    // Non-null: `i < lines.length` is the loop's own bound.
    if (NEXT_HEADING.test(lines[i]!)) {
      endIndex = i
      break
    }
  }

  const sorted = [...acs].sort((a, b) => a.acId - b.acId)
  const canonicalBlock = [
    '## Acceptance Criteria',
    ...sorted.map((ac) => `- AC-${ac.acId}: ${ac.text}`),
  ]

  lines.splice(headingIndex, endIndex - headingIndex, ...canonicalBlock)
  return lines.join('\n')
}

function canonicalBody(type: NodeType, body: string): string {
  if (type !== 'fr') return normalize(body)
  const { acs } = parseAcBlock(body)
  return normalize(canonicalizeAcBlock(body, acs))
}

// FR: compare the body with its AC block canonicalized (sorted by acId).
// NFR/BR/everything else: compare the whole normalized body. In all cases
// this is body-content-only — frontmatter never participates in the diff.
export function shouldBump(type: NodeType, oldPage: PageBody, newPage: PageBody): boolean {
  return canonicalBody(type, oldPage.body) !== canonicalBody(type, newPage.body)
}
