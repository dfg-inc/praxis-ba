// ---- scopelinks.ts: the WP `## Scope` reference grammar (spec §3) — the
// CANONICAL machine-readable form of a v3 WP's refs (owner decision Q1).
// Pure string parsing; resolution (path/anchor/version against the corpus)
// is gates.ts/validate's job — this module only extracts and classifies.

import { BR_ID, CR_ID, FR_ID, NFR_ID } from './schema.js'

export type ScopeRef = { id: string; version?: number; label?: string; path: string; anchor?: string }
export type ParsedScope = { crs: ScopeRef[]; frs: ScopeRef[]; nfrs: ScopeRef[]; brs: ScopeRef[]; errors: string[] }

const SCOPE_HEADING = /^## Scope[ \t]*$/m
const LINK_LINE = /^- \[([A-Z0-9-]+)(?: v(\d+))?(?: — (.+?))?\]\(([^)#\s]+)(?:#([A-Za-z0-9_-]+))?\)[ \t]*$/

function classify(id: string): 'cr' | 'fr' | 'nfr' | 'br' | undefined {
  if (CR_ID.test(id)) return 'cr'
  if (FR_ID.test(id)) return 'fr'
  if (NFR_ID.test(id)) return 'nfr'
  if (BR_ID.test(id)) return 'br'
  return undefined
}

// finding #26: `SUBSECTION`'s alternation and `BUCKET_FOR`'s keys used to be
// two hand-authored copies of the same 3-name set — kept in sync only by
// convention, with `BUCKET_FOR[current]!` papering over the (structurally
// unenforceable) possibility of drift with a non-null assertion. Tied at the
// type level instead: `BUCKET_FOR` is the ONE source of truth, `SUBSECTION`'s
// regex is DERIVED from its keys, and `SubsectionName` (also derived) is what
// `current` is typed as below — so `BUCKET_FOR[current]` is a plain, total,
// non-null lookup the compiler proves safe, and a future 4th heading can only
// ever be added by adding a `BUCKET_FOR` key (which then flows into both the
// regex and the type automatically).
const BUCKET_FOR = {
  'Change requests': new Set(['cr']),
  Delivers: new Set(['fr']),
  Constraints: new Set(['nfr', 'br']),
} satisfies Record<string, ReadonlySet<string>>

type SubsectionName = keyof typeof BUCKET_FOR

const SUBSECTION = new RegExp(`^### (${Object.keys(BUCKET_FOR).join('|')})[ \\t]*$`)

export function parseScope(body: string): ParsedScope {
  const out: ParsedScope = { crs: [], frs: [], nfrs: [], brs: [], errors: [] }
  const scopeMatch = SCOPE_HEADING.exec(body)
  if (!scopeMatch) {
    out.errors.push('missing ## Scope section')
    return out
  }
  // The Scope section runs to the next `## ` heading (or EOF).
  const after = body.slice(scopeMatch.index + scopeMatch[0].length)
  const nextH2 = /^## /m.exec(after)
  const section = nextH2 ? after.slice(0, nextH2.index) : after

  let current: SubsectionName | undefined
  for (const line of section.split('\n')) {
    const sub = SUBSECTION.exec(line)
    if (sub) {
      // Non-null + cast: SUBSECTION's one capture group is unconditional
      // whenever it matches, and its alternation is DERIVED from
      // `BUCKET_FOR`'s own keys (above), so the captured text can only ever
      // be one of `SubsectionName`'s literal values.
      current = sub[1]! as SubsectionName
      continue
    }
    if (!line.startsWith('- ')) continue
    if (!current) {
      out.errors.push(`Scope link outside any subsection: ${line.trim()}`)
      continue
    }
    const m = LINK_LINE.exec(line)
    if (!m) {
      out.errors.push(`malformed Scope link line under ### ${current}: ${line.trim()}`)
      continue
    }
    const [, id, v, label, path, anchor] = m
    const cls = classify(id!)
    if (!cls || !BUCKET_FOR[current].has(cls)) {
      out.errors.push(`### ${current} does not accept id ${id} (${cls ?? 'unrecognized id shape'})`)
      continue
    }
    const ref: ScopeRef = { id: id!, path: path! }
    if (v !== undefined) ref.version = Number(v)
    if (label !== undefined) ref.label = label
    if (anchor !== undefined) ref.anchor = anchor
    if (cls === 'cr') out.crs.push(ref)
    else if (cls === 'fr') out.frs.push(ref)
    else if (cls === 'nfr') out.nfrs.push(ref)
    else out.brs.push(ref)
  }
  if (out.frs.length === 0) out.errors.push('### Delivers lists no FR link')
  return out
}

export function slugifyHeading(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 _-]/g, '').replace(/ /g, '-')
}

export function pageAnchors(body: string): Set<string> {
  const seen = new Map<string, number>()
  const out = new Set<string>()
  for (const m of body.matchAll(/^#{1,6} (.+)$/gm)) {
    const base = slugifyHeading(m[1]!)
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    out.add(n === 0 ? base : `${base}-${n}`)
  }
  return out
}
