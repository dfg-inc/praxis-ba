import { describe, expect, it } from 'vitest'
import {
  bodyHasLeadingFrontmatterFence,
  extractNfrMentions,
  mergeReferencesNfr,
  stripAllLeadingFrontmatter,
  stripLeadingFrontmatter,
} from '../src/body-refs.js'
import { expectedScopeHref } from '../src/gates.js'

describe('stripLeadingFrontmatter', () => {
  it('removes a leading YAML fence pair', () => {
    const raw = `---\nid: E1-FR1\nstatus: draft\n---\n\n## Rationale\nhello\n`
    expect(stripLeadingFrontmatter(raw)).toBe('\n## Rationale\nhello\n')
  })

  it('strips leading whitespace before a pasted full-page fence', () => {
    const raw = '\n---\nid: E1-FR1\ntype: fr\n---\n\n## Rationale\nhello\n'
    expect(stripLeadingFrontmatter(raw)).toBe('\n## Rationale\nhello\n')
  })

  it('stripAllLeadingFrontmatter removes stacked duplicate fences', () => {
    const raw = [
      '---',
      'id: E1-FR1',
      '---',
      '',
      '---',
      'id: E1-FR1',
      '---',
      '',
      'Body.',
      '',
    ].join('\n')
    expect(stripAllLeadingFrontmatter(raw).trim()).toBe('Body.')
  })
})

describe('bodyHasLeadingFrontmatterFence', () => {
  it('detects a second frontmatter smell', () => {
    expect(bodyHasLeadingFrontmatterFence('---\nstatus: draft\n---\n')).toBe(true)
    expect(bodyHasLeadingFrontmatterFence('## Rationale\n')).toBe(false)
  })
})

describe('NFR mention extraction', () => {
  it('finds catalogue and canon ids in rationale', () => {
    const text = 'Depends on PXT-NFR-001 and E1-NFR2 for latency.'
    expect(extractNfrMentions(text)).toEqual({
      canon: ['E1-NFR2'],
      catalog: ['PXT-NFR-001'],
    })
  })

  it('merges mentions into references_nfr', () => {
    expect(mergeReferencesNfr([], 'See PXT-NFR-002 and E2-NFR1')).toEqual([
      'E2-NFR1',
      'PXT-NFR-002',
    ])
  })
})

describe('expectedScopeHref', () => {
  it('is relative from wp/<id>/index.md without duplicating canon/', () => {
    expect(expectedScopeHref('wp/WP-20260831-001/index.md', 'epics/E1-x/E1-FR1.md')).toBe(
      '../../epics/E1-x/E1-FR1.md',
    )
    expect(expectedScopeHref('wp/WP-20260831-001/index.md', 'cr/CR-001.md')).toBe('../../cr/CR-001.md')
  })
})
