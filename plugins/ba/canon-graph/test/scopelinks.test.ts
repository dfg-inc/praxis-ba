import fc from 'fast-check'
import { describe, it, expect } from 'vitest'
import { parseScope, slugifyHeading, pageAnchors } from '../src/scopelinks'

const BODY = `Goal sentence.

## Scope

### Change requests
- [CR-017 — bottom menu bar](product/cr/CR-017.md)

### Delivers
- [E2-FR7 v1](product/epics/E2-bubble-board/E2-FR7.md#acceptance-criteria)

### Constraints
- [E1-NFR6 v2 — i18n](product/epics/E1-foundation-access/E1-NFR6.md#planguage)
- [E2-BR2](product/br/E2-BR2.md)
`

describe('parseScope', () => {
  it('parses all four buckets with version/label/anchor', () => {
    const s = parseScope(BODY)
    expect(s.errors).toEqual([])
    expect(s.crs).toEqual([{ id: 'CR-017', label: 'bottom menu bar', path: 'product/cr/CR-017.md' }])
    expect(s.frs).toEqual([{ id: 'E2-FR7', version: 1, path: 'product/epics/E2-bubble-board/E2-FR7.md', anchor: 'acceptance-criteria' }])
    expect(s.nfrs[0]).toEqual({ id: 'E1-NFR6', version: 2, label: 'i18n', path: 'product/epics/E1-foundation-access/E1-NFR6.md', anchor: 'planguage' })
    expect(s.brs[0]).toEqual({ id: 'E2-BR2', path: 'product/br/E2-BR2.md' })
  })
  it('errors on wrong id class per bucket, malformed lines, and missing sections', () => {
    expect(parseScope(BODY.replace('E2-FR7 v1', 'E1-NFR6 v1')).errors.length).toBeGreaterThan(0)
    expect(parseScope('no scope here').errors).toContain('missing ## Scope section')
    expect(parseScope('## Scope\n\n### Delivers\n- [E2-FR7](broken').errors.length).toBeGreaterThan(0)
  })
  it('slugifies like GitHub for our heading shapes', () => {
    expect(slugifyHeading('Acceptance Criteria')).toBe('acceptance-criteria')
    expect(slugifyHeading('v2 — 20260718 — CR-017')).toBe('v2--20260718--cr-017')
  })
  it('pageAnchors dedups repeats with -N suffixes', () => {
    const a = pageAnchors('## Rationale\n\n## Rationale\n')
    expect(a.has('rationale')).toBe(true)
    expect(a.has('rationale-1')).toBe(true)
  })
  it('property: every well-formed generated link line round-trips through parseScope', () => {
    const idArb = fc.tuple(fc.integer({ min: 1, max: 20 }), fc.integer({ min: 1, max: 30 })).map(([e, n]) => `E${e}-FR${n}`)
    fc.assert(fc.property(idArb, fc.option(fc.integer({ min: 1, max: 9 }), { nil: undefined }), (id, v) => {
      const link = `- [${id}${v ? ` v${v}` : ''}](product/epics/X/${id}.md#acceptance-criteria)`
      const s = parseScope(`## Scope\n\n### Delivers\n${link}\n`)
      return s.errors.length === 0 && s.frs[0]!.id === id && s.frs[0]!.version === v
    }))
  })
})
