// ---- status.ts: structured missing-item detector (WBS 1.6) ----
// Pure — no IO. Extends the rollup `status` CLI beyond per-type counts with
// named gaps: FRs without (verifiable) AC, requirements not linked to any
// WP Scope, requirements without goals.

import { parseAcBlock, unverifiableAcIds } from './ac.js'
import type { Graph } from './graph.js'
import { checkGoals } from './goals.js'
import { naturalCompare } from './serialize.js'

export type MissingKind =
  | 'requirement-without-ac'
  | 'requirement-unverifiable-ac'
  | 'requirement-not-linked-to-wp'
  | 'requirement-without-goal'
  | 'goal-without-requirements'

export type MissingItem = {
  kind: MissingKind
  id: string
  detail: string
}

function isOpenRequirementStatus(status: string): boolean {
  return status !== 'retired' && status !== 'superseded'
}

/** Every requirement id that appears in any WP's Scope (all four buckets)
 * or in a WP closure's folded enforces/references_nfr set. */
function requirementIdsLinkedToWp(graph: Graph): Set<string> {
  const linked = new Set<string>()
  for (const wp of graph.wps) {
    if (wp.frontmatter.status === 'abandoned') continue
    const scope = graph.wpScope(wp.frontmatter.id)
    for (const ref of [...scope.frs, ...scope.nfrs, ...scope.brs]) linked.add(ref.id)
    const closure = graph.closure(wp.frontmatter.id)
    for (const id of [...closure.frs, ...closure.nfrs, ...closure.brs]) linked.add(id)
  }
  return linked
}

/** Structured missing items for the status rollup — not only counts. */
export function findMissingItems(graph: Graph): MissingItem[] {
  const items: MissingItem[] = []
  const linkedToWp = requirementIdsLinkedToWp(graph)

  for (const fr of graph.frs) {
    if (!isOpenRequirementStatus(fr.frontmatter.status)) continue
    const ac = parseAcBlock(fr.body)
    if (ac.error !== undefined || ac.acs.length === 0) {
      items.push({
        kind: 'requirement-without-ac',
        id: fr.frontmatter.id,
        detail: ac.error ?? 'has no Acceptance Criteria',
      })
    } else {
      const bad = unverifiableAcIds(ac.acs)
      if (bad.length > 0) {
        items.push({
          kind: 'requirement-unverifiable-ac',
          id: fr.frontmatter.id,
          detail: `AC-${bad.join(', AC-')} unverifiable (need given/when/then or Дано/Когда/Тогда)`,
        })
      }
    }
  }

  for (const nodes of [graph.frs, graph.nfrs, graph.brs] as const) {
    for (const node of nodes) {
      if (!isOpenRequirementStatus(node.frontmatter.status)) continue
      if (!linkedToWp.has(node.frontmatter.id)) {
        items.push({
          kind: 'requirement-not-linked-to-wp',
          id: node.frontmatter.id,
          detail: 'not referenced by any open WP Scope/closure',
        })
      }
    }
  }

  const goals = checkGoals(graph)
  for (const id of goals.requirementsWithoutGoals) {
    items.push({
      kind: 'requirement-without-goal',
      id,
      detail: 'goal_ids empty or absent',
    })
  }
  for (const id of goals.goalsWithoutRequirements) {
    items.push({
      kind: 'goal-without-requirements',
      id,
      detail: 'no FR/NFR/BR cites this goal',
    })
  }

  return items.sort(
    (a, b) => naturalCompare(a.kind, b.kind) || naturalCompare(a.id, b.id)
  )
}
