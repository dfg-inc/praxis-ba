// ---- config-scoping.test.ts: `.ba/config.yaml` canon-path scoping (Plan-2
// Task 0, "canon-path scoping — a library prerequisite") ----
//
// Real `product/` mixes VitePress **prose** (`process/`, `architecture/`,
// `overview/`, …) with the md canon. Before this task, `fs.ts`'s shared
// walker (formerly duplicated as a private `walkMdFiles` in cli.ts/
// writer.ts) scanned EVERY `.md` under the repo except `.ba/`+`baselines/` —
// so `validate --repo product/` would ingest prose as canon and hard-fail
// `schema-valid`, and `loadGraph` would build a graph containing bogus
// nodes. This file proves:
//   1. With `.ba/config.yaml` (`canon_roots`), the walker/validate/loadGraph
//      scan ONLY the configured roots — a prose `.md` outside them is
//      invisible to all three.
//   2. With NO config (every pre-Task-0 fixture/repo), the ORIGINAL
//      walk-everything default is unchanged — full backward compatibility.
//   3. `validate` and `loadGraph` are driven by the exact same underlying
//      file set (the "single source" the consolidation is for).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { stringify as yamlStringify } from 'yaml'
import { describe, it, expect, afterEach } from 'vitest'
import { runCli } from '../src/cli'
import { loadGraph } from '../src/writer'
import { walkCanonFiles, readCanonConfig } from '../src/fs'
import type { Counters } from '../src/ids'

// ---- fixture helpers — a temp dir per test, mirroring cli.test.ts's own
// makeRepo/seedRaw conventions (reproduced locally rather than imported —
// this is test scaffolding, not library logic). ----

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function baseCounters(): Counters {
  return { product: { epic: 0, cr: 0, wp: 0, bug: 0, baselineSeq: {} }, epics: {}, retired: [] }
}

function makeRepo(counters: Counters = baseCounters()): string {
  const dir = mkdtempSync(join(tmpdir(), 'canon-config-scoping-'))
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

function writeConfig(repo: string, canonRoots: string[]): string {
  return seedRaw(repo, join('.ba', 'config.yaml'), yamlStringify({ canon_roots: canonRoots }))
}

/** A schema-valid FR, `provenance: migrated` + empty `traces_to` so it's
 * only an ADVISORY orphan (never a hard `no-orphans` failure) — keeps every
 * assertion below focused on canon-path scoping, not an unrelated gate. */
function seedFr(repo: string, id: string, epic: string): string {
  const raw = [
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
    'provenance: migrated',
    '---',
    '',
    'Story body.',
    '',
    '## Acceptance Criteria',
    '- AC-1: Something observable happens.',
    '',
  ].join('\n')
  return seedRaw(repo, join('epics', `${epic}-x`, `${id}.md`), raw)
}

function seedCr(repo: string, id: string): string {
  return seedRaw(repo, join('cr', `${id}.md`), `---\nid: ${id}\ntype: cr\nstatus: confirmed\n---\n\nCaptured idea.\n`)
}

/** A realistic VitePress PROSE doc — frontmatter with no `type` field at
 * all, exactly what a real `product/process/adlc.md` looks like. This is
 * the actual failure mode the task fixes: the old walk-everything default
 * would report this as `{error: "unrecognized or missing 'type' field"}`,
 * hard-failing `validate`'s `schema-valid` check. */
function seedProse(repo: string, relPath: string): string {
  return seedRaw(repo, relPath, '---\ntitle: ADLC Process\n---\n\nThis page describes the dev-loop process.\n')
}

// ==========================================================================
// 1. With config: scans ONLY the configured roots
// ==========================================================================

describe('canon-path scoping — `.ba/config.yaml` present', () => {
  it('walkCanonFiles returns the canon file and NOT a prose .md outside canon_roots', () => {
    const repo = makeRepo({
      product: { epic: 1, cr: 0, wp: 0, bug: 0, baselineSeq: {} },
      epics: { E1: { fr: 1, nfr: 0, br: 0 } },
      retired: [],
    })
    writeConfig(repo, ['epics/', 'br/'])
    const frPath = seedFr(repo, 'E1-FR1', 'E1')
    const prosePath = seedProse(repo, join('process', 'adlc.md'))

    const files = walkCanonFiles(repo)

    expect(files).toContain(frPath)
    expect(files).not.toContain(prosePath)
  })

  it('validate does NOT fail on the prose page (schema-valid stays green)', async () => {
    const repo = makeRepo({
      product: { epic: 1, cr: 0, wp: 0, bug: 0, baselineSeq: {} },
      epics: { E1: { fr: 1, nfr: 0, br: 0 } },
      retired: [],
    })
    writeConfig(repo, ['epics/', 'br/'])
    seedFr(repo, 'E1-FR1', 'E1')
    seedProse(repo, join('process', 'adlc.md'))
    seedProse(repo, join('architecture', 'stack.md'))

    const result = await runCli(['validate'], { repo })

    expect(result.json.verdict).toBe('VERIFY-OK') // the prose never hard-fails validate
    const schemaCheck = result.json.checks.find((c) => c.name === 'schema-valid')
    expect(schemaCheck?.ok).toBe(true)
    expect(schemaCheck?.reason).not.toContain('process')
    expect(schemaCheck?.reason).not.toContain('architecture')
  })

  it('loadGraph builds a graph containing the canon FR and NOT a fully-valid page sitting outside canon_roots', () => {
    const repo = makeRepo({
      product: { epic: 1, cr: 0, wp: 0, bug: 0, baselineSeq: {} },
      epics: { E1: { fr: 1, nfr: 0, br: 0 } },
      retired: [],
    })
    writeConfig(repo, ['epics/'])
    seedFr(repo, 'E1-FR1', 'E1')
    // A fully SCHEMA-VALID FR page, sitting outside every configured root
    // (`cr/` is not in canon_roots here) — proves the exclusion isn't a
    // no-op that only happens to work because prose fails schema anyway.
    seedRaw(
      repo,
      join('cr', 'not-canon', 'E9-FR1.md'),
      '---\nid: E9-FR1\ntype: fr\nepic: E9\nstatus: active\nversion: 1\ntraces_to: []\nenforces: []\nreferences_nfr: []\nrelated: []\nprovenance: migrated\n---\n\nShould never be graphed.\n'
    )

    const graph = loadGraph(repo)

    expect(graph.frs.map((n) => n.frontmatter.id)).toEqual(['E1-FR1'])
  })

  it('readCanonConfig round-trips the seeded canon_roots', () => {
    const repo = makeRepo()
    writeConfig(repo, ['epics/', 'br/', 'cr/'])

    const config = readCanonConfig(repo)

    expect(config?.canon_roots).toEqual(['epics/', 'br/', 'cr/'])
  })

  it('readCanonConfig throws (never silently coerces) on a malformed config.yaml', () => {
    const repo = makeRepo()
    seedRaw(repo, join('.ba', 'config.yaml'), 'canon_roots: not-an-array\n')

    expect(() => readCanonConfig(repo)).toThrow(/config\.yaml failed schema validation/)
  })
})

// ==========================================================================
// 1b. WP-folder attachments (`plan.md`) are canon-ATTACHED, not canon pages —
// excluded from discovery regardless of config (real-canon defect: the
// migrated `wp/WP-*/plan.md` files sit INSIDE the `wp/` canon root and used
// to get swept up as candidate canon pages, hard-failing `validate` with
// "unrecognized or missing 'type' field" ×4 on the real corpus).
// ==========================================================================

describe('canon-path scoping — wp plan.md attachments excluded from canon discovery', () => {
  function seedWpFolder(repo: string): { indexPath: string; planPath: string } {
    const indexPath = seedRaw(
      repo,
      join('wp', 'WP-20260701-001', 'index.md'),
      '---\nid: WP-20260701-001\ntype: wp\nrole: developer\nstatus: draft\n---\n\nGoal sentence.\n'
    )
    const planPath = seedRaw(repo, join('wp', 'WP-20260701-001', 'plan.md'), '# Plan\n\nNot a canon page.\n')
    return { indexPath, planPath }
  }

  it('walkCanonFiles returns index.md but NOT plan.md — no config (whole-repo walk)', () => {
    const repo = makeRepo()
    const { indexPath, planPath } = seedWpFolder(repo)

    const files = walkCanonFiles(repo)

    expect(files).toContain(indexPath)
    expect(files).not.toContain(planPath)
  })

  it('walkCanonFiles returns index.md but NOT plan.md — with a canon_roots config scoping to wp/', () => {
    const repo = makeRepo()
    writeConfig(repo, ['wp/'])
    const { indexPath, planPath } = seedWpFolder(repo)

    const files = walkCanonFiles(repo)

    expect(files).toContain(indexPath)
    expect(files).not.toContain(planPath)
  })
})

// ==========================================================================
// 2. No config: DEFAULT_CANON_ROOTS project surface (not a whole-tree walk)
// ==========================================================================

describe('canon-path scoping — no `.ba/config.yaml` (default project surface)', () => {
  it('readCanonConfig returns undefined', () => {
    const repo = makeRepo()
    expect(readCanonConfig(repo)).toBeUndefined()
  })

  it('walkCanonFiles scans DEFAULT_CANON_ROOTS (existing-style fixture, no config)', () => {
    const repo = makeRepo({
      product: { epic: 1, cr: 0, wp: 0, bug: 0, baselineSeq: {} },
      epics: { E1: { fr: 1, nfr: 0, br: 0 } },
      retired: [],
    })
    const frPath = seedFr(repo, 'E1-FR1', 'E1')

    const files = walkCanonFiles(repo)

    expect(files).toContain(frPath)
  })

  it('does not ingest prose outside the default surface', () => {
    const repo = makeRepo({
      product: { epic: 1, cr: 0, wp: 0, bug: 0, baselineSeq: {} },
      epics: { E1: { fr: 1, nfr: 0, br: 0 } },
      retired: [],
    })
    const frPath = seedFr(repo, 'E1-FR1', 'E1')
    const prosePath = seedProse(repo, join('process', 'adlc.md'))

    const files = walkCanonFiles(repo)

    expect(files).toContain(frPath)
    expect(files).not.toContain(prosePath)
  })

  it('never walks node_modules even when it contains malformed Markdown/YAML', async () => {
    const repo = makeRepo({
      product: { epic: 1, cr: 0, wp: 0, bug: 0, baselineSeq: {} },
      epics: { E1: { fr: 1, nfr: 0, br: 0 } },
      retired: [],
    })
    seedFr(repo, 'E1-FR1', 'E1')
    // Deliberately malformed frontmatter — the exact class of defect that
    // external alpha acceptance hit under node_modules/@praxis/architect.
    seedRaw(
      repo,
      join('node_modules', '@praxis', 'architect', 'skills', 'nfr-budget', 'SKILL.md'),
      '---\nname: nfr-budget\ndescription: Define an NFR budget: metric, limit, how and when it is verified (WBS 4.10).\n---\n\n# Broken\n',
    )
    seedRaw(repo, join('dist', 'notes.md'), '---\ntitle: not canon\n---\n\nGenerated.\n')

    const files = walkCanonFiles(repo)
    expect(files.every((f) => !f.includes(`${sep}node_modules${sep}`))).toBe(true)
    expect(files.every((f) => !f.includes(`${sep}dist${sep}`))).toBe(true)

    const result = await runCli(['validate'], { repo })
    expect(result.json.verdict).toBe('VERIFY-OK')
    const schemaCheck = result.json.checks.find((c) => c.name === 'schema-valid')
    expect(schemaCheck?.ok).toBe(true)
    expect(schemaCheck?.reason).not.toMatch(/node_modules|nfr-budget/)
  })

  it('validate still resolves an existing-style (no-config) fixture exactly as before', async () => {
    const repo = makeRepo()

    const result = await runCli(['status'], { repo })

    expect(result.code).toBe(0)
    expect(result.json.checks.find((c) => c.name === 'epics')?.reason).toBe('0 epic(s)')
  })
})

// ==========================================================================
// 3. The consolidated walker: validate + loadGraph agree on one file set
// ==========================================================================

describe('canon-path scoping — the consolidated walker is a single source', () => {
  it('validate and loadGraph resolve identically over the same scoped fixture', async () => {
    const repo = makeRepo({
      product: { epic: 1, cr: 0, wp: 0, bug: 0, baselineSeq: {} },
      epics: { E1: { fr: 1, nfr: 0, br: 0 } },
      retired: [],
    })
    writeConfig(repo, ['epics/', 'cr/'])
    seedFr(repo, 'E1-FR1', 'E1')
    seedCr(repo, 'CR-001')
    seedProse(repo, join('overview', 'naming.md'))

    const files = walkCanonFiles(repo)
    expect(files.length).toBe(2) // exactly the FR + the CR — never the prose

    const graph = loadGraph(repo)
    expect(graph.frs.map((n) => n.frontmatter.id)).toEqual(['E1-FR1'])
    expect(graph.crs.map((n) => n.frontmatter.id)).toEqual(['CR-001'])

    const result = await runCli(['validate'], { repo })
    expect(result.json.checks.find((c) => c.name === 'schema-valid')?.ok).toBe(true)
  })
})
