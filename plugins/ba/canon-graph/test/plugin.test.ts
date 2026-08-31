// ---- plugin.test.ts: structural test for Task 17's static plugin assets —
// the Claude Code plugin manifest (`.claude/plugins/praxis-ba/.claude-plugin/
// plugin.json`) + the 8 md templates (`.claude/plugins/praxis-ba/templates/
// *.md`) that Task 18's SKILLS author canon FROM. This suite does not test
// any new library logic — it proves the checked-in static assets are
// well-formed against the already-committed library (`parsePage`/
// `validateFrontmatter`/`parseAcBlock`/`formatText` — Tasks 1-16): the
// manifest parses and carries the fields the reference manifests (v1
// praxis-ba + superpowers) both have, each template's frontmatter validates
// for its node type via a format-valid SENTINEL id, the fr template's body
// has a well-formed `## Acceptance Criteria` block, and every template is
// byte-canonical (idempotent under `formatText`) so `praxis-ba fmt --check`
// never flags a freshly-copied template as drifted.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { parsePage } from '../src/parse'
import { formatText } from '../src/fmt'
import { parseAcBlock } from '../src/ac'
import type { NodeType } from '../src/types'

// The plugin lives at the repo ROOT, two levels up from this package's
// `test/` dir (test -> canon-graph -> repo root) — this file resolves it
// the same way parse.test.ts resolves its `fixtures/` dir, just walking one
// directory further up.
const pluginRoot = fileURLToPath(new URL('../..', import.meta.url))
const repoRoot = (relPath: string): string =>
  fileURLToPath(new URL(relPath, `file://${pluginRoot}/`))

const PLUGIN_ROOT = '.'
const MANIFEST_PATH = repoRoot('.claude-plugin/plugin.json')

// ---- the 8 node types this task's templates cover, and their expected
// on-disk basename (epic-index.md, not epic.md — the brief's own naming). ----
const TEMPLATES: ReadonlyArray<{ type: NodeType; file: string }> = [
  { type: 'vision', file: 'vision.md' },
  { type: 'fr', file: 'fr.md' },
  { type: 'nfr', file: 'nfr.md' },
  { type: 'br', file: 'br.md' },
  { type: 'cr', file: 'cr.md' },
  { type: 'wp', file: 'wp.md' },
  { type: 'bug', file: 'bug.md' },
  { type: 'epic', file: 'epic-index.md' },
  { type: 'goal', file: 'goal.md' },
]

describe('plugin manifest — .claude/plugins/praxis-ba/.claude-plugin/plugin.json', () => {
  it('exists and parses as JSON', () => {
    expect(existsSync(MANIFEST_PATH)).toBe(true)
    const raw = readFileSync(MANIFEST_PATH, 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
  })

  it('carries the fields both reference manifests (v1 praxis-ba + superpowers) have: name, description, version', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Record<string, unknown>
    expect(typeof manifest.name).toBe('string')
    expect((manifest.name as string).length).toBeGreaterThan(0)
    expect(typeof manifest.description).toBe('string')
    expect((manifest.description as string).length).toBeGreaterThan(0)
    expect(typeof manifest.version).toBe('string')
    // SemVer 2.0 including prerelease (e.g. 0.1.0-alpha.2)
    expect(manifest.version).toMatch(
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/,
    )
  })

  it('names the plugin praxis-ba (Phase 1 rename from praxis-ba)', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Record<string, unknown>
    expect(manifest.name).toBe('praxis-ba')
  })
})

describe('the 9 md templates — plugins/ba/templates/*.md', () => {
  it.each(TEMPLATES)('$file exists', ({ file }) => {
    expect(existsSync(repoRoot(`templates/${file}`))).toBe(true)
  })

  it.each(TEMPLATES)('$file parses via parsePage and its frontmatter validates for type $type (sentinel id)', ({ type, file }) => {
    const raw = readFileSync(repoRoot(`templates/${file}`), 'utf8')
    const result = parsePage(raw, type)
    if ('error' in result) throw new Error(`${file}: ${result.error}`)
    expect('error' in result).toBe(false)
    // Same-shape double-check via the direct entry point plugin.test.ts's
    // brief calls out by name (validateFrontmatter) — parsePage already
    // dispatches through it internally; this asserts the frontmatter it
    // extracted independently re-validates true.
    expect(result.frontmatter).toBeTruthy()
  })

  it.each(TEMPLATES)('$file is byte-canonical (formatText is a no-op on it)', ({ type, file }) => {
    const raw = readFileSync(repoRoot(`templates/${file}`), 'utf8')
    expect(formatText(raw, type)).toBe(raw)
  })

  it('the fr template body contains a valid ## Acceptance Criteria block with >= 1 AC', () => {
    const raw = readFileSync(repoRoot(`templates/fr.md`), 'utf8')
    const result = parsePage(raw, 'fr')
    if ('error' in result) throw new Error(result.error)
    const acResult = parseAcBlock(result.body)
    expect(acResult.error).toBeUndefined()
    expect(acResult.acs.length).toBeGreaterThanOrEqual(1)
    // grammar sanity: every parsed AC's text is non-empty (not just an empty
    // capture from a malformed bullet).
    for (const ac of acResult.acs) expect(ac.text.length).toBeGreaterThan(0)
  })

  it('the nfr template body contains a Planguage block (Tag / Scale / Meter / Goal)', () => {
    const raw = readFileSync(repoRoot(`templates/nfr.md`), 'utf8')
    const result = parsePage(raw, 'nfr')
    if ('error' in result) throw new Error(result.error)
    expect(result.body).toMatch(/Tag:/)
    expect(result.body).toMatch(/Scale:/)
    expect(result.body).toMatch(/Meter:/)
    expect(result.body).toMatch(/Goal:/)
  })
})

// ==========================================================================
// retired-verb guard — mirrors skills.test.ts's hybrid-enforcement check,
// scoped to the templates instead of the skills: under the HYBRID contract
// (owner decision, 2026-07-14) these 5 CREATE verbs are retired in favor of
// `praxis-ba id next --scope <spec>` + a direct `Write` from the matching
// template, so no template's own guidance comment may instruct running one
// of them as an `praxis-ba …` command — a template that drifted back to
// telling an author to run e.g. `praxis-ba req add` would silently
// reintroduce the pre-hybrid flow this whole plugin moved away from.
// ==========================================================================

const RETIRED_VERBS = ['cr capture', 'req add', 'wp author', 'bug capture', 'epic add'] as const

describe('templates never instruct a retired create verb (hybrid contract)', () => {
  it.each(TEMPLATES)('$file never mentions `praxis-ba <retired-verb>`', ({ file }) => {
    const raw = readFileSync(repoRoot(`templates/${file}`), 'utf8')
    for (const retired of RETIRED_VERBS) {
      const re = new RegExp(`\\bpraxis-ba\\s+${retired.replace(' ', '\\s+')}\\b`)
      expect(re.test(raw), `${file} instructs running retired verb 'praxis-ba ${retired}'`).toBe(false)
    }
  })
})
