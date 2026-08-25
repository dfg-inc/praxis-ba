import { describe, it, expect } from 'vitest'
import { shouldBump, type PageBody } from '../src/versiondiff'

const page = (body: string, frontmatter: unknown = {}): PageBody => ({ frontmatter, body })

describe('shouldBump — FR (spec §4.1a: AC block canonicalized by sorted acId)', () => {
  it('does NOT bump when two ACs are reordered', () => {
    const oldPage = page(
      'Story.\n\n## Acceptance Criteria\n- AC-1: given a, when b, then c\n- AC-2: x\n'
    )
    const newPage = page(
      'Story.\n\n## Acceptance Criteria\n- AC-2: x\n- AC-1: given a, when b, then c\n'
    )
    expect(shouldBump('fr', oldPage, newPage)).toBe(false)
  })

  it('bumps when an AC id changes (even if the AC set order looks stable)', () => {
    const oldPage = page('## Acceptance Criteria\n- AC-1: a\n- AC-2: b\n')
    const newPage = page('## Acceptance Criteria\n- AC-1: a\n- AC-3: b\n')
    expect(shouldBump('fr', oldPage, newPage)).toBe(true)
  })

  it('bumps when an AC\'s text changes', () => {
    const oldPage = page(
      '## Acceptance Criteria\n- AC-1: given a, when b, then c\n- AC-2: x\n'
    )
    const newPage = page(
      '## Acceptance Criteria\n- AC-1: given a, when b, then CHANGED\n- AC-2: x\n'
    )
    expect(shouldBump('fr', oldPage, newPage)).toBe(true)
  })

  it('does NOT bump on a frontmatter-only edit (e.g. adding a ref) with identical body', () => {
    const oldPage = page('## Acceptance Criteria\n- AC-1: a\n', { traces_to: [] })
    const newPage = page('## Acceptance Criteria\n- AC-1: a\n', { traces_to: ['CR-001'] })
    expect(shouldBump('fr', oldPage, newPage)).toBe(false)
  })

  it('still detects a change in content that falls AFTER the AC block', () => {
    const oldPage = page('## Acceptance Criteria\n- AC-1: a\n## Notes\nfoo\n')
    const newPage = page('## Acceptance Criteria\n- AC-1: a\n## Notes\nbar\n')
    expect(shouldBump('fr', oldPage, newPage)).toBe(true)
  })

  it('is a no-op (false) when there is no Acceptance Criteria section at all and prose is unchanged', () => {
    const oldPage = page('Just a story, no AC section.')
    const newPage = page('Just a story, no AC section.  ')
    expect(shouldBump('fr', oldPage, newPage)).toBe(false)
  })
})

describe('shouldBump — NFR (spec §4.1a: whole normalized body, the Planguage block)', () => {
  it('bumps when a Planguage line changes', () => {
    const oldPage = page('## Planguage\nGoal: p95 < 200ms\nFail: p95 >= 500ms\n')
    const newPage = page('## Planguage\nGoal: p95 < 150ms\nFail: p95 >= 500ms\n')
    expect(shouldBump('nfr', oldPage, newPage)).toBe(true)
  })

  it('does NOT bump on a trailing-whitespace-only change', () => {
    const oldPage = page('## Planguage\nGoal: p95 < 200ms\nFail: p95 >= 500ms\n')
    const newPage = page('## Planguage\nGoal: p95 < 200ms   \nFail: p95 >= 500ms   \n')
    expect(shouldBump('nfr', oldPage, newPage)).toBe(false)
  })

  it('does NOT bump when only trailing blank lines are added', () => {
    const oldPage = page('## Planguage\nGoal: p95 < 200ms\n')
    const newPage = page('## Planguage\nGoal: p95 < 200ms\n\n\n')
    expect(shouldBump('nfr', oldPage, newPage)).toBe(false)
  })

  it('unifies CRLF vs LF line endings (no spurious bump)', () => {
    const oldPage = page('## Planguage\r\nGoal: p95 < 200ms\r\n')
    const newPage = page('## Planguage\nGoal: p95 < 200ms\n')
    expect(shouldBump('nfr', oldPage, newPage)).toBe(false)
  })
})

describe('shouldBump — BR (spec §4.1a: whole normalized body, rule sentence + example)', () => {
  it('bumps when the rule sentence changes', () => {
    const oldPage = page('Money math never uses floating point.\n\nExample: ...\n')
    const newPage = page('Money math never uses floating point, ever.\n\nExample: ...\n')
    expect(shouldBump('br', oldPage, newPage)).toBe(true)
  })

  it('does NOT bump on a frontmatter-only edit', () => {
    const oldPage = page('Money math never uses floating point.\n', { status: 'active' })
    const newPage = page('Money math never uses floating point.\n', { status: 'batched' })
    expect(shouldBump('br', oldPage, newPage)).toBe(false)
  })
})

describe('shouldBump — other node types default to whole-body compare', () => {
  it('bumps a CR body content change', () => {
    const oldPage = page('Words describing the change request.')
    const newPage = page('Words describing the change request, revised.')
    expect(shouldBump('cr', oldPage, newPage)).toBe(true)
  })

  it('does NOT bump identical WP body modulo whitespace', () => {
    const oldPage = page('Slice summary.\n')
    const newPage = page('Slice summary.   \n')
    expect(shouldBump('wp', oldPage, newPage)).toBe(false)
  })
})
