// ---- goals.ts: goals-layer status (WBS 1.11 + 1.16) ----
// Pure — no IO. `checkGoals` lists requirements without a goal link and
// goals that no requirement cites (unclosed). Backlinks are reverse-walked
// from FR/NFR/BR `goal_ids` via `graph.goalRequirements` (never stored on
// the goal page).

import type { Graph } from './graph.js'
import { naturalCompare } from './serialize.js'

export type GoalsCheckResult = {
  /** FR/NFR/BR ids (non-retired) with empty/absent `goal_ids`. */
  requirementsWithoutGoals: string[]
  /** Goal ids (non-retired) that no requirement cites. */
  goalsWithoutRequirements: string[]
}

function isOpenRequirementStatus(status: string): boolean {
  return status !== 'retired' && status !== 'superseded'
}

/** Lists requirements without goals and goals with zero linked requirements. */
export function checkGoals(graph: Graph): GoalsCheckResult {
  const requirementsWithoutGoals: string[] = []
  for (const nodes of [graph.frs, graph.nfrs, graph.brs] as const) {
    for (const node of nodes) {
      if (!isOpenRequirementStatus(node.frontmatter.status)) continue
      const goals = node.frontmatter.goal_ids ?? []
      if (goals.length === 0) requirementsWithoutGoals.push(node.frontmatter.id)
    }
  }
  requirementsWithoutGoals.sort(naturalCompare)

  const goalsWithoutRequirements: string[] = []
  for (const goal of graph.goals) {
    if (goal.frontmatter.status === 'retired') continue
    if (graph.goalRequirements(goal.frontmatter.id).length === 0) {
      goalsWithoutRequirements.push(goal.frontmatter.id)
    }
  }
  goalsWithoutRequirements.sort(naturalCompare)

  return { requirementsWithoutGoals, goalsWithoutRequirements }
}
