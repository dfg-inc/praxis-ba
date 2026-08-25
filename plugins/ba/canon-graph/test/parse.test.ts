import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { parsePage, parseFile } from '../src/parse'

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

describe('parsePage — read path (gray-matter + eemeli, opaque body)', () => {
  it('keeps the body opaque incl. a --- rule', () => {
    // NOTE: the brief's illustrative fixture omits `traces_to`/`enforces`/
    // `references_nfr`/`related` — required (non-optional) on frSchema per
    // the already-committed src/schema.ts (Task 2). Added as empty arrays so
    // the fixture validates; the body/assertion under test is unchanged.
    const raw =
      '---\nid: E1-FR1\ntype: fr\nepic: E1\nstatus: draft\nversion: 1\ntraces_to: []\nenforces: []\nreferences_nfr: []\nrelated: []\n---\n\nStory.\n\n---\n\nmore'
    const r = parsePage(raw, 'fr')
    expect('error' in r).toBe(false)
    if (!('error' in r)) expect(r.body).toBe('\nStory.\n\n---\n\nmore')
  })

  it('rejects an unknown status via zod and returns {error}', () => {
    const raw = '---\nid: E1-FR1\ntype: fr\nepic: E1\nstatus: nope\nversion: 1\n---\n\nStory.'
    const r = parsePage(raw, 'fr')
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error.length).toBeGreaterThan(0)
  })

  it('extracts AC entries from the body for type fr', () => {
    const raw =
      '---\nid: E1-FR1\ntype: fr\nepic: E1\nstatus: draft\nversion: 1\ntraces_to: []\nenforces: []\nreferences_nfr: []\nrelated: []\n---\n\nStory.\n\n## Acceptance Criteria\n- AC-1: a\n- AC-2: b'
    const r = parsePage(raw, 'fr')
    expect('error' in r).toBe(false)
    if (!('error' in r))
      expect(r.acs).toEqual([
        { acId: 1, text: 'a' },
        { acId: 2, text: 'b' },
      ])
  })

  it('does not extract acs for a non-fr type, even with an AC-shaped body', () => {
    const raw =
      '---\nid: E1\ntype: epic\ntitle: Entry\nstatus: active\n---\n\n## Acceptance Criteria\n- AC-1: should not be extracted'
    const r = parsePage(raw, 'epic')
    expect('error' in r).toBe(false)
    if (!('error' in r)) expect(r.acs).toEqual([])
  })

  it('returns the validated frontmatter data on success', () => {
    const raw = '---\nid: CR-001\ntype: cr\nstatus: captured\n---\n\nbody'
    const r = parsePage(raw, 'cr')
    expect('error' in r).toBe(false)
    if (!('error' in r)) expect(r.frontmatter).toEqual({ id: 'CR-001', type: 'cr', status: 'captured' })
  })
})

describe('parseFile — file read path', () => {
  it('reads and parses a real fixture with a --- rule and an AC section', () => {
    const r = parseFile(fixture('fr-with-rule.md'), 'fr')
    expect('error' in r).toBe(false)
    if (!('error' in r)) {
      expect(r.body).toBe('\nStory.\n\n---\n\nmore\n\n## Acceptance Criteria\n- AC-1: given a, when b, then c\n')
      expect(r.acs).toEqual([{ acId: 1, text: 'given a, when b, then c' }])
    }
  })

  it('returns {error} when the file does not exist', () => {
    const r = parseFile(fixture('does-not-exist.md'), 'fr')
    expect('error' in r).toBe(true)
  })
})
