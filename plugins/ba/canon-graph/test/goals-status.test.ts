import { describe, it, expect } from 'vitest'
import { buildGraph, type Graph } from '../src/graph'
import { parsePage, type ParsedPage } from '../src/parse'
import { checkGoals } from '../src/goals'
import { findMissingItems } from '../src/status'

function page(raw: string, type: Parameters<typeof parsePage>[1]): ParsedPage {
  const r = parsePage(raw, type)
  if ('error' in r) throw new Error(`fixture page failed to parse: ${r.error}`)
  return r
}

function graphFrom(pages: ParsedPage[]): Graph {
  return buildGraph(pages)
}

describe('checkGoals', () => {
  it('lists requirements without goals and goals with zero requirements', () => {
    const pages = [
      page(
        '---\nid: G1\ntype: goal\ntitle: Retain users\nstatus: active\n---\n\nOutcome.\n',
        'goal'
      ),
      page(
        '---\nid: G2\ntype: goal\ntitle: Orphan goal\nstatus: active\n---\n\nOutcome.\n',
        'goal'
      ),
      page(
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
goal_ids: [G1]
---

Story.

## Acceptance Criteria
- AC-1: given a, when b, then c
`,
        'fr'
      ),
      page(
        `---
id: E1-FR2
type: fr
epic: E1
status: active
version: 1
traces_to: []
enforces: []
references_nfr: []
related: []
---

Story without goal.

## Acceptance Criteria
- AC-1: given a, when b, then c
`,
        'fr'
      ),
      page(
        `---
id: E1-NFR1
type: nfr
epic: E1
status: active
version: 1
traces_to: []
verified_by: []
related: []
---

Constraint.
`,
        'nfr'
      ),
    ]
    const g = graphFrom(pages)
    const result = checkGoals(g)
    expect(result.requirementsWithoutGoals).toEqual(['E1-FR2', 'E1-NFR1'])
    expect(result.goalsWithoutRequirements).toEqual(['G2'])
    expect(g.goalRequirements('G1')).toEqual(['E1-FR1'])
  })

  it('ignores retired requirements and retired goals', () => {
    const pages = [
      page('---\nid: G1\ntype: goal\ntitle: Done\nstatus: retired\n---\n\n.', 'goal'),
      page(
        `---
id: E1-FR1
type: fr
epic: E1
status: retired
version: 1
traces_to: []
enforces: []
references_nfr: []
related: []
---

Retired.
`,
        'fr'
      ),
    ]
    const result = checkGoals(graphFrom(pages))
    expect(result.requirementsWithoutGoals).toEqual([])
    expect(result.goalsWithoutRequirements).toEqual([])
  })
})

describe('findMissingItems', () => {
  it('reports FR without AC, unverifiable AC, and not linked to WP', () => {
    const pages = [
      page(
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

No AC section.
`,
        'fr'
      ),
      page(
        `---
id: E1-FR2
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
      ),
    ]
    const missing = findMissingItems(graphFrom(pages))
    expect(missing.some((m) => m.kind === 'requirement-without-ac' && m.id === 'E1-FR1')).toBe(true)
    expect(missing.some((m) => m.kind === 'requirement-unverifiable-ac' && m.id === 'E1-FR2')).toBe(true)
    expect(missing.some((m) => m.kind === 'requirement-not-linked-to-wp' && m.id === 'E1-FR1')).toBe(true)
    expect(missing.some((m) => m.kind === 'requirement-without-goal')).toBe(true)
  })

  it('does not flag FR linked via WP Scope as not-linked-to-wp', () => {
    const pages = [
      page(
        `---
id: E1-FR1
type: fr
epic: E1
status: active
version: 1
traces_to: [CR-001]
enforces: []
references_nfr: []
related: []
goal_ids: [G1]
---

Story.

## Acceptance Criteria
- AC-1: given a, when b, then c
`,
        'fr'
      ),
      page('---\nid: CR-001\ntype: cr\nstatus: confirmed\n---\n\nAsk.\n', 'cr'),
      page('---\nid: G1\ntype: goal\ntitle: Linked\nstatus: active\n---\n\n.', 'goal'),
      page(
        `---
id: WP-20260101-001
type: wp
role: developer
status: draft
---

Intent.

## Scope

### Change requests
- [CR-001](product/cr/CR-001.md)

### Delivers
- [E1-FR1](product/epics/E1-x/E1-FR1.md)

### Constraints
`,
        'wp'
      ),
    ]
    const missing = findMissingItems(graphFrom(pages))
    expect(missing.some((m) => m.kind === 'requirement-not-linked-to-wp')).toBe(false)
    expect(missing.some((m) => m.kind === 'requirement-without-ac')).toBe(false)
    expect(missing.some((m) => m.kind === 'requirement-without-goal')).toBe(false)
  })
})
