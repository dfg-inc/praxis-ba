// ---- rules.ts: rules-as-data precursor (WBS 1.15) ----
// Thin loader for markdown rule files under plugins/ba/rules/ (frontmatter:
// id, roles, stages, severity, overridable). One built-in check is driven
// by a rule file id so violations report that rule id — full knowledge-slice
// override semantics live in @praxis/knowledge; this is the BA-local seed.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import matter from 'gray-matter'
import { z } from 'zod'
import { parseAcBlock, unverifiableAcIds } from './ac.js'
import type { Graph } from './graph.js'

export const BaRuleFrontmatterSchema = z.object({
  id: z.string().min(1),
  roles: z.array(z.string()).min(1),
  stages: z.array(z.string()).min(1),
  severity: z.enum(['mandatory', 'advisory']).default('mandatory'),
  overridable: z.boolean().default(true),
  title: z.string().optional(),
})

export type BaRuleFrontmatter = z.infer<typeof BaRuleFrontmatterSchema>

export type BaRule = {
  path: string
  frontmatter: BaRuleFrontmatter
  body: string
}

export type RuleViolation = {
  ruleId: string
  severity: 'mandatory' | 'advisory'
  targetId: string
  message: string
}

function walkMarkdown(root: string): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  const stack = [root]
  while (stack.length) {
    const cur = stack.pop()!
    for (const name of readdirSync(cur)) {
      const p = join(cur, name)
      const st = statSync(p)
      if (st.isDirectory()) stack.push(p)
      else if (name.endsWith('.md')) out.push(p)
    }
  }
  return out.sort()
}

/** Load every `*.md` rule under `rulesDir`. Invalid frontmatter is skipped
 * with no throw — callers can inspect `errors` if supplied. */
export function loadBaRules(
  rulesDir: string,
  errors?: string[]
): BaRule[] {
  const rules: BaRule[] = []
  for (const path of walkMarkdown(rulesDir)) {
    const raw = readFileSync(path, 'utf8')
    const parsed = matter(raw)
    const fm = BaRuleFrontmatterSchema.safeParse(parsed.data)
    if (!fm.success) {
      errors?.push(
        `${path}: invalid frontmatter: ${fm.error.issues.map((i) => i.path.join('.')).join(', ')}`
      )
      continue
    }
    rules.push({ path, frontmatter: fm.data, body: parsed.content.trim() })
  }
  return rules
}

/** Run the checks named by loaded rule ids against a graph. Unknown rule
 * ids are ignored (data may describe checks not yet wired). At least
 * `ba-ac-gherkin` is implemented here. */
export function evaluateBaRules(rules: readonly BaRule[], graph: Graph): RuleViolation[] {
  const byId = new Map(rules.map((r) => [r.frontmatter.id, r] as const))
  const violations: RuleViolation[] = []

  const acRule = byId.get('ba-ac-gherkin')
  if (acRule) {
    for (const fr of graph.frs) {
      if (fr.frontmatter.status === 'retired' || fr.frontmatter.status === 'superseded') continue
      const ac = parseAcBlock(fr.body)
      if (ac.error !== undefined || ac.acs.length === 0) {
        violations.push({
          ruleId: acRule.frontmatter.id,
          severity: acRule.frontmatter.severity,
          targetId: fr.frontmatter.id,
          message: ac.error ?? 'missing Acceptance Criteria',
        })
        continue
      }
      const bad = unverifiableAcIds(ac.acs)
      if (bad.length > 0) {
        violations.push({
          ruleId: acRule.frontmatter.id,
          severity: acRule.frontmatter.severity,
          targetId: fr.frontmatter.id,
          message: `AC-${bad.join(', AC-')} not in given/when/then (or Дано/Когда/Тогда) form`,
        })
      }
    }
  }

  const goalRule = byId.get('ba-requirement-has-goal')
  if (goalRule) {
    for (const nodes of [graph.frs, graph.nfrs, graph.brs] as const) {
      for (const node of nodes) {
        if (node.frontmatter.status === 'retired' || node.frontmatter.status === 'superseded') continue
        if ((node.frontmatter.goal_ids ?? []).length === 0) {
          violations.push({
            ruleId: goalRule.frontmatter.id,
            severity: goalRule.frontmatter.severity,
            targetId: node.frontmatter.id,
            message: 'requirement has no goal_ids',
          })
        }
      }
    }
  }

  return violations
}
