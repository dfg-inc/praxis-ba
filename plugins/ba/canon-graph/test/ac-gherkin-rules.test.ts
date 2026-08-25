import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { isVerifiableAc, parseAcBlock, unverifiableAcIds } from '../src/ac'
import { buildGraph } from '../src/graph'
import { parsePage } from '../src/parse'
import { evaluateBaRules, loadBaRules } from '../src/rules'

describe('isVerifiableAc / Gherkin enforcement', () => {
  it('passes English given/when/then', () => {
    expect(isVerifiableAc('given a user is logged in, when they click save, then the draft persists')).toBe(true)
  })

  it('passes Russian Дано/Когда/Тогда', () => {
    expect(isVerifiableAc('Дано пользователь вошёл, Когда нажимает сохранить, Тогда черновик сохранён')).toBe(true)
  })

  it('fails when a keyword is missing', () => {
    expect(isVerifiableAc('when the user clicks, then something happens')).toBe(false)
    expect(isVerifiableAc('Something observable happens.')).toBe(false)
  })

  it('unverifiableAcIds reports only bad ACs', () => {
    const { acs } = parseAcBlock(
      '## Acceptance Criteria\n- AC-1: given a, when b, then c\n- AC-2: not gherkin\n'
    )
    expect(unverifiableAcIds(acs)).toEqual([2])
  })
})

describe('loadBaRules / evaluateBaRules', () => {
  const rulesDir = fileURLToPath(new URL('../../rules', import.meta.url))

  it('loads rule files with frontmatter ids', () => {
    const rules = loadBaRules(rulesDir)
    expect(rules.map((r) => r.frontmatter.id).sort()).toEqual([
      'ba-ac-gherkin',
      'ba-requirement-has-goal',
    ])
  })

  it('reports ba-ac-gherkin on unverifiable AC', () => {
    const rules = loadBaRules(rulesDir)
    const fr = parsePage(
      `---
id: E1-FR1
type: fr
epic: E1
status: active
version: 1
traces_to: []
enforces: []
references_nfr: []
related: []
---

Story.

## Acceptance Criteria
- AC-1: Something observable happens.
`,
      'fr'
    )
    if ('error' in fr) throw new Error(fr.error)
    const violations = evaluateBaRules(rules, buildGraph([fr]))
    expect(violations.some((v) => v.ruleId === 'ba-ac-gherkin' && v.targetId === 'E1-FR1')).toBe(true)
  })

  it('reports ba-requirement-has-goal when goal_ids absent', () => {
    const rules = loadBaRules(rulesDir)
    const fr = parsePage(
      `---
id: E1-FR1
type: fr
epic: E1
status: active
version: 1
traces_to: []
enforces: []
references_nfr: []
related: []
---

Story.

## Acceptance Criteria
- AC-1: given a, when b, then c
`,
      'fr'
    )
    if ('error' in fr) throw new Error(fr.error)
    const violations = evaluateBaRules(rules, buildGraph([fr]))
    expect(violations.some((v) => v.ruleId === 'ba-requirement-has-goal')).toBe(true)
  })
})
