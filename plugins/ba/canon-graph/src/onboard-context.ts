// WBS 1.3.1 / 1.3.3 — deterministic onboard context layer (no invented intent).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseFile } from './parse.js'
import { loadGraph } from './writer.js'

export const ONBOARD_CONTEXT_FILES = [
  { rel: 'shared/data-model.md', template: 'data-model.md', marker: /data model|сущност/i },
  { rel: 'shared/integrations.md', template: 'integrations.md', marker: /integrat|интеграц/i },
  { rel: 'shared/rbac.md', template: 'rbac.md', marker: /rbac|ролев/i },
  { rel: 'shared/nfr.md', template: 'nfr-catalog.md', marker: /nfr|нфр/i },
  { rel: 'glossary.md', template: 'glossary.md', marker: /glossary|глоссар|термин/i },
  { rel: 'as-is.md', template: 'as-is.md', marker: /as-is|as is|текущ/i },
  { rel: 'project.md', template: 'project.md', marker: /проект|product|суть/i },
] as const

export type OnboardCheck = {
  present: string[]
  missing: string[]
  headingGaps: string[]
  protected: string[]
}

export function checkOnboardContext(projectRoot: string): OnboardCheck {
  const present: string[] = []
  const missing: string[] = []
  const headingGaps: string[] = []
  for (const f of ONBOARD_CONTEXT_FILES) {
    const path = join(projectRoot, f.rel)
    if (!existsSync(path)) {
      missing.push(f.rel)
      continue
    }
    present.push(f.rel)
    const text = readFileSync(path, 'utf8')
    if (!f.marker.test(text)) headingGaps.push(f.rel)
  }
  return { present, missing, headingGaps, protected: [] }
}

/** Copy missing layer templates. Never overwrite existing files (including
 * confirmed vision / baselined requirements under --canon). */
export function initOnboardContext(opts: {
  projectRoot: string
  templatesDir: string
  canonDir?: string
}): { created: string[]; skipped: string[]; protected: string[] } {
  const created: string[] = []
  const skipped: string[] = []
  const protectedPaths: string[] = []

  if (opts.canonDir) {
    const visionPath = join(opts.canonDir, 'vision.md')
    if (existsSync(visionPath)) {
      const parsed = parseFile(visionPath, 'vision')
      if (
        !('error' in parsed) &&
        (parsed.frontmatter as { status?: string }).status === 'confirmed'
      ) {
        protectedPaths.push('vision.md')
      }
    }
    const graph = loadGraph(opts.canonDir)
    for (const n of [...graph.frs, ...graph.nfrs, ...graph.brs]) {
      if (n.frontmatter.status === 'baselined') {
        protectedPaths.push(n.frontmatter.id)
      }
    }
  }

  for (const f of ONBOARD_CONTEXT_FILES) {
    const dest = join(opts.projectRoot, f.rel)
    if (existsSync(dest)) {
      skipped.push(f.rel)
      continue
    }
    const src = join(opts.templatesDir, f.template)
    if (!existsSync(src)) {
      skipped.push(f.rel)
      continue
    }
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, readFileSync(src, 'utf8'))
    created.push(f.rel)
  }
  return { created, skipped, protected: protectedPaths }
}

export function knownCanonMeanings(canonDir: string): string[] {
  if (!existsSync(canonDir)) return []
  const graph = loadGraph(canonDir)
  const out: string[] = []
  for (const n of [...graph.crs, ...graph.frs, ...graph.nfrs, ...graph.brs]) {
    out.push(`${n.frontmatter.id}\n${n.body}`)
  }
  return out
}
