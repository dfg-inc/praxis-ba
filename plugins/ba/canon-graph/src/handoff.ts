/**
 * BA → Architect machine handoff (ba.architect.handoff).
 * Shared by praxis-ba `wp approve-plan` and tools/emit-architect-handoff.mjs.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

export type BaArchitectHandoff = {
  contract: 'ba.architect.handoff'
  version: string
  workPackageId: string
  workPackagePath: string
  requirementIds: string[]
  visionConfirmed: boolean
  readinessChecks: Array<{ id: string; passed: boolean; detail?: string }>
}

export type EmitBaArchitectHandoffResult = {
  path: string
  handoff: BaArchitectHandoff
}

/**
 * Build and write ba.architect.handoff for a plan-approved / ready / accepted WP.
 */
export function emitBaArchitectHandoff(
  repo: string,
  wpId: string,
  outPath?: string,
): EmitBaArchitectHandoffResult {
  const wpIndex = join(repo, 'wp', wpId, 'index.md')
  if (!existsSync(wpIndex)) {
    throw new Error(`WP index not found: ${wpIndex}`)
  }

  const body = readFileSync(wpIndex, 'utf8')
  const fmMatch = body.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fmMatch) {
    throw new Error(`WP missing frontmatter: ${wpIndex}`)
  }
  const fm = fmMatch[1]!
  const status = (fm.match(/^status:\s*(.+)$/m) ?? [])[1]?.trim()
  if (!status || !['ready', 'plan-approved', 'accepted'].includes(status)) {
    throw new Error(`WP status not handoff-ready: ${status}`)
  }

  const reqIds = [...body.matchAll(/\[([A-Z0-9]+-FR\d+)(?:\s+v\d+)?\]/g)].map((m) => m[1]!)
  const uniqueReqs = [...new Set(reqIds)]
  if (uniqueReqs.length === 0) {
    throw new Error('no requirement ids found in Scope Delivers')
  }

  const visionPath = join(repo, 'vision.md')
  const visionConfirmed =
    existsSync(visionPath) && /status:\s*confirmed/.test(readFileSync(visionPath, 'utf8'))

  const handoff: BaArchitectHandoff = {
    contract: 'ba.architect.handoff',
    version: '0.1.0',
    workPackageId: wpId,
    workPackagePath: relative(repo, wpIndex).split('\\').join('/'),
    requirementIds: uniqueReqs,
    visionConfirmed,
    readinessChecks: [
      { id: 'wp-status', passed: true, detail: status },
      { id: 'vision', passed: visionConfirmed },
      {
        id: 'requirements-present',
        passed: uniqueReqs.length > 0,
        detail: uniqueReqs.join(','),
      },
    ],
  }

  const out =
    outPath ?? join(repo, 'wp', wpId, 'handoffs', 'ba-architect.handoff.json')
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(handoff, null, 2)}\n`)
  return { path: out, handoff }
}
