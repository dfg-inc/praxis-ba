// ---- one-pager.ts: WBS 1.14 client page from a *live* canonical FR ----
// Derived output only. Resolves the FR through `loadGraph` / `walkCanonFiles`
// (baselines/ excluded) — never a second tree walk, never a frozen copy.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { NEXT_HEADING, parseAcBlock, SECTION_HEADING } from './ac.js'
import type { Graph } from './graph.js'
import { loadGraph } from './writer.js'

export type OnePagerOk = {
  ok: true
  markdown: string
  sourcePath: string
  outPath: string
}

export type OnePagerFail = { ok: false; error: string }

export type OnePagerResult = OnePagerOk | OnePagerFail

function section(body: string, names: readonly string[]): string {
  const map: Record<string, string> = {}
  let current = ''
  for (const line of body.split(/\r?\n/)) {
    const m = /^##\s+(.+)\s*$/.exec(line)
    if (m) {
      current = m[1]!.trim().toLowerCase()
      map[current] = ''
      continue
    }
    if (current) map[current] += `${line}\n`
  }
  for (const n of names) {
    const v = (map[n.toLowerCase()] ?? '').trim()
    if (v) return v
  }
  return ''
}

/** Raw Acceptance Criteria section body, preserving source AC text. */
export function extractAcceptanceCriteriaSource(body: string): string {
  const lines = body.split('\n').map((line) => line.replace(/\r$/, ''))
  const headingIndex = lines.findIndex((line) => SECTION_HEADING.test(line))
  if (headingIndex === -1) return ''
  const collected: string[] = []
  for (let i = headingIndex + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (NEXT_HEADING.test(line)) break
    collected.push(line)
  }
  return collected.join('\n').trim()
}

function lookupKind(
  graph: Graph,
  id: string,
): 'fr' | 'nfr' | 'br' | 'goal' | 'wp' | 'cr' | 'epic' | 'bug' | undefined {
  if (graph.frs.some((n) => n.frontmatter.id === id)) return 'fr'
  if (graph.nfrs.some((n) => n.frontmatter.id === id)) return 'nfr'
  if (graph.brs.some((n) => n.frontmatter.id === id)) return 'br'
  if (graph.goals.some((n) => n.frontmatter.id === id)) return 'goal'
  if (graph.wps.some((n) => n.frontmatter.id === id)) return 'wp'
  if (graph.crs.some((n) => n.frontmatter.id === id)) return 'cr'
  if (graph.epics.some((n) => n.frontmatter.id === id)) return 'epic'
  if (graph.bugs.some((n) => n.frontmatter.id === id)) return 'bug'
  return undefined
}

/** Build the one-pager markdown without writing. Does not touch the FR file. */
export function buildOnePager(repo: string, id: string): OnePagerResult {
  const graph = loadGraph(repo)
  const kind = lookupKind(graph, id)
  if (kind === undefined) {
    return { ok: false, error: `FAIL: requirement ${id} not found` }
  }
  if (kind !== 'fr') {
    return { ok: false, error: `FAIL: ${id} is not an FR` }
  }
  const fr = graph.frs.find((n) => n.frontmatter.id === id)
  if (!fr) return { ok: false, error: `FAIL: requirement ${id} not found` }

  const sourcePath = graph.pathOf(id) ?? `epics/${fr.frontmatter.epic}-x/${id}.md`
  const purpose = section(fr.body, ['назначение', 'purpose', 'summary', 'intent'])
  const value = section(fr.body, ['пользовательская ценность', 'user value', 'value', 'что сможет пользователь'])
  const ac = parseAcBlock(fr.body)
  const ready = extractAcceptanceCriteriaSource(fr.body)

  if (!purpose) {
    return { ok: false, error: 'FAIL: one-pager not emitted; missing: назначение/purpose' }
  }
  if (ac.error !== undefined || ac.acs.length === 0 || ready.length === 0) {
    return { ok: false, error: 'FAIL: one-pager not emitted; missing: Acceptance Criteria' }
  }

  const markdown = [
    `# One-pager: ${id}`,
    '',
    '## Назначение',
    '',
    purpose,
    '',
    '## Что сможет пользователь',
    '',
    value || '_не заполнено в источнике_',
    '',
    '## Условия готовности',
    '',
    ready,
    '',
    `Source: ${sourcePath}`,
    '',
  ].join('\n')

  return { ok: true, markdown, sourcePath, outPath: join(repo, 'one-pagers', `${id}.md`) }
}

export function writeOnePager(repo: string, id: string, outPath?: string): OnePagerResult {
  const built = buildOnePager(repo, id)
  if (!built.ok) return built
  const dest = outPath ?? built.outPath
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, built.markdown, 'utf8')
  return { ...built, outPath: dest }
}
