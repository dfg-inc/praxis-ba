// ---- fmt.test.ts: `formatText`/`formatFile` (library) + `praxis-ba fmt` (CLI)
// — the hybrid write-path's canonicalizer (Task 16). `formatText` is
// nothing but `emitPage(type, parsePage(raw,type).frontmatter,
// parsePage(raw,type).body)` (parse.ts's/serialize.ts's own primitives),
// so these tests exercise the WIRING (type inference, opaque-body pass-
// through, --check's write-nothing guarantee, the CLI's exit-code mapping)
// rather than re-proving emitPage's own byte-stable output — that's already
// covered by serialize.test.ts's golden fixtures + fast-check round-trip
// property (Tasks 1-14, 357 green tests).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { formatFile, formatText } from '../src/fmt'
import { runCli } from '../src/cli'
import type { NodeType } from '../src/types'

// ==========================================================================
// fixtures — a hand-authored "messy" FR: reordered frontmatter keys, a
// non-natural-sorted `traces_to` ([CR-002, CR-001] instead of the canonical
// [CR-001, CR-002]), NO trailing newline, and a body containing an in-body
// `---` horizontal rule (the exact body shape parse.test.ts's own "keeps the
// body opaque incl. a --- rule" fixture uses: '\nStory.\n\n---\n\nmore') —
// that rule must survive `formatText` byte-for-byte, never mistaken for a
// second frontmatter fence.
// ==========================================================================

const MESSY_FR = [
  '---',
  'type: fr',
  'traces_to:',
  '  - CR-002',
  '  - CR-001',
  'id: E1-FR1',
  'epic: E1',
  'version: 1',
  'status: draft',
  'enforces: []',
  'references_nfr: []',
  'related: []',
  '---',
  '',
  'Story.',
  '',
  '---',
  '',
  'more',
].join('\n') // deliberately NOT trailing-newline-terminated (ends on "more")

// The canonical form of MESSY_FR: fixed key order (id, type, epic, status,
// version, traces_to, enforces, references_nfr, related — serialize.ts's
// KEY_ORDER.fr), traces_to natural-sorted (CR-001 before CR-002), the same
// body verbatim (incl. its in-body `---` rule) with exactly one trailing LF
// added (there were none).
const CANONICAL_FR = [
  '---',
  'id: E1-FR1',
  'type: fr',
  'epic: E1',
  'status: draft',
  'version: 1',
  'traces_to:',
  '  - CR-001',
  '  - CR-002',
  'enforces: []',
  'references_nfr: []',
  'related: []',
  '---',
  '',
  'Story.',
  '',
  '---',
  '',
  'more',
  '',
].join('\n') // trailing '' element -> join adds exactly one trailing "\n"

describe('formatText — canonicalizes one page string (parsePage -> emitPage)', () => {
  it('reorders frontmatter keys, natural-sorts traces_to, adds a single trailing LF, and preserves an in-body --- rule byte-for-byte', () => {
    const out = formatText(MESSY_FR, 'fr')
    expect(out).toBe(CANONICAL_FR)
    // Explicit, independent checks (not just the whole-string diff above):
    expect(out.indexOf('id: E1-FR1')).toBeLessThan(out.indexOf('type: fr'))
    expect(out.indexOf('type: fr')).toBeLessThan(out.indexOf('epic: E1'))
    expect(out.indexOf('status: draft')).toBeLessThan(out.indexOf('version: 1'))
    expect(out.indexOf('version: 1')).toBeLessThan(out.indexOf('traces_to:'))
    expect(out).toContain('traces_to:\n  - CR-001\n  - CR-002\n') // sorted, not the input's CR-002-first order
    expect(out).toContain('\nStory.\n\n---\n\nmore\n') // the in-body rule, verbatim
    expect(out.endsWith('more\n')).toBe(true) // single trailing LF, not zero, not several
    expect(out.endsWith('more\n\n')).toBe(false)
  })

  it('is idempotent: formatText(formatText(x)) === formatText(x) (fast-check over a few node types)', () => {
    const cases: Array<{ raw: string; type: NodeType }> = [
      { raw: MESSY_FR, type: 'fr' },
      {
        // messy epic: reordered keys, no trailing newline
        raw: ['---', 'status: active', 'type: epic', 'title: Foundation', 'id: E1', '---', '', 'Notes.'].join('\n'),
        type: 'epic',
      },
      {
        // messy br: reordered keys, no trailing newline
        raw: [
          '---',
          'type: br',
          'kind: operative',
          'id: E1-BR1',
          'epic: E1',
          'enforcement: advisory',
          'status: draft',
          'version: 1',
          '---',
          '',
          'A rule.',
        ].join('\n'),
        type: 'br',
      },
      {
        // already-canonical FR (idempotency from a clean starting point too)
        raw: CANONICAL_FR,
        type: 'fr',
      },
    ]

    fc.assert(
      fc.property(fc.constantFrom(...cases), ({ raw, type }) => {
        const once = formatText(raw, type)
        const twice = formatText(once, type)
        expect(twice).toBe(once)
      })
    )
  })

  it('surfaces a parsePage {error} rather than emitting garbage', () => {
    const invalid = '---\nid: E1-FR1\ntype: fr\nepic: E1\nstatus: nope\nversion: 1\n---\n\nStory.'
    expect(() => formatText(invalid, 'fr')).toThrow()
  })
})

// ==========================================================================
// formatFile / CLI — repo fixtures. A tmp dir per test; formatFile/the CLI's
// `fmt` verb don't need `.ba/counters.yaml` (no id minting, no graph load),
// so these fixtures are simpler than cli.test.ts's makeRepo().
// ==========================================================================

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'canon-fmt-'))
  tempDirs.push(dir)
  return dir
}

function seedRaw(repo: string, relPath: string, raw: string): string {
  const path = join(repo, relPath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, raw, 'utf8')
  return path
}

describe('formatFile — read, canonicalize, atomic-write-back only if bytes differ', () => {
  it('rewrites a drifted file and reports changed:true; a second call is a no-op (changed:false)', () => {
    const repo = makeRepo()
    const path = seedRaw(repo, 'epics/E1-x/E1-FR1.md', MESSY_FR)

    const first = formatFile(repo, path)
    expect(first.changed).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(CANONICAL_FR)

    const second = formatFile(repo, path)
    expect(second.changed).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(CANONICAL_FR) // unchanged, still canonical
  })

  it('reports changed:false on an already-canonical file, without rewriting it', () => {
    const repo = makeRepo()
    const path = seedRaw(repo, 'epics/E1-x/E1-FR1.md', CANONICAL_FR)

    const result = formatFile(repo, path)
    expect(result.changed).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(CANONICAL_FR)
  })

  it('infers the node type from frontmatter alone (no external type hint)', () => {
    const repo = makeRepo()
    const messyEpic = ['---', 'status: active', 'type: epic', 'title: Foundation', 'id: E1', '---', '', 'Notes.'].join('\n')
    const path = seedRaw(repo, 'epics/E1-x/index.md', messyEpic)

    const result = formatFile(repo, path)
    expect(result.changed).toBe(true)
    const rewritten = readFileSync(path, 'utf8')
    expect(rewritten.indexOf('id: E1')).toBeLessThan(rewritten.indexOf('type: epic'))
    expect(rewritten.indexOf('type: epic')).toBeLessThan(rewritten.indexOf('title: Foundation'))
  })
})

describe('CLI `praxis-ba fmt`', () => {
  it('--check on a drifted file exits 2 (advisory) and writes NOTHING', async () => {
    const repo = makeRepo()
    const path = seedRaw(repo, 'epics/E1-x/E1-FR1.md', MESSY_FR)

    const result = await runCli(['fmt', path, '--check'], { repo })
    expect(result.code).toBe(2)
    expect(readFileSync(path, 'utf8')).toBe(MESSY_FR) // byte-identical to what was seeded — untouched
  })

  it('--check on a canonical file exits 0 and writes nothing', async () => {
    const repo = makeRepo()
    const path = seedRaw(repo, 'epics/E1-x/E1-FR1.md', CANONICAL_FR)

    const result = await runCli(['fmt', path, '--check'], { repo })
    expect(result.code).toBe(0)
    expect(readFileSync(path, 'utf8')).toBe(CANONICAL_FR)
  })

  it('(no --check) rewrites a drifted file on disk; a second run is a no-op', async () => {
    const repo = makeRepo()
    const path = seedRaw(repo, 'epics/E1-x/E1-FR1.md', MESSY_FR)

    const first = await runCli(['fmt', path], { repo })
    expect(first.code).toBe(0)
    expect(readFileSync(path, 'utf8')).toBe(CANONICAL_FR)

    const second = await runCli(['fmt', path], { repo })
    expect(second.code).toBe(0)
    expect(readFileSync(path, 'utf8')).toBe(CANONICAL_FR)
  })

  it('--repo walk (no path args) formats every canon page under the repo', async () => {
    const repo = makeRepo()
    const drifted = seedRaw(repo, 'epics/E1-x/E1-FR1.md', MESSY_FR)
    const messyEpic = ['---', 'status: active', 'type: epic', 'title: Foundation', 'id: E1', '---', '', 'Notes.'].join('\n')
    const clean = seedRaw(repo, 'epics/E1-x/index.md', messyEpic) // also drifted (reordered keys)

    const checkResult = await runCli(['fmt', '--check'], { repo })
    expect(checkResult.code).toBe(2)
    expect(readFileSync(drifted, 'utf8')).toBe(MESSY_FR) // --check touched nothing
    expect(readFileSync(clean, 'utf8')).toBe(messyEpic)

    const fixResult = await runCli(['fmt'], { repo })
    expect(fixResult.code).toBe(0)
    expect(readFileSync(drifted, 'utf8')).toBe(CANONICAL_FR)

    const recheck = await runCli(['fmt', '--check'], { repo })
    expect(recheck.code).toBe(0) // everything canonical now
  })
})
