/**
 * Semantic BA body checks (ported from tools/lint.py checks 1–5).
 *
 * Structural checks 6–9 stay in `validate` / the graph engine — they are not
 * reimplemented here. This module covers discipline validate historically
 * left to Python:
 *   1. [NEEDS CLARIFICATION] in a committed (active-or-later) requirement
 *   2. referenced catalogue NFR id missing from shared/nfr.md
 *   3. tag outside shared/taxonomy.md vocabulary (warning-class)
 *   4. child requirement ahead of its parent epic status
 *   5. broken relative Markdown .md link
 *
 * Corpus discovery uses the same walk as validate (explicit BA roots +
 * EXCLUDED_DIR_NAMES) — never a whole-tree rglob into node_modules/.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import type { Graph } from './graph.js'
import { extractNfrMentions } from './body-refs.js'

/** Statuses at which an artefact is considered committed / frozen. */
export const COMMITTED_STATUSES = new Set([
  'active',
  'batched',
  'baselined',
  'approved',
])

export type SemanticFinding = {
  /** Stable check id for validate aggregation. */
  check:
    | 'needs-clarification-committed'
    | 'nfr-catalogue-refs'
    | 'taxonomy-tags'
    | 'child-status-vs-epic'
    | 'markdown-links-resolve-semantic'
  severity: 'error' | 'warning'
  message: string
}

export type SemanticLintResult = {
  findings: SemanticFinding[]
  errors: SemanticFinding[]
  warnings: SemanticFinding[]
  taxonomyPath: string | null
  nfrCataloguePath: string | null
}

function loadTaxonomy(repo: string): { tags: Set<string>; path: string | null } {
  for (const candidate of [
    join(repo, 'shared', 'taxonomy.md'),
    join(repo, '..', 'shared', 'taxonomy.md'),
  ]) {
    if (existsSync(candidate)) {
      const text = readFileSync(candidate, 'utf8')
      return {
        tags: new Set([...text.matchAll(/`([a-z0-9][a-z0-9-]*)`/g)].map((m) => m[1]!)),
        path: candidate,
      }
    }
  }
  return { tags: new Set(), path: null }
}

function loadNfrCatalogue(repo: string): { text: string; path: string | null } {
  for (const candidate of [
    join(repo, 'shared', 'nfr.md'),
    join(repo, '..', 'shared', 'nfr.md'),
  ]) {
    if (existsSync(candidate)) {
      return { text: readFileSync(candidate, 'utf8'), path: candidate }
    }
  }
  return { text: '', path: null }
}

type Doc = {
  id: string
  type: string
  status: string
  epic?: string
  body: string
  /** Absolute path to the page file. */
  absPath: string
  /** Repo-relative POSIX path. */
  relPath: string
}

function collectDocs(repo: string, graph: Graph): Doc[] {
  const docs: Doc[] = []
  const push = (
    id: string,
    type: string,
    status: string,
    body: string,
    epic?: string,
  ) => {
    const rel = graph.pathOf(id)
    if (!rel) return
    docs.push({
      id,
      type,
      status,
      epic,
      body,
      absPath: join(repo, rel),
      relPath: rel,
    })
  }

  for (const e of graph.epics) {
    push(e.frontmatter.id, 'epic', String(e.frontmatter.status ?? ''), e.body)
  }
  for (const fr of graph.frs) {
    push(
      fr.frontmatter.id,
      'fr',
      String(fr.frontmatter.status ?? ''),
      fr.body,
      fr.frontmatter.epic,
    )
  }
  for (const nfr of graph.nfrs) {
    push(
      nfr.frontmatter.id,
      'nfr',
      String(nfr.frontmatter.status ?? ''),
      nfr.body,
      nfr.frontmatter.epic,
    )
  }
  for (const br of graph.brs) {
    push(
      br.frontmatter.id,
      'br',
      String(br.frontmatter.status ?? ''),
      br.body,
      br.frontmatter.epic,
    )
  }
  for (const cr of graph.crs) {
    push(cr.frontmatter.id, 'cr', String(cr.frontmatter.status ?? ''), cr.body)
  }
  for (const wp of graph.wps) {
    push(wp.frontmatter.id, 'wp', String(wp.frontmatter.status ?? ''), wp.body)
  }
  return docs
}

/**
 * Run semantic checks 1–5 against the live graph corpus.
 */
export function runSemanticLint(repo: string, graph: Graph): SemanticLintResult {
  const findings: SemanticFinding[] = []
  const { tags: taxonomy, path: taxonomyPath } = loadTaxonomy(repo)
  const { text: nfrText, path: nfrCataloguePath } = loadNfrCatalogue(repo)

  const epicStatus = new Map<string, string>()
  for (const e of graph.epics) {
    epicStatus.set(e.frontmatter.id, String(e.frontmatter.status ?? '?'))
  }

  const docs = collectDocs(repo, graph)

  for (const doc of docs) {
    // --- 1. NEEDS CLARIFICATION in committed artefact ---
    // Backticks exclude template instructions that mention the marker.
    const found = [
      ...doc.body.matchAll(/(?<!`)\[NEEDS CLARIFICATION:?\s*([^\]]*)/g),
    ]
    if (found.length > 0) {
      const committed = COMMITTED_STATUSES.has(doc.status)
      let head = committed
        ? `${doc.id}: status ${doc.status}, but body has ${found.length} × [NEEDS CLARIFICATION]`
        : `${doc.id} (${doc.status}): ${found.length} × [NEEDS CLARIFICATION]`
      for (const m of found) {
        const q = (m[1] ?? '').replace(/\s+/g, ' ').trim()
        const clipped = q.length > 100 ? `${q.slice(0, 100)}…` : q
        if (clipped) head += `\n             — ${clipped}`
      }
      findings.push({
        check: 'needs-clarification-committed',
        severity: committed ? 'error' : 'warning',
        message: head,
      })
    }

    // --- 2. Catalogue NFR ids must exist in shared/nfr.md ---
    if (nfrCataloguePath) {
      const { catalog } = extractNfrMentions(doc.body)
      for (const ref of catalog) {
        if (!nfrText.includes(ref)) {
          findings.push({
            check: 'nfr-catalogue-refs',
            severity: 'error',
            message: `${doc.id}: references ${ref}, absent from ${relative(repo, nfrCataloguePath).split('\\').join('/') || 'shared/nfr.md'}`,
          })
        }
      }
    }

    // --- 3. Tags against taxonomy vocabulary ---
    const tagLine = doc.body.match(/\*\*Теги\*\*\s*\|\s*(.+?)\s*\|/)
    if (tagLine && taxonomy.size > 0) {
      const raw = tagLine[1]!
      if (!raw.includes('shared/taxonomy')) {
        for (const tag of raw.matchAll(/[a-z0-9][a-z0-9-]*/g)) {
          const t = tag[0]!
          if (!taxonomy.has(t)) {
            findings.push({
              check: 'taxonomy-tags',
              severity: 'warning',
              message: `${doc.id}: tag \`${t}\` absent from shared/taxonomy.md`,
            })
          }
        }
      }
    }

    // --- 4. Child committed while epic still draft/in-review ---
    // Missing epic id is already covered by validate's no-dangling-refs;
    // this check is the semantic status-ordering rule from lint.py.
    if (doc.epic && COMMITTED_STATUSES.has(doc.status) && epicStatus.has(doc.epic)) {
      const ps = epicStatus.get(doc.epic)!
      if (ps === 'draft' || ps === 'in-review') {
        findings.push({
          check: 'child-status-vs-epic',
          severity: 'error',
          message: `${doc.id}: status ${doc.status}, but epic ${doc.epic} is still ${ps}`,
        })
      }
    }

    // --- 5. Broken relative .md links ---
    for (const m of doc.body.matchAll(/\]\((\.\.?\/[^)#]+?\.md)/g)) {
      const target = m[1]!
      if (target.includes('{') || target.includes('XXX')) continue
      const abs = join(dirname(doc.absPath), target)
      if (!existsSync(abs)) {
        findings.push({
          check: 'markdown-links-resolve-semantic',
          severity: 'error',
          message: `${doc.relPath}: broken link ${target}`,
        })
      }
    }
  }

  return {
    findings,
    errors: findings.filter((f) => f.severity === 'error'),
    warnings: findings.filter((f) => f.severity === 'warning'),
    taxonomyPath,
    nfrCataloguePath,
  }
}

/** Aggregate semantic findings into validate check rows. */
export function semanticLintToChecks(result: SemanticLintResult): Array<{
  name: string
  ok: boolean
  reason: string
  severity?: 'advisory'
}> {
  const byCheck = new Map<string, SemanticFinding[]>()
  for (const f of result.findings) {
    const list = byCheck.get(f.check) ?? []
    list.push(f)
    byCheck.set(f.check, list)
  }

  const names = [
    'needs-clarification-committed',
    'nfr-catalogue-refs',
    'taxonomy-tags',
    'child-status-vs-epic',
    'markdown-links-resolve-semantic',
  ] as const

  return names.map((name) => {
    const all = byCheck.get(name) ?? []
    const errors = all.filter((f) => f.severity === 'error')
    const warnings = all.filter((f) => f.severity === 'warning')

    if (name === 'nfr-catalogue-refs' && !result.nfrCataloguePath) {
      return {
        name,
        ok: true,
        reason: 'shared/nfr.md not found — catalogue-ref check skipped',
        severity: 'advisory' as const,
      }
    }
    if (name === 'taxonomy-tags' && !result.taxonomyPath) {
      return {
        name,
        ok: true,
        reason: 'shared/taxonomy.md not found — taxonomy check skipped',
        severity: 'advisory' as const,
      }
    }

    // Errors → hard fail. Warnings alone → advisory (VERIFY-OK, exit 2) so
    // Architect-ready gates that key off VERIFY-FAIL stay aligned with
    // historical lint.py (warnings did not fail the process).
    if (errors.length > 0) {
      return {
        name,
        ok: false,
        reason: errors.map((e) => e.message).join('; '),
      }
    }
    if (warnings.length > 0) {
      return {
        name,
        ok: false,
        reason: warnings.map((w) => w.message).join('; '),
        severity: 'advisory' as const,
      }
    }
    return {
      name,
      ok: true,
      reason:
        name === 'needs-clarification-committed'
          ? 'no committed artefact carries an open [NEEDS CLARIFICATION]'
          : name === 'nfr-catalogue-refs'
            ? 'every catalogue NFR mention resolves in shared/nfr.md'
            : name === 'taxonomy-tags'
              ? 'every Passport tag is in shared/taxonomy.md'
              : name === 'child-status-vs-epic'
                ? 'no committed child is ahead of its epic status'
                : 'every relative .md link in semantic corpus resolves',
    }
  })
}
