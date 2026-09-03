import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { stringify as yamlStringify } from 'yaml'
import { describe, expect, it } from 'vitest'
import { parseBugBody, unresolvedAffects } from '../src/bug-contract.js'
import { loadGraph } from '../src/writer.js'
import type { Counters } from '../src/ids.js'

function seedCanon(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bug-contract-'))
  mkdirSync(join(dir, '.ba'), { recursive: true })
  const counters: Counters = {
    product: { epic: 1, cr: 0, wp: 0, bug: 0, baselineSeq: {} },
    epics: { E1: { fr: 1, nfr: 0, br: 0 } },
    retired: [],
  }
  writeFileSync(join(dir, '.ba', 'counters.yaml'), yamlStringify(counters), 'utf8')
  const fr = join(dir, 'epics/E1-x/E1-FR1.md')
  mkdirSync(dirname(fr), { recursive: true })
  writeFileSync(
    fr,
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
  )
  return dir
}

describe('parseBugBody', () => {
  it('keeps Repro / Expected / Actual distinct', () => {
    const parsed = parseBugBody(
      ['**Repro:**', '1. Open released page', '2. Click Save', '', '**Expected:** Save persists.', '', '**Actual:** Save 500s.'].join(
        '\n',
      ),
    )
    expect('error' in parsed).toBe(false)
    if ('error' in parsed) return
    expect(parsed.repro).toMatch(/Open released page/)
    expect(parsed.expected).toMatch(/persists/)
    expect(parsed.actual).toMatch(/500/)
    expect(parsed.expected).not.toBe(parsed.actual)
  })

  it('rejects missing sections', () => {
    expect(parseBugBody('just prose')).toMatchObject({ error: expect.stringMatching(/Repro/) })
    expect(parseBugBody('**Repro:** a\n**Expected:** b\n')).toMatchObject({
      error: expect.stringMatching(/Actual/),
    })
  })
})

describe('unresolvedAffects', () => {
  it('requires an existing FR/NFR/BR', () => {
    const graph = loadGraph(seedCanon())
    expect(unresolvedAffects(['E1-FR1'], graph)).toEqual([])
    expect(unresolvedAffects(['E9-FR9'], graph)).toEqual(['E9-FR9'])
    expect(unresolvedAffects(['not-an-id'], graph)).toEqual(['not-an-id'])
  })
})
