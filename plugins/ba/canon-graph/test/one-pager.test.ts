import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { stringify as yamlStringify } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'
import type { Counters } from '../src/ids'
import { writeOnePager } from '../src/one-pager'

const tempDirs: string[] = []

function baseCounters(): Counters {
  return { product: { epic: 0, cr: 0, wp: 0, bug: 0, baselineSeq: {} }, epics: {}, retired: [] }
}

function makeRepo(counters: Counters = baseCounters()): string {
  const dir = mkdtempSync(join(tmpdir(), 'canon-one-pager-'))
  mkdirSync(join(dir, '.ba'), { recursive: true })
  writeFileSync(join(dir, '.ba', 'counters.yaml'), yamlStringify(counters), 'utf8')
  tempDirs.push(dir)
  return dir
}

function seedRaw(repo: string, relPath: string, raw: string): string {
  const path = join(repo, relPath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, raw, 'utf8')
  return path
}

function seedFr(repo: string, id: string, epic: string, body: string, extraFm: string[] = []): string {
  return seedRaw(
    repo,
    join('epics', `${epic}-x`, `${id}.md`),
    [
      '---',
      `id: ${id}`,
      'type: fr',
      `epic: ${epic}`,
      'status: active',
      'version: 1',
      'traces_to: []',
      'enforces: []',
      'references_nfr: []',
      'related: []',
      ...extraFm,
      '---',
      '',
      body,
      '',
    ].join('\n'),
  )
}

function validBody(purpose = 'Live purpose text.', ac = '- AC-1: given a start, when the user acts, then an outcome.'): string {
  return [
    'Story body.',
    '',
    '## Назначение',
    '',
    purpose,
    '',
    '## Acceptance Criteria',
    ac,
  ].join('\n')
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('writeOnePager (WBS 1.14)', () => {
  it('creates a one-pager from a valid live FR', () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', validBody())
    const out = join(repo, 'one-pagers', 'E1-FR1.md')
    const result = writeOnePager(repo, 'E1-FR1')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(existsSync(out)).toBe(true)
    const doc = readFileSync(out, 'utf8')
    expect(doc).toContain('## Назначение')
    expect(doc).toContain('Live purpose text.')
    expect(doc).toContain('## Что сможет пользователь')
    expect(doc).toContain('_не заполнено в источнике_')
    expect(doc).toContain('## Условия готовности')
    expect(doc).toContain('AC-1: given a start, when the user acts, then an outcome.')
    expect(doc).toContain('Source: epics/E1-x/E1-FR1.md')
  })

  it('fails with no output when purpose is missing', () => {
    const repo = makeRepo()
    seedFr(
      repo,
      'E1-FR1',
      'E1',
      'Story only.\n\n## Acceptance Criteria\n- AC-1: given a, when b, then c\n',
    )
    const result = writeOnePager(repo, 'E1-FR1')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/назначение\/purpose/)
    expect(existsSync(join(repo, 'one-pagers', 'E1-FR1.md'))).toBe(false)
  })

  it('fails with no output when Acceptance Criteria is missing', () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', '## Назначение\n\nHas purpose.\n')
    const result = writeOnePager(repo, 'E1-FR1')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/Acceptance Criteria/)
    expect(existsSync(join(repo, 'one-pagers', 'E1-FR1.md'))).toBe(false)
  })

  it('fails on an unknown id', () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', validBody())
    const result = writeOnePager(repo, 'E1-FR9')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/not found/)
    expect(existsSync(join(repo, 'one-pagers', 'E1-FR9.md'))).toBe(false)
  })

  it('fails on a non-FR id', () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', validBody())
    seedRaw(
      repo,
      'goals/G1.md',
      '---\nid: G1\ntype: goal\ntitle: Outcome\nstatus: active\n---\n\nGoal body.\n',
    )
    const result = writeOnePager(repo, 'G1')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/not an FR/)
    expect(existsSync(join(repo, 'one-pagers', 'G1.md'))).toBe(false)
  })

  it('uses the live FR when a frozen copy with the same id exists under baselines/', () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', validBody('LIVE PURPOSE UNIQUE.', '- AC-1: given live, when acting, then live outcome.'))
    seedRaw(
      repo,
      'baselines/BL-20200101/E1-FR1.md',
      [
        '---',
        'id: E1-FR1',
        'type: fr',
        'epic: E1',
        'status: baselined',
        'version: 1',
        'traces_to: []',
        'enforces: []',
        'references_nfr: []',
        'related: []',
        '---',
        '',
        '## Назначение',
        '',
        'FROZEN PURPOSE MUST NOT APPEAR.',
        '',
        '## Acceptance Criteria',
        '- AC-1: given frozen, when frozen, then frozen.',
        '',
      ].join('\n'),
    )
    const result = writeOnePager(repo, 'E1-FR1')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const doc = readFileSync(result.outPath, 'utf8')
    expect(doc).toContain('LIVE PURPOSE UNIQUE.')
    expect(doc).not.toContain('FROZEN PURPOSE MUST NOT APPEAR')
    expect(doc).toContain('given live, when acting, then live outcome.')
    expect(doc).not.toContain('given frozen')
  })

  it('leaves the source FR byte-identical after generation', () => {
    const repo = makeRepo()
    const src = seedFr(repo, 'E1-FR1', 'E1', validBody())
    const before = readFileSync(src)
    const result = writeOnePager(repo, 'E1-FR1')
    expect(result.ok).toBe(true)
    expect(Buffer.compare(before, readFileSync(src))).toBe(0)
  })
})
