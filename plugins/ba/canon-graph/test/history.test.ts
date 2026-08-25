import { describe, it, expect } from 'vitest'
import { formatHistoryHeading, parseHistoryHeadings, historyCrRefs, demoteHeadings, archiveIntoHistory, SENTINEL } from '../src/history'

describe('history.ts', () => {
  it('formats a CR-cited heading', () => {
    expect(formatHistoryHeading(2, '20260718', 'CR-017')).toBe('### v2 — 20260718 — CR-017')
  })

  it('parses both CR and legacy BL heading refs, in document order', () => {
    const body = 'Statement\n\n## History\n\n### v3 — 20260718 — CR-017\n\nold3\n\n### v2 — 20260715 — BL-20260715\n\nold2\n'
    expect(parseHistoryHeadings(body)).toEqual([
      { version: 3, date: '20260718', ref: 'CR-017' },
      { version: 2, date: '20260715', ref: 'BL-20260715' },
    ])
    expect(historyCrRefs(body)).toEqual(['CR-017'])
  })

  it('ignores vN-style headings OUTSIDE the History section', () => {
    expect(parseHistoryHeadings('### v9 — 20260101 — CR-001\n\nno History heading here')).toEqual([])
  })

  it('demotes ## and ### exactly two levels', () => {
    expect(demoteHeadings('## Acceptance Criteria\n\n### sub\n\ntext')).toBe('#### Acceptance Criteria\n\n##### sub\n\ntext')
  })

  it('archives with demoted prior-body headings, newest first', () => {
    const out = archiveIntoHistory('new body\n', '### v1 — 20260717 — CR-016', '## Acceptance Criteria\n\n- AC-1: x\n')
    expect(out).toContain('## History\n\n### v1 — 20260717 — CR-016\n\n#### Acceptance Criteria')
    const second = archiveIntoHistory(out, '### v2 — 20260718 — CR-017', 'prior2\n')
    expect(second.indexOf('v2 — 20260718')).toBeLessThan(second.indexOf('v1 — 20260717'))
  })

  // ------------------------------------------------------------------------
  // finding #2: the machine-managed section is located by a SENTINEL, never
  // by bare '## History' text alone — a coincidental prose heading of that
  // exact text (this product literally ships a feature called "History")
  // must never be mistaken for the archive anchor.
  // ------------------------------------------------------------------------

  it('a fresh archive emits the sentinel immediately above ## History', () => {
    const out = archiveIntoHistory('new body\n', '### v1 — 20260717 — CR-016', 'prior\n')
    expect(out).toContain(`${SENTINEL}\n## History\n\n### v1 — 20260717 — CR-016`)
  })

  it('does NOT splice into a coincidental prose "## History" section — creates a fresh sentineled section at the end instead, leaving the prose intact', () => {
    const newBody = [
      'Users can edit or delete any past transaction via long-press.',
      '',
      '## History',
      '',
      'Users can edit or delete any past transaction via long-press.',
      '',
      '## Acceptance criteria',
      '',
      '- Edits recompute balances.',
      '',
    ].join('\n')
    const out = archiveIntoHistory(newBody, '### v1 — 20260101 — CR-020', 'Old FR content before this edit.')

    // The prose section survives verbatim, in its original position.
    expect(out).toContain(
      '## History\n\nUsers can edit or delete any past transaction via long-press.\n\n## Acceptance criteria'
    )
    // A NEW, sentineled machine section is appended at the END, not spliced
    // into the prose section — so it comes after '## Acceptance criteria'.
    expect(out).toContain(`${SENTINEL}\n## History\n\n### v1 — 20260101 — CR-020\n\nOld FR content before this edit.`)
    expect(out.indexOf(SENTINEL)).toBeGreaterThan(out.indexOf('## Acceptance criteria'))
    expect(historyCrRefs(out)).toEqual(['CR-020'])
  })

  it('finds a legacy (un-sentineled) machine section — bare heading + ### vN entry — and upgrades it with the sentinel on next touch', () => {
    const legacyBody = 'Statement.\n\n## History\n\n### v1 — 20260101 — CR-001\n\nold body\n'
    const out = archiveIntoHistory(legacyBody, '### v2 — 20260102 — CR-002', 'v1 replacement body\n')
    expect(out).toContain(`${SENTINEL}\n## History`)
    expect(out.indexOf(SENTINEL)).toBeLessThan(out.indexOf('### v2 — 20260102 — CR-002'))
    // The pre-existing entry survives untouched underneath the new one.
    expect(out).toContain('### v1 — 20260101 — CR-001')
    expect(out).toContain('old body')
  })

  it('finds an already-sentineled section (idempotent — never creates a second ## History)', () => {
    const once = archiveIntoHistory('body\n', '### v1 — 20260101 — CR-001', 'prior\n')
    const twice = archiveIntoHistory(once, '### v2 — 20260102 — CR-002', 'prior2\n')
    expect(twice.split('## History').length - 1).toBe(1)
    expect(twice.split(SENTINEL).length - 1).toBe(1)
  })

  // ------------------------------------------------------------------------
  // finding #3/#6: a citation, once written, is a historical fact — a LATER,
  // unrelated bump must never bury an earlier bump's CR citation just
  // because demoteHeadings pushed its heading down a level or two.
  // ------------------------------------------------------------------------

  it("historyCrRefs sees a citation at ANY demoted depth — a second bump does not bury the first's citation", () => {
    const v1 = archiveIntoHistory('v2 body\n', '### v1 — 20260101 — CR-001', 'v1 body\n')
    expect(historyCrRefs(v1)).toEqual(['CR-001'])

    // Second bump: priorBody is the FULL current body (mirrors writer.ts's
    // real usage — editRequirement passes `parsed.body`, the whole on-disk
    // body, as `priorBody`) — so v1's own '## History'/'### v1' heading gets
    // demoted two levels when re-embedded under the new entry.
    const v2 = archiveIntoHistory('v3 body\n', '### v2 — 20260102 — CR-002', v1)
    expect(v2).toMatch(/^##### v1 — 20260101 — CR-001$/m)
    expect(historyCrRefs(v2)).toEqual(['CR-002', 'CR-001'])
  })
})
