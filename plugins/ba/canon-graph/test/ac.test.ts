import { describe, it, expect } from 'vitest'
import { parseAcBlock } from '../src/ac'

describe('parseAcBlock — grammar matrix (spec §6.2)', () => {
  it('parses contiguous ACs', () => {
    const r = parseAcBlock(
      '## Acceptance Criteria\n- AC-1: given a, when b, then c\n- AC-2: x'
    )
    expect(r.acs).toEqual([
      { acId: 1, text: 'given a, when b, then c' },
      { acId: 2, text: 'x' },
    ])
    expect(r.warnings).toEqual([])
    expect(r.error).toBeUndefined()
  })

  it('allows a gap in ids (AC-1, AC-3)', () => {
    const r = parseAcBlock('## Acceptance Criteria\n- AC-1: a\n- AC-3: c')
    expect(r.acs).toEqual([
      { acId: 1, text: 'a' },
      { acId: 3, text: 'c' },
    ])
    expect(r.error).toBeUndefined()
  })

  it('joins continuation lines', () => {
    const r = parseAcBlock('## Acceptance Criteria\n- AC-1: first\n  second')
    expect(r.acs).toEqual([{ acId: 1, text: 'first second' }])
  })

  it('joins multiple consecutive continuation lines to the same AC', () => {
    const r = parseAcBlock(
      '## Acceptance Criteria\n- AC-1: first\n  second\n  third'
    )
    expect(r.acs).toEqual([{ acId: 1, text: 'first second third' }])
  })

  it('flags a duplicate id as error', () => {
    const r = parseAcBlock('## Acceptance Criteria\n- AC-1: a\n- AC-1: b')
    expect(r.error).toMatch(/duplicate/i)
  })

  it('reports only the first duplicate when two different ids each repeat', () => {
    const r = parseAcBlock(
      '## Acceptance Criteria\n- AC-1: a\n- AC-1: b\n- AC-2: c\n- AC-2: d'
    )
    expect(r.error).toMatch(/AC-1/)
  })

  it('warns on a non-AC bullet', () => {
    const r = parseAcBlock('## Acceptance Criteria\n- AC-1: a\n- nope: b')
    expect(r.warnings.length).toBe(1)
  })

  it('does not attach a continuation line to a stale AC after an intervening non-AC bullet', () => {
    const r = parseAcBlock(
      '## Acceptance Criteria\n- nope: b\n  stray\n- AC-1: a'
    )
    expect(r.acs).toEqual([{ acId: 1, text: 'a' }])
    expect(r.warnings.length).toBe(1)
  })

  it('ignores blank lines between bullets', () => {
    const r = parseAcBlock(
      '## Acceptance Criteria\n- AC-1: a\n\n- AC-2: b'
    )
    expect(r.acs).toEqual([
      { acId: 1, text: 'a' },
      { acId: 2, text: 'b' },
    ])
    expect(r.warnings).toEqual([])
  })

  it('stops at the next ## heading (content after is excluded)', () => {
    const r = parseAcBlock(
      '## Acceptance Criteria\n- AC-1: a\n## Notes\n- AC-9: should not count'
    )
    expect(r.acs).toEqual([{ acId: 1, text: 'a' }])
  })

  it('isolates the section when it is preceded by other ## sections', () => {
    const r = parseAcBlock(
      '## Summary\nsome prose\n## Acceptance Criteria\n- AC-1: a'
    )
    expect(r.acs).toEqual([{ acId: 1, text: 'a' }])
  })

  it('returns empty acs/warnings when the section has no bullets before the next heading', () => {
    const r = parseAcBlock('## Acceptance Criteria\n## Notes\nsomething')
    expect(r).toEqual({ acs: [], warnings: [] })
  })

  it('returns empty acs/warnings when there is no Acceptance Criteria heading at all', () => {
    const r = parseAcBlock('## Summary\nsome prose, no AC section here')
    expect(r).toEqual({ acs: [], warnings: [] })
  })

  it('returns empty acs/warnings for an empty body', () => {
    const r = parseAcBlock('')
    expect(r).toEqual({ acs: [], warnings: [] })
  })
})
