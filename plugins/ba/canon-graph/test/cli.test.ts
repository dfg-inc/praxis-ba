import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { stringify as yamlStringify } from 'yaml'
import { describe, it, expect, afterEach } from 'vitest'
import { runCli } from '../src/cli'
import { parseFile } from '../src/parse'
import type { Counters } from '../src/ids'

// ---- fixture repo helpers — a temp dir per test, never the real `product/`.
// Mirrors writer.test.ts/accept.test.ts's makeRepo/seed* conventions. Body
// content for `--body-file`/`--words`/`--evidence`/`--plan` flags lives in a
// SEPARATE scratch dir (never inside `repo`) — a stray non-canon .md file
// under `repo` would be walked (and fail schema-validity) by `validate`'s
// own corpus walker. ----

const tempDirs: string[] = []

function baseCounters(): Counters {
  return { product: { epic: 0, cr: 0, wp: 0, bug: 0, baselineSeq: {} }, epics: {}, retired: [] }
}

function makeRepo(counters: Counters = baseCounters()): string {
  const dir = mkdtempSync(join(tmpdir(), 'canon-cli-'))
  mkdirSync(join(dir, '.ba'), { recursive: true })
  writeFileSync(join(dir, '.ba', 'counters.yaml'), yamlStringify(counters), 'utf8')
  tempDirs.push(dir)
  return dir
}

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'canon-cli-scratch-'))
  tempDirs.push(dir)
  return dir
}

function scratchFile(content: string, name = 'body.md'): string {
  const dir = scratchDir()
  const path = join(dir, name)
  writeFileSync(path, content, 'utf8')
  return path
}

function seedRaw(repo: string, relPath: string, raw: string): string {
  const path = join(repo, relPath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, raw, 'utf8')
  return path
}

function seedVision(repo: string, status: 'draft' | 'confirmed' = 'confirmed'): string {
  return seedRaw(repo, 'vision.md', `---\ntype: vision\nstatus: ${status}\n---\n\nProduct vision text.\n`)
}

function seedFr(
  repo: string,
  id: string,
  epic: string,
  opts: {
    status?: string
    version?: number
    baseline?: string
    body?: string
    tracesTo?: string[]
    enforces?: string[]
    referencesNfr?: string[]
    provenance?: string
  } = {}
): string {
  const lines = [
    '---',
    `id: ${id}`,
    'type: fr',
    `epic: ${epic}`,
    `status: ${opts.status ?? 'active'}`,
    `version: ${opts.version ?? 1}`,
    `traces_to: [${(opts.tracesTo ?? []).join(', ')}]`,
    `enforces: [${(opts.enforces ?? []).join(', ')}]`,
    `references_nfr: [${(opts.referencesNfr ?? []).join(', ')}]`,
    'related: []',
  ]
  if (opts.baseline) lines.push(`baseline: ${opts.baseline}`)
  if (opts.provenance) lines.push(`provenance: ${opts.provenance}`)
  lines.push('---', '', opts.body ?? 'Story body.\n\n## Acceptance Criteria\n- AC-1: given a starting state, when the user acts, then an observable outcome.', '')
  return seedRaw(repo, join('epics', `${epic}-x`, `${id}.md`), lines.join('\n'))
}

// v3 (Task 4): a WP's FR scope lives in the body's `## Scope` / `### Delivers`
// link list (scopelinks.ts's `parseScope`), not frontmatter — `fr_ids` is
// retired from wpSchema entirely. `opts.frIds` still names the FRs the
// fixture delivers; it's now rendered as Scope links instead of a frontmatter
// array (mechanical flip, same call-site shape every test already uses).
// v3 (Task 5): the WP itself lives at `wp/<id>/index.md` (folder-per-item,
// matching `epics/E{n}-slug/index.md`), not a flat `wp/<id>.md` file —
// `writer.ts`'s exported `wpPath` is the one place this path is computed;
// this fixture writer just mirrors it.
// Scope paths are file-relative from `wp/<id>/index.md` (e.g. `../../epics/...`).
function seedWp(repo: string, id: string, opts: { status?: string; frIds?: string[]; crIds?: string[] } = {}): string {
  const deliversLines = (opts.frIds ?? [])
    .map((fr) => `- [${fr}](../../epics/${fr.split('-')[0]}-x/${fr}.md)`)
    .join('\n')
  const crLines = (opts.crIds ?? []).map((cr) => `- [${cr}](../../cr/${cr}.md)`).join('\n')
  const lines = [
    '---',
    `id: ${id}`,
    'type: wp',
    'role: developer',
    `status: ${opts.status ?? 'plan-approved'}`,
    '---',
    '',
    'A work package.',
    '',
    '## Scope',
    '',
    ...(crLines.length > 0 ? ['### Change requests', '', crLines, ''] : []),
    '### Delivers',
    '',
    deliversLines,
    '',
  ]
  return seedRaw(repo, join('wp', id, 'index.md'), lines.join('\n'))
}

function seedCr(repo: string, id: string, status: 'captured' | 'confirmed' | 'resolved' = 'confirmed'): string {
  return seedRaw(repo, join('cr', `${id}.md`), `---\nid: ${id}\ntype: cr\nstatus: ${status}\n---\n\nCaptured idea.\n`)
}

function readFm(
  repo: string,
  relPath: string,
  type: 'fr' | 'nfr' | 'br' | 'cr' | 'wp' | 'bug' | 'epic' | 'vision'
): Record<string, unknown> {
  const result = parseFile(join(repo, relPath), type)
  if ('error' in result) throw new Error(`fixture read failed: ${result.error}`)
  return result.frontmatter as Record<string, unknown>
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

// ==========================================================================
// global flag / dispatch plumbing
// ==========================================================================

describe('global plumbing', () => {
  it('requires --repo', async () => {
    const result = await runCli(['status'])
    expect(result.code).toBe(1)
    expect(result.json.verdict).toBe('VERIFY-FAIL')
  })

  it('rejects an unknown command', async () => {
    const repo = makeRepo()
    const result = await runCli(['frobnicate'], { repo })
    expect(result.code).toBe(1)
    expect(result.json.checks[0]?.reason).toMatch(/unknown command/)
  })

  it('there is no standalone baseline verb', async () => {
    const repo = makeRepo()
    const result = await runCli(['baseline'], { repo })
    expect(result.code).toBe(1)
    expect(result.json.verdict).toBe('VERIFY-FAIL')
    expect(result.json.checks[0]?.reason).toMatch(/no standalone 'baseline' verb/)
  })

  it('migrate requires --out', async () => {
    const repo = makeRepo()
    const result = await runCli(['migrate'], { repo })
    expect(result.code).toBe(1)
    expect(result.json.checks[0]?.reason).toMatch(/--out/)
  })

  // v3 (Task 8): `cr capture`/`req add` are retired the same way `wp author`
  // was (Task 5) — authoring is exclusively the hybrid `id next` + direct
  // `Write` skill pattern now; none of the three is a real dispatch verb.
  it.each([
    ['cr', 'capture'],
    ['req', 'add'],
    ['wp', 'author'],
  ])('%s %s is retired outright — dispatches to unknown command', async (cmd, sub) => {
    const repo = makeRepo()
    const result = await runCli([cmd, sub], { repo })
    expect(result.code).toBe(1)
    expect(result.json.checks[0]?.reason).toMatch(/unknown command/)
  })
})

// ==========================================================================
// vision confirm
// ==========================================================================

describe('vision confirm', () => {
  it('sets status: confirmed', async () => {
    const repo = makeRepo()
    seedVision(repo, 'draft')
    const result = await runCli(['vision', 'confirm', '--by', 'alex'], { repo })
    expect(result.code).toBe(0)
    const fm = readFm(repo, 'vision.md', 'vision')
    expect(fm.status).toBe('confirmed')
    expect(fm.confirmed_by).toBe('alex')
  })

  it('errors confirming an already-confirmed vision', async () => {
    const repo = makeRepo()
    seedVision(repo, 'confirmed')
    const result = await runCli(['vision', 'confirm'], { repo })
    expect(result.code).toBe(1)
  })
})

// ==========================================================================
// epic add / cr capture / cr confirm
// ==========================================================================

describe('epic add', () => {
  it('mints E1', async () => {
    const repo = makeRepo()
    const result = await runCli(['epic', 'add', '--title', 'Foundation'], { repo })
    expect(result.code).toBe(0)
    expect(result.json.id).toBe('E1')
  })

  it('requires --title', async () => {
    const repo = makeRepo()
    const result = await runCli(['epic', 'add'], { repo })
    expect(result.code).toBe(1)
  })
})

// `cr capture` is retired (Task 8) — a CR now starts life via the hybrid
// `id next` + direct `Write` skill pattern, so every test below seeds a
// `captured` CR directly (`seedCr`) rather than minting one through the CLI.
describe('cr confirm', () => {
  it('confirms entry: vision with no impacts', async () => {
    const repo = makeRepo()
    seedCr(repo, 'CR-001', 'captured')
    const result = await runCli(['cr', 'confirm', '--cr', 'CR-001', '--entry', 'vision'], { repo })
    expect(result.code).toBe(0)
    const fm = readFm(repo, 'cr/CR-001.md', 'cr')
    expect(fm.status).toBe('confirmed')
    expect(fm.entry_point).toBe('vision')
  })

  it('confirms entry: requirement given a valid --impacts-file', async () => {
    const repo = makeRepo()
    await runCli(['epic', 'add', '--title', 'Foundation'], { repo }) // mints E1
    seedFr(repo, 'E1-FR1', 'E1')
    seedCr(repo, 'CR-002', 'captured')
    const impactsFile = scratchFile(JSON.stringify([{ amends: 'E1-FR1' }, { spawns: 'fr', epic: 'E1' }]), 'impacts.json')

    const result = await runCli(
      ['cr', 'confirm', '--cr', 'CR-002', '--entry', 'requirement', '--impacts-file', impactsFile],
      { repo }
    )
    expect(result.code).toBe(0)
    const fm = readFm(repo, 'cr/CR-002.md', 'cr')
    expect(fm.status).toBe('confirmed')
    expect(fm.entry_point).toBe('requirement')
    expect(fm.impacts).toEqual([{ amends: 'E1-FR1' }, { spawns: 'fr', epic: 'E1' }])
  })

  it('rejects an --impacts-file that fails zod validation against crImpactSchema', async () => {
    const repo = makeRepo()
    seedCr(repo, 'CR-003', 'captured')
    const impactsFile = scratchFile(JSON.stringify([{ bogus: 'nope' }]), 'impacts.json')
    const result = await runCli(
      ['cr', 'confirm', '--cr', 'CR-003', '--entry', 'requirement', '--impacts-file', impactsFile],
      { repo }
    )
    expect(result.code).toBe(1)
  })

  it('rejects entry: requirement with no --impacts-file at all', async () => {
    const repo = makeRepo()
    seedCr(repo, 'CR-004', 'captured')
    const result = await runCli(['cr', 'confirm', '--cr', 'CR-004', '--entry', 'requirement'], { repo })
    expect(result.code).toBe(1)
  })

  it('rejects entry: vision carrying a non-empty --impacts-file', async () => {
    const repo = makeRepo()
    await runCli(['epic', 'add', '--title', 'Foundation'], { repo })
    seedCr(repo, 'CR-005', 'captured')
    const impactsFile = scratchFile(JSON.stringify([{ spawns: 'fr', epic: 'E1' }]), 'impacts.json')
    const result = await runCli(
      ['cr', 'confirm', '--cr', 'CR-005', '--entry', 'vision', '--impacts-file', impactsFile],
      { repo }
    )
    expect(result.code).toBe(1)
  })

  it('rejects a CR that is not captured', async () => {
    const repo = makeRepo()
    seedCr(repo, 'CR-006', 'confirmed')
    const result = await runCli(['cr', 'confirm', '--cr', 'CR-006', '--entry', 'vision'], { repo })
    expect(result.code).toBe(1)
  })
})

describe('cr realize', () => {
  it('realizes an un-realized spawn impact, stamping the new id', async () => {
    const repo = makeRepo()
    await runCli(['epic', 'add', '--title', 'Foundation'], { repo }) // mints E1
    seedFr(repo, 'E1-FR1', 'E1', { tracesTo: ['CR-007'] })
    seedRaw(
      repo,
      join('cr', 'CR-007.md'),
      '---\nid: CR-007\ntype: cr\nstatus: confirmed\nentry_point: requirement\nentry_point_confirmed: true\nimpacts:\n  - spawns: fr\n    epic: E1\n---\n\nIdea.\n'
    )

    const result = await runCli(['cr', 'realize', '--cr', 'CR-007', '--spawn', 'E1:fr', '--id', 'E1-FR1'], { repo })
    expect(result.code).toBe(0)
    const fm = readFm(repo, 'cr/CR-007.md', 'cr')
    expect(fm.impacts).toEqual([{ spawns: 'fr', epic: 'E1', realized: 'E1-FR1' }])
  })

  it('errors when no matching un-realized spawn entry exists', async () => {
    const repo = makeRepo()
    seedRaw(repo, join('cr', 'CR-008.md'), '---\nid: CR-008\ntype: cr\nstatus: confirmed\n---\n\nIdea.\n')
    const result = await runCli(['cr', 'realize', '--cr', 'CR-008', '--spawn', 'E1:fr', '--id', 'E1-FR1'], { repo })
    expect(result.code).toBe(1)
  })

  it('rejects a malformed --spawn spec', async () => {
    const repo = makeRepo()
    seedCr(repo, 'CR-009', 'confirmed')
    const result = await runCli(['cr', 'realize', '--cr', 'CR-009', '--spawn', 'bogus', '--id', 'E1-FR1'], { repo })
    expect(result.code).toBe(1)
    expect(result.json.checks[0]?.reason).toMatch(/--spawn must look like/)
  })
})

// ==========================================================================
// req edit / retire (`req add` retired — Task 8, same hybrid `id next` +
// direct `Write` posture as `cr capture`/`wp author`; the CLI-level CSV/
// kind/enforcement flag-mapping logic that verb owned is gone outright —
// `writer.ts`'s own `addRequirement` mutator is unaffected and stays covered
// directly by writer.test.ts. Every test below seeds its FR/NFR/BR fixture
// on disk directly, then edits/retires it through the still-real verb.)
// ==========================================================================

describe('req edit', () => {
  it('edits a draft in place (no version bump)', async () => {
    const repo = makeRepo()
    seedRaw(
      repo,
      'br/E1-BR1.md',
      '---\nid: E1-BR1\ntype: br\nepic: E1\nkind: operative\nenforcement: advisory\nstatus: draft\nversion: 1\n---\n\nOriginal.\n'
    )

    const newBody = scratchFile('Edited.\n')
    const result = await runCli(['req', 'edit', '--req', 'E1-BR1', '--body-file', newBody], { repo })
    expect(result.code).toBe(0)
    expect(result.json.checks[0]?.reason).not.toMatch(/version bumped/)
  })

  it('--activate moves draft -> active', async () => {
    const repo = makeRepo()
    seedRaw(
      repo,
      'br/E1-BR1.md',
      '---\nid: E1-BR1\ntype: br\nepic: E1\nkind: operative\nenforcement: advisory\nstatus: draft\nversion: 1\n---\n\nOriginal.\n'
    )
    const body = scratchFile('Original.\n')

    const result = await runCli(['req', 'edit', '--req', 'E1-BR1', '--body-file', body, '--activate'], { repo })
    expect(result.code).toBe(0)
    expect(readFm(repo, 'br/E1-BR1.md', 'br').status).toBe('active')
  })

  it('strips a full-page --body-file so draft→active never creates duplicate frontmatter', async () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', { status: 'draft', tracesTo: ['CR-001'] })
    const fullPage = scratchFile(
      `---\nid: E1-FR1\ntype: fr\nepic: E1\nstatus: draft\nversion: 1\ntraces_to: [CR-001]\nenforces: []\nreferences_nfr: []\nrelated: []\n---\n\n## Rationale\nDepends on PXT-NFR-001.\n\n## Acceptance Criteria\n- AC-1: given x, when y, then z.\n`,
    )
    const result = await runCli(
      ['req', 'edit', '--req', 'E1-FR1', '--body-file', fullPage, '--activate'],
      { repo },
    )
    expect(result.code).toBe(0)
    const raw = readFileSync(join(repo, 'epics/E1-x/E1-FR1.md'), 'utf8')
    expect(raw.match(/^---$/gm)?.length).toBe(2)
    expect(raw).not.toMatch(/---\n[\s\S]*---\n---/)
    const fm = readFm(repo, 'epics/E1-x/E1-FR1.md', 'fr') as { status: string; references_nfr: string[] }
    expect(fm.status).toBe('active')
    expect(fm.references_nfr).toContain('PXT-NFR-001')
  })
})

describe('req retire', () => {
  it('retires cleanly when nothing references it', async () => {
    const repo = makeRepo()
    seedRaw(
      repo,
      'br/E1-BR1.md',
      '---\nid: E1-BR1\ntype: br\nepic: E1\nkind: operative\nenforcement: advisory\nstatus: draft\nversion: 1\n---\n\nBody.\n'
    )

    const result = await runCli(['req', 'retire', '--req', 'E1-BR1'], { repo })
    expect(result.code).toBe(0)
    expect(readFm(repo, 'br/E1-BR1.md', 'br').status).toBe('retired')
  })

  it('emits an advisory (exit 2) for a dangling backlink', async () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', { enforces: ['E1-BR1'] })
    seedRaw(
      repo,
      'br/E1-BR1.md',
      '---\nid: E1-BR1\ntype: br\nepic: E1\nkind: operative\nenforcement: advisory\nstatus: active\nversion: 1\n---\n\nA rule.\n'
    )
    const result = await runCli(['req', 'retire', '--req', 'E1-BR1'], { repo })
    expect(result.code).toBe(2)
    expect(result.json.verdict).toBe('VERIFY-OK')
  })
})

// ==========================================================================
// wp prepare / approve-plan / abandon (`wp author` retired — Task 5; the WP
// authoring path is now the hybrid `id next` + direct `Write` skill pattern,
// no longer a CLI create verb)
// ==========================================================================

describe('wp prepare', () => {
  it('VERIFY-FAILs a WP that does not resolve', async () => {
    const repo = makeRepo()
    const result = await runCli(['wp', 'prepare', '--wp', 'WP-20260713-999'], { repo })
    expect(result.code).toBe(1)
    expect(result.json.verdict).toBe('VERIFY-FAIL')
  })

  it('VERIFY-FAILs a WP with an empty fr_ids closure', async () => {
    const repo = makeRepo()
    seedWp(repo, 'WP-20260713-001', { frIds: [] })
    const result = await runCli(['wp', 'prepare', '--wp', 'WP-20260713-001'], { repo })
    expect(result.code).toBe(1)
    expect(result.json.verdict).toBe('VERIFY-FAIL')
  })

  it('VERIFY-FAILs on a real definitionOfReady failure (unconfirmed vision)', async () => {
    const repo = makeRepo()
    seedVision(repo, 'draft')
    seedCr(repo, 'CR-001', 'confirmed')
    seedFr(repo, 'E1-FR1', 'E1', { status: 'active', tracesTo: ['CR-001'] })
    seedWp(repo, 'WP-20260713-001', { frIds: ['E1-FR1'], status: 'draft' })
    const result = await runCli(['wp', 'prepare', '--wp', 'WP-20260713-001'], { repo })
    expect(result.code).toBe(1)
  })

  it('on green: flips the closure to batched, sets WP ready, writes the batch cache', async () => {
    const repo = makeRepo()
    seedVision(repo, 'confirmed')
    seedCr(repo, 'CR-001', 'confirmed')
    seedFr(repo, 'E1-FR1', 'E1', { status: 'active', tracesTo: ['CR-001'] })
    seedWp(repo, 'WP-20260713-001', { frIds: ['E1-FR1'], crIds: ['CR-001'], status: 'draft' })

    const result = await runCli(['wp', 'prepare', '--wp', 'WP-20260713-001'], { repo })
    expect(result.code).toBe(0)
    expect(readFm(repo, 'epics/E1-x/E1-FR1.md', 'fr').status).toBe('batched')
    expect(readFm(repo, 'wp/WP-20260713-001/index.md', 'wp').status).toBe('ready')
  })
})

// v3 (Task 8): `--plan` must be the canon-relative convention
// `wp/<wpId>/plan.md` (mirroring `writer.ts`'s own `wpPath`), not any old
// path — every fixture below writes the plan file at that exact location.
describe('wp approve-plan', () => {
  it('approves a ready WP whose plan file exists at the canon convention', async () => {
    const repo = makeRepo({
      product: { epic: 1, cr: 1, wp: 1, bug: 0, baselineSeq: {} },
      epics: { E1: { fr: 1, nfr: 0, br: 0 } },
      retired: [],
    })
    seedVision(repo, 'confirmed')
    seedCr(repo, 'CR-001', 'confirmed')
    seedFr(repo, 'E1-FR1', 'E1', { status: 'batched', tracesTo: ['CR-001'] })
    seedWp(repo, 'WP-20260713-001', { status: 'ready', frIds: ['E1-FR1'], crIds: ['CR-001'] })
    seedRaw(repo, join('wp', 'WP-20260713-001', 'plan.md'), '# Plan\n')

    const result = await runCli(
      ['wp', 'approve-plan', '--wp', 'WP-20260713-001', '--plan', 'wp/WP-20260713-001/plan.md'],
      { repo }
    )
    expect(result.code).toBe(0)
    expect(readFm(repo, 'wp/WP-20260713-001/index.md', 'wp').status).toBe('plan-approved')
  })

  it('refuses approval when validate fails (hard gate)', async () => {
    const repo = makeRepo()
    // Ready WP with a Scope link to a missing FR — validate must FAIL.
    seedWp(repo, 'WP-20260713-001', { status: 'ready', frIds: ['E1-FR1'] })
    seedRaw(repo, join('wp', 'WP-20260713-001', 'plan.md'), '# Plan\n')
    const result = await runCli(
      ['wp', 'approve-plan', '--wp', 'WP-20260713-001', '--plan', 'wp/WP-20260713-001/plan.md'],
      { repo },
    )
    expect(result.code).toBe(1)
    expect(result.json.verdict).toBe('VERIFY-FAIL')
    expect(readFm(repo, 'wp/WP-20260713-001/index.md', 'wp').status).toBe('ready')
  })

  it('rejects a --plan path that does not follow the wp/<id>/plan.md convention', async () => {
    const repo = makeRepo()
    seedWp(repo, 'WP-20260713-001', { status: 'ready', frIds: ['E1-FR1'] })
    const plan = scratchFile('# Plan\n')

    const result = await runCli(['wp', 'approve-plan', '--wp', 'WP-20260713-001', '--plan', plan], { repo })
    expect(result.code).toBe(1)
    expect(result.json.checks[0]?.reason).toMatch(/canon-relative path/)
  })

  it('rejects a conventionally-named plan path that does not exist on disk', async () => {
    const repo = makeRepo()
    seedWp(repo, 'WP-20260713-001', { status: 'ready', frIds: ['E1-FR1'] })

    const result = await runCli(
      ['wp', 'approve-plan', '--wp', 'WP-20260713-001', '--plan', 'wp/WP-20260713-001/plan.md'],
      { repo }
    )
    expect(result.code).toBe(1)
  })

  it('rejects a WP that is not ready', async () => {
    const repo = makeRepo()
    seedWp(repo, 'WP-20260713-001', { status: 'draft', frIds: ['E1-FR1'] })
    seedRaw(repo, join('wp', 'WP-20260713-001', 'plan.md'), '# Plan\n')

    const result = await runCli(
      ['wp', 'approve-plan', '--wp', 'WP-20260713-001', '--plan', 'wp/WP-20260713-001/plan.md'],
      { repo }
    )
    expect(result.code).toBe(1)
  })
})

describe('wp abandon', () => {
  it('reverts batched members to active and sets WP abandoned', async () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', { status: 'batched' })
    seedWp(repo, 'WP-20260713-001', { status: 'ready', frIds: ['E1-FR1'] })

    const result = await runCli(['wp', 'abandon', '--wp', 'WP-20260713-001'], { repo })
    expect(result.code).toBe(0)
    expect(readFm(repo, 'epics/E1-x/E1-FR1.md', 'fr').status).toBe('active')
    expect(readFm(repo, 'wp/WP-20260713-001/index.md', 'wp').status).toBe('abandoned')
  })

  it('is a clean failure for an unknown WP', async () => {
    const repo = makeRepo()
    const result = await runCli(['wp', 'abandon', '--wp', 'WP-20260713-999'], { repo })
    expect(result.code).toBe(1)
  })
})

// ==========================================================================
// accept
// ==========================================================================

describe('accept', () => {
  it('runs the accept transaction end to end via an explicit --head-commit', async () => {
    const repo = makeRepo()
    seedVision(repo, 'confirmed')
    seedCr(repo, 'CR-001', 'confirmed')
    seedFr(repo, 'E1-FR1', 'E1', { status: 'batched', tracesTo: ['CR-001'] })
    seedWp(repo, 'WP-20260713-001', { status: 'plan-approved', frIds: ['E1-FR1'] })

    const evidence = {
      wpId: 'WP-20260713-001',
      commit: 'deadbeef',
      testRunHashes: ['h1'],
      suites: ['unit'],
      producedAt: '2026-07-13T00:00:00Z',
      producedBy: 'alex',
      toolVersion: '0.0.1',
    }
    const evidencePath = scratchFile(JSON.stringify(evidence), 'evidence.json')

    const result = await runCli(
      ['accept', '--wp', 'WP-20260713-001', '--evidence', evidencePath, '--date', '20260713', '--head-commit', 'deadbeef'],
      { repo }
    )
    expect(result.code).toBe(0)
    expect(result.json.verdict).toBe('VERIFY-OK')
    expect(readFm(repo, 'epics/E1-x/E1-FR1.md', 'fr').status).toBe('baselined')
  })
})

// ==========================================================================
// bug capture / resolve
// ==========================================================================

describe('bug capture / resolve', () => {
  it('captures an open bug', async () => {
    const repo = makeRepo()
    const body = scratchFile('It crashes.\n')
    const result = await runCli(['bug', 'capture', '--affects', 'E1-FR1', '--severity', 'high', '--body-file', body], { repo })
    expect(result.code).toBe(0)
    const fm = readFm(repo, `bugs/${result.json.id}.md`, 'bug')
    expect(fm.status).toBe('open')
    expect(fm.affects).toEqual(['E1-FR1'])
  })

  it('resolves a bug and can spawn a CR', async () => {
    const repo = makeRepo()
    const body = scratchFile('It crashes.\n')
    const captured = await runCli(['bug', 'capture', '--affects', 'E1-FR1', '--severity', 'high', '--body-file', body], { repo })
    const bugId = captured.json.id as string

    const result = await runCli(['bug', 'resolve', '--bug', bugId, '--status', 'fixed', '--spawn-cr'], { repo })
    expect(result.code).toBe(0)
    const fm = readFm(repo, `bugs/${bugId}.md`, 'bug')
    expect(fm.status).toBe('fixed')
    expect(typeof fm.spawned_cr).toBe('string')
  })

  it('rejects an unrecognized --status', async () => {
    const repo = makeRepo()
    const body = scratchFile('It crashes.\n')
    const captured = await runCli(['bug', 'capture', '--affects', 'E1-FR1', '--severity', 'high', '--body-file', body], { repo })
    const result = await runCli(['bug', 'resolve', '--bug', captured.json.id as string, '--status', 'bogus'], { repo })
    expect(result.code).toBe(1)
  })
})

// ==========================================================================
// id next / status / render/export
// ==========================================================================

describe('id next', () => {
  it.each([
    ['epic', 'E1', 'E2'],
    ['cr', 'CR-001', 'CR-002'],
    ['bug', 'BUG-001', 'BUG-002'],
  ])('mints and PERSISTS the next %s id (a second call returns the next id, not the same one)', async (kind, first, second) => {
    const repo = makeRepo()
    const result = await runCli(['id', 'next', '--scope', kind], { repo })
    expect(result.code).toBe(0)
    expect(result.json.checks[0]?.reason).toBe(first)
    // persisted: the ledger advanced, so asking again mints the NEXT id
    const again = await runCli(['id', 'next', '--scope', kind], { repo })
    expect(again.json.checks[0]?.reason).toBe(second)
  })

  it('mints a wp id given --date, and the ledger backs validate\'s id-max-guard for the minted id', async () => {
    const repo = makeRepo()
    const result = await runCli(['id', 'next', '--scope', 'wp', '--date', '20260713'], { repo })
    expect(result.json.checks[0]?.reason).toBe('WP-20260713-001')
    // the mint persisted counters.product.wp = 1 — a page written with that
    // exact id (id-max-guard's job is to confirm the ledger covers every id
    // seen in the corpus) must not trip the guard for this id.
    seedWp(repo, 'WP-20260713-001', { status: 'draft', frIds: [] })
    const validated = await runCli(['validate', '--check'], { repo })
    const idMaxGuard = validated.json.checks.find((c) => c.name === 'id-max-guard')
    expect(idMaxGuard?.ok).toBe(true)
  })

  it('two sequential wp mints for the same date are distinct and monotonic', async () => {
    const repo = makeRepo()
    const first = await runCli(['id', 'next', '--scope', 'wp', '--date', '20260713'], { repo })
    const second = await runCli(['id', 'next', '--scope', 'wp', '--date', '20260713'], { repo })
    expect(first.json.checks[0]?.reason).toBe('WP-20260713-001')
    expect(second.json.checks[0]?.reason).toBe('WP-20260713-002')
  })

  it('requires --date for wp scope', async () => {
    const repo = makeRepo()
    const result = await runCli(['id', 'next', '--scope', 'wp'], { repo })
    expect(result.code).toBe(1)
  })

  it('mints fr/nfr/br ids scoped to an epic, and persists across calls', async () => {
    const repo = makeRepo({ product: { epic: 1, cr: 0, wp: 0, bug: 0, baselineSeq: {} }, epics: { E1: { fr: 2, nfr: 0, br: 0 } }, retired: [] })
    const result = await runCli(['id', 'next', '--scope', 'fr:E1'], { repo })
    expect(result.json.checks[0]?.reason).toBe('E1-FR3')
    const again = await runCli(['id', 'next', '--scope', 'fr:E1'], { repo })
    expect(again.json.checks[0]?.reason).toBe('E1-FR4')
  })

  it('requires an epic for fr/nfr/br scopes', async () => {
    const repo = makeRepo()
    const result = await runCli(['id', 'next', '--scope', 'fr'], { repo })
    expect(result.code).toBe(1)
  })

  it('rejects an unrecognized scope', async () => {
    const repo = makeRepo()
    const result = await runCli(['id', 'next', '--scope', 'bogus'], { repo })
    expect(result.code).toBe(1)
  })
})

describe('status', () => {
  it('is a read-only summary with structured missing checks', async () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1')
    const result = await runCli(['status'], { repo })
    expect(result.json.verdict).toBe('VERIFY-OK')
    expect([0, 2]).toContain(result.code)
    expect(result.json.checks.some((c) => c.name === 'frs')).toBe(true)
    expect(result.json.checks.some((c) => c.name === 'missing:requirement-without-ac' || c.name === 'missing:requirement-unverifiable-ac' || c.name === 'missing:requirement-without-goal')).toBe(true)
  })
})

describe('goals status / check-goals', () => {
  it('lists requirements without goals (advisory)', async () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1')
    const result = await runCli(['goals', 'status'], { repo })
    expect(result.json.verdict).toBe('VERIFY-OK')
    expect(result.code).toBe(2)
    const check = result.json.checks.find((c) => c.name === 'requirements-without-goals')
    expect(check?.ok).toBe(false)
    expect(check?.reason).toContain('E1-FR1')
  })

  it('check-goals is an alias', async () => {
    const repo = makeRepo()
    const result = await runCli(['check-goals'], { repo })
    expect(result.json.checks.some((c) => c.name === 'requirements-without-goals')).toBe(true)
  })
})

describe('render / export', () => {
  it.each(['prd', 'rtm', 'backlog'] as const)('renders %s without writing canon', async (what) => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1')
    const before = readFm(repo, 'epics/E1-x/E1-FR1.md', 'fr')
    const result = await runCli(['render', '--what', what], { repo })
    expect(result.code).toBe(0)
    expect(typeof result.json.checks[0]?.reason).toBe('string')
    expect(readFm(repo, 'epics/E1-x/E1-FR1.md', 'fr')).toEqual(before)
  })

  it('export is a synonym for render', async () => {
    const repo = makeRepo()
    const result = await runCli(['export', '--what', 'rtm'], { repo })
    expect(result.code).toBe(0)
  })

  it('rejects an unrecognized --what', async () => {
    const repo = makeRepo()
    const result = await runCli(['render', '--what', 'bogus'], { repo })
    expect(result.code).toBe(1)
  })
})

// ==========================================================================
// validate — the aggregator (RED-list behaviors + extras)
// ==========================================================================

describe('validate', () => {
  it('exits 0 (VERIFY-OK) on a clean fixture repo', async () => {
    // `CR-001`/`E1-FR1` are raw-seeded (`seedCr`/`seedFr`), not minted via
    // `allocateId` — the ledger must be pre-set to cover them, or
    // `id-max-guard` trips (same convention every other raw-seed + validate
    // test in this file already follows).
    const repo = makeRepo({
      product: { epic: 0, cr: 1, wp: 0, bug: 0, baselineSeq: {} },
      epics: { E1: { fr: 1, nfr: 0, br: 0 } },
      retired: [],
    })
    seedVision(repo, 'draft')
    await runCli(['vision', 'confirm'], { repo })

    const epic = await runCli(['epic', 'add', '--title', 'Foundation'], { repo })
    seedCr(repo, 'CR-001', 'confirmed')
    seedFr(repo, 'E1-FR1', epic.json.id as string, {
      status: 'active',
      tracesTo: ['CR-001'],
      body: 'Story.\n\n## Acceptance Criteria\n- AC-1: Something happens.\n',
    })

    const result = await runCli(['validate'], { repo })
    expect(result.code).toBe(0)
    expect(result.json.verdict).toBe('VERIFY-OK')
    expect(result.json.checks.every((c) => c.ok)).toBe(true)
  })

  it('exits 1 (VERIFY-FAIL) on a dangling ref', async () => {
    const repo = makeRepo()
    seedVision(repo, 'draft')
    await runCli(['vision', 'confirm'], { repo })
    const epic = await runCli(['epic', 'add', '--title', 'Foundation'], { repo })
    seedFr(repo, 'E1-FR1', epic.json.id as string, {
      status: 'active',
      tracesTo: ['CR-999'],
      body: 'Story.\n\n## Acceptance Criteria\n- AC-1: Something happens.\n',
    })

    const result = await runCli(['validate'], { repo })
    expect(result.code).toBe(1)
    expect(result.json.verdict).toBe('VERIFY-FAIL')
    const danglingCheck = result.json.checks.find((c) => c.name === 'no-dangling-refs')
    expect(danglingCheck?.ok).toBe(false)
  })

  it('exits 2 (advisory) on a provenance:migrated orphan FR', async () => {
    const repo = makeRepo({
      product: { epic: 1, cr: 0, wp: 0, bug: 0, baselineSeq: {} },
      epics: { E1: { fr: 1, nfr: 0, br: 0 } },
      retired: [],
    })
    seedVision(repo, 'confirmed')
    seedFr(repo, 'E1-FR1', 'E1', { status: 'active', tracesTo: [], provenance: 'migrated' })

    const result = await runCli(['validate'], { repo })
    expect(result.code).toBe(2)
    expect(result.json.verdict).toBe('VERIFY-OK')
    const migratedCheck = result.json.checks.find((c) => c.name === 'migrated-orphans')
    expect(migratedCheck?.ok).toBe(false)
    const hardOrphanCheck = result.json.checks.find((c) => c.name === 'no-orphans')
    expect(hardOrphanCheck?.ok).toBe(true)
  })

  it('exits 1 on a schema-invalid page', async () => {
    const repo = makeRepo({
      product: { epic: 1, cr: 0, wp: 0, bug: 0, baselineSeq: {} },
      epics: { E1: { fr: 1, nfr: 0, br: 0 } },
      retired: [],
    })
    seedVision(repo, 'confirmed')
    // missing the required `epic` field
    seedRaw(
      repo,
      'epics/E1-x/E1-FR1.md',
      '---\nid: E1-FR1\ntype: fr\nstatus: active\nversion: 1\ntraces_to: []\nenforces: []\nreferences_nfr: []\nrelated: []\n---\n\nBroken.\n'
    )
    const result = await runCli(['validate'], { repo })
    expect(result.code).toBe(1)
    const schemaCheck = result.json.checks.find((c) => c.name === 'schema-valid')
    expect(schemaCheck?.ok).toBe(false)
  })

  it('exits 1 on the accept partial-state predicate (baseline claimed but manifest absent)', async () => {
    const repo = makeRepo({
      product: { epic: 1, cr: 0, wp: 0, bug: 0, baselineSeq: {} },
      epics: { E1: { fr: 1, nfr: 0, br: 0 } },
      retired: [],
    })
    seedVision(repo, 'confirmed')
    seedFr(repo, 'E1-FR1', 'E1', { status: 'baselined', baseline: 'BL-20260101' })

    const result = await runCli(['validate'], { repo })
    expect(result.code).toBe(1)
    const partialCheck = result.json.checks.find((c) => c.name === 'accept-partial-state')
    expect(partialCheck?.ok).toBe(false)
  })

  it('exits 2 (advisory) on an orphaned accept pending-marker', async () => {
    const repo = makeRepo()
    seedVision(repo, 'confirmed')
    seedRaw(repo, join('.ba', 'cache', 'pending-WP-20260713-001.json'), '{}')

    const result = await runCli(['validate'], { repo })
    expect(result.code).toBe(2)
    const markerCheck = result.json.checks.find((c) => c.name === 'no-orphaned-pending-markers')
    expect(markerCheck?.ok).toBe(false)
  })

  it('exits 1 on a duplicate AC id anywhere in the corpus', async () => {
    const repo = makeRepo({
      product: { epic: 1, cr: 0, wp: 0, bug: 0, baselineSeq: {} },
      epics: { E1: { fr: 1, nfr: 0, br: 0 } },
      retired: [],
    })
    seedVision(repo, 'confirmed')
    seedFr(repo, 'E1-FR1', 'E1', {
      status: 'active',
      tracesTo: [],
      provenance: 'migrated', // avoid also tripping the orphan check for this test's purposes
      body: 'Story.\n\n## Acceptance Criteria\n- AC-1: First.\n- AC-1: Duplicate.\n',
    })

    const result = await runCli(['validate'], { repo })
    expect(result.code).toBe(1)
    const dupCheck = result.json.checks.find((c) => c.name === 'no-duplicate-ac-ids')
    expect(dupCheck?.ok).toBe(false)
  })

  describe('--check', () => {
    it('passes on a repo written entirely through the library', async () => {
      const repo = makeRepo()
      seedVision(repo, 'draft')
      await runCli(['vision', 'confirm'], { repo })
      await runCli(['epic', 'add', '--title', 'Foundation'], { repo })

      const result = await runCli(['validate', '--check'], { repo })
      expect(result.code).toBe(0)
      expect(result.json.checks.find((c) => c.name === 'frontmatter-round-trip')?.ok).toBe(true)
      expect(result.json.checks.find((c) => c.name === 'derived-view-idempotent')?.ok).toBe(true)
    })

    it('catches a non-canonical frontmatter key order', async () => {
      const repo = makeRepo({
        product: { epic: 1, cr: 0, wp: 0, bug: 0, baselineSeq: {} },
        epics: { E1: { fr: 0, nfr: 0, br: 1 } },
        retired: [],
      })
      // `type` before `id` — valid content, wrong key order vs. KEY_ORDER.
      seedRaw(
        repo,
        'br/E1-BR1.md',
        '---\ntype: br\nid: E1-BR1\nepic: E1\nkind: operative\nenforcement: advisory\nstatus: draft\nversion: 1\n---\n\nA rule.\n'
      )
      const result = await runCli(['validate', '--check'], { repo })
      expect(result.code).toBe(1)
      expect(result.json.checks.find((c) => c.name === 'frontmatter-round-trip')?.ok).toBe(false)
    })
  })
})

// ==========================================================================
// validate — the 5 new v3 checks (Task 8): each raw-seeds the exact shape
// needed to trip one rule, without going through a mint verb — most of these
// scenarios (a stale version stamp, a duplicate heading, an inconsistent
// `realized` id) can't arise from any live CLI write path at all; they model
// hand-edited/corrupted canon, which is exactly what `validate` exists to
// catch.
// ==========================================================================

/** A minimal `wp/<id>/index.md` body — `## Scope` with an optional
 * `### Change requests` bucket and a `### Delivers` bucket carrying exactly
 * one link line each, callers supply pre-rendered. Mirrors `seedWp`'s own
 * shape but lets a test hand-craft a single Scope link line (a bad anchor, a
 * stale version stamp) that `seedWp`'s own opts shape can't express. */
function wpIndexRaw(id: string, status: string, deliversLine: string, crLine?: string): string {
  return [
    '---',
    `id: ${id}`,
    'type: wp',
    'role: developer',
    `status: ${status}`,
    '---',
    '',
    'A work package.',
    '',
    '## Scope',
    '',
    ...(crLine ? ['### Change requests', '', crLine, ''] : []),
    '### Delivers',
    '',
    deliversLine,
    '',
  ].join('\n')
}

describe('validate — v3 checks', () => {
  it('wp-scope-links and wp-scope-version-current are ok on a fully-correct WP Scope (true negative — guards validate() wiring the paths map into buildGraph, without which every path check fails corpus-wide)', async () => {
    const repo = makeRepo({
      product: { epic: 0, cr: 1, wp: 1, bug: 0, baselineSeq: {} },
      epics: { E1: { fr: 1, nfr: 0, br: 0 } },
      retired: [],
    })
    seedVision(repo, 'confirmed')
    seedCr(repo, 'CR-001', 'confirmed')
    seedFr(repo, 'E1-FR1', 'E1', { status: 'active', tracesTo: ['CR-001'], version: 1 })
    const linkRoot = basename(resolve(repo))
    seedRaw(
      repo,
      join('wp', 'WP-20260713-001', 'index.md'),
      wpIndexRaw(
        'WP-20260713-001',
        'draft', // non-accepted, so wp-scope-version-current actually evaluates the stamp
        // Fully correct on every axis the two checks validate: a
        // linkRoot-prefixed path matching the real on-disk page location, an
        // anchor that exists on the target page (seedFr's default body has
        // `## Acceptance Criteria`), and a version stamp matching the
        // target's current version.
        `- [E1-FR1 v1](../../epics/E1-x/E1-FR1.md#acceptance-criteria)`,
        `- [CR-001](../../cr/CR-001.md)`
      )
    )

    const result = await runCli(['validate'], { repo })
    const links = result.json.checks.find((c) => c.name === 'wp-scope-links')
    expect(links?.ok, links?.reason).toBe(true)
    const versions = result.json.checks.find((c) => c.name === 'wp-scope-version-current')
    expect(versions?.ok, versions?.reason).toBe(true)
  })

  it('wp-scope-links fails when a Scope link names an anchor absent from the target page', async () => {
    const repo = makeRepo()
    seedVision(repo, 'confirmed')
    seedCr(repo, 'CR-001', 'confirmed')
    seedFr(repo, 'E1-FR1', 'E1', { status: 'active', tracesTo: ['CR-001'] })
    const linkRoot = basename(resolve(repo))
    seedRaw(
      repo,
      join('wp', 'WP-20260713-001', 'index.md'),
      wpIndexRaw(
        'WP-20260713-001',
        'draft',
        `- [E1-FR1](../../epics/E1-x/E1-FR1.md#no-such-anchor)`,
        `- [CR-001](../../cr/CR-001.md)`
      )
    )

    const result = await runCli(['validate'], { repo })
    expect(result.code).toBe(1)
    const check = result.json.checks.find((c) => c.name === 'wp-scope-links')
    expect(check?.ok).toBe(false)
    expect(check?.reason).toMatch(/anchor/)
  })

  it('wp-scope-version-current fails a stale stamp on a non-accepted WP, but not on an accepted one', async () => {
    const repo = makeRepo()
    seedVision(repo, 'confirmed')
    seedCr(repo, 'CR-001', 'confirmed')
    seedFr(repo, 'E1-FR1', 'E1', { status: 'active', tracesTo: ['CR-001'], version: 2 })
    const linkRoot = basename(resolve(repo))
    const crLine = `- [CR-001](../../cr/CR-001.md)`
    const deliversLine = `- [E1-FR1 v1](../../epics/E1-x/E1-FR1.md)` // stale: current version is 2

    seedRaw(repo, join('wp', 'WP-20260713-001', 'index.md'), wpIndexRaw('WP-20260713-001', 'draft', deliversLine, crLine))
    const draftResult = await runCli(['validate'], { repo })
    expect(draftResult.code).toBe(1)
    expect(draftResult.json.checks.find((c) => c.name === 'wp-scope-version-current')?.ok).toBe(false)

    seedRaw(repo, join('wp', 'WP-20260713-001', 'index.md'), wpIndexRaw('WP-20260713-001', 'accepted', deliversLine, crLine))
    const acceptedResult = await runCli(['validate'], { repo })
    expect(acceptedResult.json.checks.find((c) => c.name === 'wp-scope-version-current')?.ok).toBe(true)
  })

  // finding #9: an 'abandoned' WP's Scope stamps are a historical record too
  // (mirrors serialize.ts's exportBacklog, which already groups accepted and
  // abandoned as the same "no longer open" class) — a later, legitimate
  // version bump elsewhere must not turn a dead WP into a permanent,
  // unfixable VERIFY-FAIL.
  it('wp-scope-version-current also skips an ABANDONED WP with a stale stamp (mirrors the accepted exemption)', async () => {
    const repo = makeRepo()
    seedVision(repo, 'confirmed')
    seedCr(repo, 'CR-001', 'confirmed')
    seedFr(repo, 'E1-FR1', 'E1', { status: 'active', tracesTo: ['CR-001'], version: 2 })
    const linkRoot = basename(resolve(repo))
    const crLine = `- [CR-001](../../cr/CR-001.md)`
    const deliversLine = `- [E1-FR1 v1](../../epics/E1-x/E1-FR1.md)` // stale: current version is 2

    seedRaw(repo, join('wp', 'WP-20260713-001', 'index.md'), wpIndexRaw('WP-20260713-001', 'abandoned', deliversLine, crLine))
    const result = await runCli(['validate'], { repo })
    expect(result.json.checks.find((c) => c.name === 'wp-scope-version-current')?.ok).toBe(true)
  })

  it('cr-impacts-present fails on a confirmed requirement-entry CR with an empty impacts set', async () => {
    const repo = makeRepo()
    seedRaw(
      repo,
      'cr/CR-001.md',
      '---\nid: CR-001\ntype: cr\nstatus: confirmed\nentry_point: requirement\nentry_point_confirmed: true\n---\n\nIdea.\n'
    )

    const result = await runCli(['validate'], { repo })
    expect(result.code).toBe(1)
    const check = result.json.checks.find((c) => c.name === 'cr-impacts-present')
    expect(check?.ok).toBe(false)
  })

  // finding #20: the two dangling-impact branches (amends -> nonexistent id;
  // spawns -> nonexistent epic) had zero test coverage — only the
  // empty-impacts branch above was exercised.
  it('cr-impacts-present fails when an amends impact does not resolve to a real requirement', async () => {
    const repo = makeRepo()
    seedRaw(
      repo,
      'cr/CR-001.md',
      '---\nid: CR-001\ntype: cr\nstatus: confirmed\nentry_point: requirement\nentry_point_confirmed: true\nimpacts:\n  - amends: E9-FR9\n---\n\nIdea.\n'
    )
    const result = await runCli(['validate'], { repo })
    expect(result.code).toBe(1)
    const check = result.json.checks.find((c) => c.name === 'cr-impacts-present')
    expect(check?.ok).toBe(false)
    expect(check?.reason).toMatch(/amends.*does not resolve/)
  })

  it('cr-impacts-present fails when a spawns impact declares a non-existent epic', async () => {
    const repo = makeRepo()
    seedRaw(
      repo,
      'cr/CR-002.md',
      '---\nid: CR-002\ntype: cr\nstatus: confirmed\nentry_point: requirement\nentry_point_confirmed: true\nimpacts:\n  - spawns: fr\n    epic: E999\n---\n\nIdea.\n'
    )
    const result = await runCli(['validate'], { repo })
    expect(result.code).toBe(1)
    const check = result.json.checks.find((c) => c.name === 'cr-impacts-present')
    expect(check?.ok).toBe(false)
    expect(check?.reason).toMatch(/spawns.*epic.*does not resolve/)
  })

  it('cr-impacts-consistent fails when a realized spawn id exists but its traces_to omits the citing CR', async () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', { status: 'active', tracesTo: [] })
    seedRaw(
      repo,
      'cr/CR-001.md',
      '---\nid: CR-001\ntype: cr\nstatus: confirmed\nentry_point: requirement\nentry_point_confirmed: true\nimpacts:\n  - spawns: fr\n    epic: E1\n    realized: E1-FR1\n---\n\nIdea.\n'
    )

    const result = await runCli(['validate'], { repo })
    expect(result.code).toBe(1)
    const check = result.json.checks.find((c) => c.name === 'cr-impacts-consistent')
    expect(check?.ok).toBe(false)
    expect(check?.reason).toMatch(/traces_to/)
  })

  it("cr-impacts-consistent fails when a resolved CR's impacts are not actually all delivered", async () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', { status: 'active' }) // not baselined — the amend never landed
    seedRaw(
      repo,
      'cr/CR-002.md',
      '---\nid: CR-002\ntype: cr\nstatus: resolved\nentry_point: requirement\nentry_point_confirmed: true\nimpacts:\n  - amends: E1-FR1\n---\n\nIdea.\n'
    )

    const result = await runCli(['validate'], { repo })
    expect(result.code).toBe(1)
    const check = result.json.checks.find((c) => c.name === 'cr-impacts-consistent')
    expect(check?.ok).toBe(false)
  })

  // Task 9b: a `provenance: backfilled` CR (schema.ts) never gets a
  // fabricated `## History` citation on an amended target by design (see
  // reconcile.ts's header) — `crImpactsDelivered` skips that evidentiary
  // check for such a CR, and `cr-impacts-consistent`'s rule 2 (every
  // `resolved` CR satisfies that SAME predicate) must agree, or the
  // migration's "auto-resolve on the final reconcile" goal would leave a
  // freshly-resolved backfilled CR immediately failing `validate` again.
  it("cr-impacts-consistent passes a resolved backfilled CR whose amends target is baselined with no History citation (the no-History/no-traces backfill shape)", async () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', {
      status: 'baselined',
      baseline: 'BL-20251231',
      body: 'Story body only, no History section.',
    })
    seedRaw(
      repo,
      'cr/CR-003.md',
      '---\nid: CR-003\ntype: cr\nstatus: resolved\nentry_point: requirement\nentry_point_confirmed: true\nimpacts:\n  - amends: E1-FR1\nprovenance: backfilled\n---\n\nIdea.\n'
    )

    const result = await runCli(['validate'], { repo })
    const check = result.json.checks.find((c) => c.name === 'cr-impacts-consistent')
    expect(check?.ok).toBe(true)
  })

  // Task 9b follow-up: rule 1 (the unconditional "realized spawn's traces_to
  // must cite the CR" loop) gets the SAME provenance gate as rule 2's
  // delivered-predicate — a backfilled realized spawn without trace-back is
  // precisely the evidentiary relaxation the migration accepted, and
  // reconcile/validate must agree or the real canon ends up
  // resolved-but-invalid. The id-resolution (existence) check stays hard
  // regardless of provenance.
  it('cr-impacts-consistent passes a resolved backfilled CR whose realized spawn is baselined without trace-back, and fails its non-backfilled twin', async () => {
    const backfilledRepo = makeRepo()
    seedFr(backfilledRepo, 'E1-FR1', 'E1', { status: 'baselined', baseline: 'BL-20251231', tracesTo: [] })
    seedRaw(
      backfilledRepo,
      'cr/CR-004.md',
      '---\nid: CR-004\ntype: cr\nstatus: resolved\nentry_point: requirement\nentry_point_confirmed: true\nimpacts:\n  - spawns: fr\n    epic: E1\n    realized: E1-FR1\nprovenance: backfilled\n---\n\nIdea.\n'
    )
    const backfilledResult = await runCli(['validate'], { repo: backfilledRepo })
    expect(backfilledResult.json.checks.find((c) => c.name === 'cr-impacts-consistent')?.ok).toBe(true)

    // The identical shape WITHOUT provenance: backfilled — rule 1's
    // traces_to requirement (and rule 2's predicate) must still fire.
    const liveRepo = makeRepo()
    seedFr(liveRepo, 'E1-FR1', 'E1', { status: 'baselined', baseline: 'BL-20251231', tracesTo: [] })
    seedRaw(
      liveRepo,
      'cr/CR-004.md',
      '---\nid: CR-004\ntype: cr\nstatus: resolved\nentry_point: requirement\nentry_point_confirmed: true\nimpacts:\n  - spawns: fr\n    epic: E1\n    realized: E1-FR1\n---\n\nIdea.\n'
    )
    const liveResult = await runCli(['validate'], { repo: liveRepo })
    const liveCheck = liveResult.json.checks.find((c) => c.name === 'cr-impacts-consistent')
    expect(liveCheck?.ok).toBe(false)
    expect(liveCheck?.reason).toMatch(/traces_to/)
  })

  // findings #5/#8 mirror: `cr-impacts-consistent` must independently catch a
  // type/epic mismatch on an already-realized spawn — the case
  // `realizeCrSpawn` prevents at write time, but migrate-v3.ts's direct
  // backfill-map write bypasses entirely.
  it("cr-impacts-consistent fails when a realized id's actual node type does not match the impact's declared spawns type", async () => {
    const repo = makeRepo()
    seedFr(repo, 'E1-FR1', 'E1', { status: 'active' })
    seedRaw(
      repo,
      'cr/CR-001.md',
      '---\nid: CR-001\ntype: cr\nstatus: confirmed\nentry_point: requirement\nentry_point_confirmed: true\nimpacts:\n  - spawns: nfr\n    epic: E1\n    realized: E1-FR1\nprovenance: backfilled\n---\n\nIdea.\n'
    )
    const result = await runCli(['validate'], { repo })
    expect(result.code).toBe(1)
    const check = result.json.checks.find((c) => c.name === 'cr-impacts-consistent')
    expect(check?.ok).toBe(false)
    expect(check?.reason).toMatch(/is a 'fr', but the impact declares spawns 'nfr'/)
  })

  it("cr-impacts-consistent fails when a realized id's own epic does not match the impact's declared epic", async () => {
    const repo = makeRepo()
    seedFr(repo, 'E2-FR1', 'E2', { status: 'active' })
    seedRaw(
      repo,
      'cr/CR-002.md',
      '---\nid: CR-002\ntype: cr\nstatus: confirmed\nentry_point: requirement\nentry_point_confirmed: true\nimpacts:\n  - spawns: fr\n    epic: E1\n    realized: E2-FR1\nprovenance: backfilled\n---\n\nIdea.\n'
    )
    const result = await runCli(['validate'], { repo })
    expect(result.code).toBe(1)
    const check = result.json.checks.find((c) => c.name === 'cr-impacts-consistent')
    expect(check?.ok).toBe(false)
    expect(check?.reason).toMatch(/epic \('E2'\) does not match/)
  })

  // finding #1 (validate half): `cr-citations-declared` cross-checks a
  // requirement's traces_to/## History citations back to the CITING CR's own
  // declared impacts — catching a hand-forged citation `editRequirement`'s
  // own write-time guard (writer.ts's `assertConfirmedCr`) would reject.
  describe('cr-citations-declared', () => {
    it('fails when an FR traces_to a requirement-entry CR whose impacts do not declare it', async () => {
      const repo = makeRepo()
      seedFr(repo, 'E1-FR1', 'E1', { status: 'active', tracesTo: ['CR-001'] })
      seedRaw(
        repo,
        'cr/CR-001.md',
        '---\nid: CR-001\ntype: cr\nstatus: confirmed\nentry_point: requirement\nentry_point_confirmed: true\nimpacts:\n  - amends: E1-FR2\n---\n\nIdea.\n'
      )
      const result = await runCli(['validate'], { repo })
      expect(result.code).toBe(1)
      const check = result.json.checks.find((c) => c.name === 'cr-citations-declared')
      expect(check?.ok).toBe(false)
      expect(check?.reason).toMatch(/traces_to CR-001/)
    })

    it('allows a traces_to pointing at a vision-entry (or entry-point-less) CR — the genesis trace', async () => {
      const repo = makeRepo()
      seedFr(repo, 'E1-FR1', 'E1', { status: 'active', tracesTo: ['CR-001'] })
      seedCr(repo, 'CR-001', 'confirmed') // no entry_point at all
      const result = await runCli(['validate'], { repo })
      const check = result.json.checks.find((c) => c.name === 'cr-citations-declared')
      expect(check?.ok).toBe(true)
    })

    it('allows traces_to backed by a spawns+realized impact, not just an amends impact', async () => {
      const repo = makeRepo()
      seedFr(repo, 'E1-FR1', 'E1', { status: 'active', tracesTo: ['CR-001'] })
      seedRaw(
        repo,
        'cr/CR-001.md',
        '---\nid: CR-001\ntype: cr\nstatus: confirmed\nentry_point: requirement\nentry_point_confirmed: true\nimpacts:\n  - spawns: fr\n    epic: E1\n    realized: E1-FR1\n---\n\nIdea.\n'
      )
      const result = await runCli(['validate'], { repo })
      const check = result.json.checks.find((c) => c.name === 'cr-citations-declared')
      expect(check?.ok).toBe(true)
    })

    it('fails when a ## History citation is not backed by an amends impact on the citing CR', async () => {
      const repo = makeRepo()
      seedFr(repo, 'E1-FR1', 'E1', {
        status: 'baselined',
        baseline: 'BL-20260710',
        version: 2,
        body: 'Current text.\n\n## History\n\n### v1 — 20260101 — CR-001\n\nOld text.\n',
      })
      seedRaw(
        repo,
        'cr/CR-001.md',
        '---\nid: CR-001\ntype: cr\nstatus: confirmed\nentry_point: requirement\nentry_point_confirmed: true\nimpacts:\n  - spawns: fr\n    epic: E1\n---\n\nIdea.\n'
      )
      const result = await runCli(['validate'], { repo })
      expect(result.code).toBe(1)
      const check = result.json.checks.find((c) => c.name === 'cr-citations-declared')
      expect(check?.ok).toBe(false)
      expect(check?.reason).toMatch(/## History cites CR-001/)
    })

    it('passes when the ## History citation is backed by a proper amends impact', async () => {
      const repo = makeRepo()
      seedFr(repo, 'E1-FR1', 'E1', {
        status: 'baselined',
        baseline: 'BL-20260710',
        version: 2,
        body: 'Current text.\n\n## History\n\n### v1 — 20260101 — CR-001\n\nOld text.\n',
      })
      seedRaw(
        repo,
        'cr/CR-001.md',
        '---\nid: CR-001\ntype: cr\nstatus: resolved\nentry_point: requirement\nentry_point_confirmed: true\nimpacts:\n  - amends: E1-FR1\n---\n\nIdea.\n'
      )
      const result = await runCli(['validate'], { repo })
      const check = result.json.checks.find((c) => c.name === 'cr-citations-declared')
      expect(check?.ok).toBe(true)
    })
  })

  it('history-anchor-unique fails on an FR page with a duplicate ## heading', async () => {
    const repo = makeRepo()
    seedCr(repo, 'CR-001', 'confirmed')
    seedFr(repo, 'E1-FR1', 'E1', {
      status: 'active',
      tracesTo: ['CR-001'],
      body:
        'Story.\n\n## Acceptance Criteria\n- AC-1: Something.\n\n## History\n\nOld entry.\n\n## History\n\nAnother entry.\n',
    })

    const result = await runCli(['validate'], { repo })
    expect(result.code).toBe(1)
    const check = result.json.checks.find((c) => c.name === 'history-anchor-unique')
    expect(check?.ok).toBe(false)
    expect(check?.reason).toMatch(/history/)
  })

  it('markdown-links-resolve fails when a WP Scope href duplicates a canon/ prefix', async () => {
    const repo = makeRepo({
      product: { epic: 0, cr: 1, wp: 1, bug: 0, baselineSeq: {} },
      epics: { E1: { fr: 1, nfr: 0, br: 0 } },
      retired: [],
    })
    seedVision(repo, 'confirmed')
    seedCr(repo, 'CR-001', 'confirmed')
    seedFr(repo, 'E1-FR1', 'E1', { status: 'active', tracesTo: ['CR-001'] })
    seedRaw(
      repo,
      join('wp', 'WP-20260713-001', 'index.md'),
      wpIndexRaw(
        'WP-20260713-001',
        'draft',
        `- [E1-FR1](../../canon/epics/E1-x/E1-FR1.md)`,
        `- [CR-001](../../cr/CR-001.md)`,
      ),
    )
    const result = await runCli(['validate'], { repo })
    expect(result.code).toBe(1)
    const links = result.json.checks.find((c) => c.name === 'markdown-links-resolve')
    expect(links?.ok).toBe(false)
    expect(links?.reason).toMatch(/broken link/)
  })

  it('markdown-links-resolve passes when every generated Scope href resolves on disk', async () => {
    const repo = makeRepo({
      product: { epic: 0, cr: 1, wp: 1, bug: 0, baselineSeq: {} },
      epics: { E1: { fr: 1, nfr: 0, br: 0 } },
      retired: [],
    })
    seedVision(repo, 'confirmed')
    seedCr(repo, 'CR-001', 'confirmed')
    seedFr(repo, 'E1-FR1', 'E1', { status: 'active', tracesTo: ['CR-001'] })
    seedRaw(
      repo,
      join('wp', 'WP-20260713-001', 'index.md'),
      wpIndexRaw(
        'WP-20260713-001',
        'draft',
        `- [E1-FR1 v1](../../epics/E1-x/E1-FR1.md#acceptance-criteria)`,
        `- [CR-001](../../cr/CR-001.md)`,
      ),
    )
    const result = await runCli(['validate'], { repo })
    const mdLinks = result.json.checks.find((c) => c.name === 'markdown-links-resolve')
    expect(mdLinks?.ok, mdLinks?.reason).toBe(true)
  })

  it('no-duplicate-frontmatter fails when an FR body starts with a second YAML fence', async () => {
    const repo = makeRepo({
      product: { epic: 0, cr: 0, wp: 0, bug: 0, baselineSeq: {} },
      epics: { E1: { fr: 1, nfr: 0, br: 0 } },
      retired: [],
    })
    seedVision(repo, 'confirmed')
    seedRaw(
      repo,
      'epics/E1-x/E1-FR1.md',
      [
        '---',
        'id: E1-FR1',
        'type: fr',
        'epic: E1',
        'status: batched',
        'version: 1',
        'traces_to: [CR-001]',
        'enforces: []',
        'references_nfr: []',
        'related: []',
        '---',
        '',
        '---',
        'id: E1-FR1',
        'type: fr',
        'status: draft',
        '---',
        '',
        'Story.',
        '',
      ].join('\n'),
    )
    seedCr(repo, 'CR-001', 'confirmed')
    const result = await runCli(['validate'], { repo })
    expect(result.code).toBe(1)
    const check = result.json.checks.find((c) => c.name === 'no-duplicate-frontmatter')
    expect(check?.ok).toBe(false)
  })

  it('references-nfr-traceability fails when rationale cites catalogue NFRs omitted from frontmatter', async () => {
    const repo = makeRepo({
      product: { epic: 0, cr: 1, wp: 0, bug: 0, baselineSeq: {} },
      epics: { E1: { fr: 1, nfr: 0, br: 0 } },
      retired: [],
    })
    seedVision(repo, 'confirmed')
    seedCr(repo, 'CR-001', 'confirmed')
    seedFr(repo, 'E1-FR1', 'E1', {
      status: 'active',
      tracesTo: ['CR-001'],
      referencesNfr: [],
      body: '## Rationale\nDepends on PXT-NFR-001.\n\n## Acceptance Criteria\n- AC-1: given a, when b, then c.\n',
    })
    const result = await runCli(['validate'], { repo })
    expect(result.code).toBe(1)
    const check = result.json.checks.find((c) => c.name === 'references-nfr-traceability')
    expect(check?.ok).toBe(false)
    expect(check?.reason).toMatch(/PXT-NFR-001/)
  })
})

// ==========================================================================
// migrate / migrate --verify — the CLI wiring over migrate.ts's library
// functions (Task 13's `migrate`/`verifyParity`, dispatched from cli.ts).
// Reuses the same curated v1 fixture (`test/fixtures/product.snapshot.json`)
// and corpus-explosion approach migrate.test.ts uses (duplicated here in
// miniature — migrate.test.ts exports nothing to import), so this proves
// `praxis-ba migrate` runs the REAL codemod/parity checker end to end through
// `runCli`, not just that the library functions work in isolation.
// ==========================================================================

type V1MigrateSnapshot = {
  product: unknown
  brRegistry: unknown
  crs: Array<{ id: string } & Record<string, unknown>>
  baselines: Array<{ baseline_id: string } & Record<string, unknown>>
  workPackages: Array<
    | { kind: 'json'; filename: string; data: Record<string, unknown> }
    | { kind: 'md'; filename: string; frontmatter: Record<string, unknown>; body: string }
  >
}

function loadV1Snapshot(): V1MigrateSnapshot {
  const raw = readFileSync(join(__dirname, 'fixtures', 'product.snapshot.json'), 'utf8')
  return JSON.parse(raw) as V1MigrateSnapshot
}

function writeV1Json(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

function v1FrontmatterBlock(fm: Record<string, unknown>): string {
  return Object.entries(fm)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n')
}

/** Explodes the curated snapshot into a real v1 directory tree, registered
 * in this file's shared `tempDirs` so the top-level `afterEach` cleans it up
 * like every other fixture here. */
function makeV1Repo(): string {
  const snapshot = loadV1Snapshot()
  const dir = mkdtempSync(join(tmpdir(), 'canon-cli-migrate-v1-'))
  tempDirs.push(dir)
  writeV1Json(join(dir, 'product.json'), snapshot.product)
  writeV1Json(join(dir, 'br-registry.json'), snapshot.brRegistry)
  for (const cr of snapshot.crs) writeV1Json(join(dir, 'cr', `${cr.id}.json`), cr)
  for (const baseline of snapshot.baselines) {
    writeV1Json(join(dir, 'baselines', `${baseline.baseline_id}.json`), baseline)
  }
  for (const wp of snapshot.workPackages) {
    const path = join(dir, 'work-packages', wp.filename)
    mkdirSync(join(dir, 'work-packages'), { recursive: true })
    if (wp.kind === 'json') {
      writeFileSync(path, `${JSON.stringify(wp.data, null, 2)}\n`, 'utf8')
    } else {
      writeFileSync(path, `---\n${v1FrontmatterBlock(wp.frontmatter)}\n---\n\n${wp.body}`, 'utf8')
    }
  }
  return dir
}

describe('migrate', () => {
  it('writes the v2 md canon under --out and reports what it wrote', async () => {
    const v1Dir = makeV1Repo()
    const outDir = scratchDir()

    const result = await runCli(['migrate', '--out', outDir], { repo: v1Dir })

    expect(result.code).toBe(0)
    expect(result.json.verdict).toBe('VERIFY-OK')
    expect(result.json.path).toBe(outDir)
    expect(result.json.checks[0]?.reason).toMatch(/wrote \d+ file/)
    expect(existsSync(join(outDir, 'epics', 'E1-foundation-access', 'E1-FR1.md'))).toBe(true)
    expect(existsSync(join(outDir, 'br', 'E1-BR1.md'))).toBe(true)
    expect(existsSync(join(outDir, 'cr', 'CR-001.md'))).toBe(true)
    expect(existsSync(join(outDir, 'wp', 'WP-20260708-002.md'))).toBe(true)
    expect(existsSync(join(outDir, 'baselines', 'BL-20260708', 'manifest.yaml'))).toBe(true)
    expect(existsSync(join(outDir, '.ba', 'counters.yaml'))).toBe(true)
  })

  it('requires --out', async () => {
    const v1Dir = makeV1Repo()
    const result = await runCli(['migrate'], { repo: v1Dir })
    expect(result.code).toBe(1)
    expect(result.json.verdict).toBe('VERIFY-FAIL')
    expect(result.json.checks[0]?.reason).toMatch(/--out/)
  })

  describe('--verify', () => {
    it('VERIFY-OKs a clean migration; --json prints the Verdict', async () => {
      const v1Dir = makeV1Repo()
      const outDir = scratchDir()
      const migrated = await runCli(['migrate', '--out', outDir], { repo: v1Dir })
      expect(migrated.code).toBe(0)

      const result = await runCli(['migrate', '--verify', '--out', outDir, '--json'], { repo: v1Dir })
      expect(result.code).toBe(0)
      expect(result.json.verdict).toBe('VERIFY-OK')
      expect(result.json.checks.every((c) => c.ok)).toBe(true)
    })

    it('catches a broken --out (a deleted emitted page) as VERIFY-FAIL', async () => {
      const v1Dir = makeV1Repo()
      const outDir = scratchDir()
      await runCli(['migrate', '--out', outDir], { repo: v1Dir })
      rmSync(join(outDir, 'br', 'E1-BR1.md'))

      const result = await runCli(['migrate', '--verify', '--out', outDir], { repo: v1Dir })
      expect(result.code).toBe(1)
      expect(result.json.verdict).toBe('VERIFY-FAIL')
      const brCheck = result.json.checks.find((c) => c.name === 'br-ids')
      expect(brCheck?.ok).toBe(false)
    })
  })
})

// ==========================================================================
// migrate-v3 / migrate-v3 --verify — the CLI wiring over migrate-v3.ts's
// library functions (Task 9's own verb, moved here from Task 8's scope). A
// thin smoke test over flag plumbing (`--backfill`/`--repo-root`/`--verify`)
// — the transform/parity logic itself is exhaustively covered directly
// against the library in migrate-v3.test.ts, not re-proven here.
// ==========================================================================

describe('migrate-v3', () => {
  /** A tiny v2-shaped fixture: a git-initialized `repoRoot` with `canonDir`
   * as its `canon/` subdirectory (mirrors the real `budget-scout`/`product/`
   * relationship `--repo-root`'s own default, `resolve(repo, '..')`, assumes)
   * — one legacy flat WP (`fr_ids`), one legacy CR (`entry_point: solution`). */
  function makeV2Fixture(): { repoRoot: string; canonDir: string } {
    const repoRoot = mkdtempSync(join(tmpdir(), 'canon-cli-migrate-v3-root-'))
    tempDirs.push(repoRoot)
    const canonDir = join(repoRoot, 'canon')
    seedRaw(
      canonDir,
      join('.ba', 'counters.yaml'),
      yamlStringify({ product: { epic: 1, cr: 1, wp: 1, bug: 1, baselineSeq: {} }, epics: { E1: { fr: 1, nfr: 0, br: 0 } }, retired: [] })
    )
    seedRaw(canonDir, join('.ba', 'config.yaml'), yamlStringify({ canon_roots: ['epics/', 'cr/', 'wp/'] }))
    seedRaw(
      canonDir,
      join('epics', 'E1-x', 'E1-FR1.md'),
      ['---', 'id: E1-FR1', 'type: fr', 'epic: E1', 'status: active', 'version: 1', 'traces_to: []', 'enforces: []', 'references_nfr: []', 'related: []', '---', '', 'Story.', ''].join('\n')
    )
    seedRaw(
      canonDir,
      join('cr', 'CR-001.md'),
      ['---', 'id: CR-001', 'type: cr', 'status: confirmed', 'entry_point: solution', 'entry_point_confirmed: true', '---', '', 'Do it.', ''].join('\n')
    )
    seedRaw(
      canonDir,
      join('wp', 'WP-20260701-001.md'),
      ['---', 'id: WP-20260701-001', 'type: wp', 'role: developer', 'status: draft', 'fr_ids:', '  - E1-FR1', '---', '', 'Goal.', ''].join('\n')
    )
    execSync('git init -q', { cwd: repoRoot })
    execSync('git add -A', { cwd: repoRoot })
    return { repoRoot, canonDir }
  }

  it('runs the migration end-to-end via the verb (folder move + entry_point fix), then --verify VERIFY-OKs it', async () => {
    const { repoRoot, canonDir } = makeV2Fixture()
    const backfillPath = scratchFile(JSON.stringify({ 'CR-001': { impacts: [] } }), 'backfill.json')

    const result = await runCli(['migrate-v3', '--backfill', backfillPath, '--repo-root', repoRoot], { repo: canonDir })
    expect(result.code).toBe(0)
    expect(result.json.verdict).toBe('VERIFY-OK')
    expect(result.json.path).toBe(canonDir)
    expect(existsSync(join(canonDir, 'wp', 'WP-20260701-001', 'index.md'))).toBe(true)
    expect(existsSync(join(canonDir, 'wp', 'WP-20260701-001.md'))).toBe(false)
    expect(readFileSync(join(canonDir, 'cr', 'CR-001.md'), 'utf8')).toContain('entry_point: requirement')

    const verify = await runCli(['migrate-v3', '--verify', '--repo-root', repoRoot], { repo: canonDir })
    expect(verify.code).toBe(0)
    expect(verify.json.verdict).toBe('VERIFY-OK')
    expect(verify.json.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining(['same-id-set', 'statuses-preserved', 'versions-untouched', 'rtm-superset', 'plan-content-identical', 'counters-monotonic'])
    )
  })

  it('requires --backfill on a plain run', async () => {
    const { canonDir } = makeV2Fixture()
    const result = await runCli(['migrate-v3'], { repo: canonDir })
    expect(result.code).toBe(1)
    expect(result.json.checks[0]?.reason).toMatch(/--backfill/)
  })

  it('defaults --repo-root to the parent of --repo when not given', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'canon-cli-migrate-v3-default-root-'))
    tempDirs.push(repoRoot)
    const canonDir = join(repoRoot, 'canon')
    seedRaw(canonDir, join('.ba', 'counters.yaml'), yamlStringify(baseCounters()))
    seedRaw(canonDir, join('.ba', 'config.yaml'), yamlStringify({ canon_roots: ['cr/'] }))
    seedRaw(canonDir, join('cr', 'CR-001.md'), '---\nid: CR-001\ntype: cr\nstatus: captured\n---\n\nIdea.\n')
    const backfillPath = scratchFile(JSON.stringify({}), 'backfill.json')

    const result = await runCli(['migrate-v3', '--backfill', backfillPath], { repo: canonDir })
    expect(result.code).toBe(0)
    expect(result.json.verdict).toBe('VERIFY-OK')
  })
})
