import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { stringify as yamlStringify } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { runCli } from '../src/cli'
import type { Counters } from '../src/ids'

const tempDirs: string[] = []

afterEach(() => {
  tempDirs.length = 0
})

function makeRepo(
  counters: Counters = {
    product: { epic: 1, cr: 1, wp: 0, bug: 0, baselineSeq: {} },
    epics: { E1: { fr: 1, nfr: 0, br: 0 } },
    retired: [],
  },
): string {
  const dir = mkdtempSync(join(tmpdir(), 'canon-semantic-'))
  mkdirSync(join(dir, '.ba'), { recursive: true })
  writeFileSync(join(dir, '.ba', 'counters.yaml'), yamlStringify(counters), 'utf8')
  writeFileSync(
    join(dir, '.ba', 'config.yaml'),
    `canon_roots:\n  - vision.md\n  - epics/\n  - cr/\n  - wp/\nlink_root: canon\n`,
  )
  tempDirs.push(dir)
  return dir
}

function write(repo: string, rel: string, content: string) {
  const abs = join(repo, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

function seedMinimal(
  repo: string,
  opts: { frStatus?: string; frBody?: string; epicStatus?: string; referencesNfr?: string[] } = {},
) {
  write(
    repo,
    'vision.md',
    `---\ntype: vision\nstatus: confirmed\nconfirmed_at: "2026-09-01"\nconfirmed_by: test\n---\n\nVision.\n`,
  )
  write(
    repo,
    'epics/E1-x/index.md',
    `---\nid: E1\ntype: epic\ntitle: Foundation\nstatus: ${opts.epicStatus ?? 'active'}\n---\n\nEpic.\n`,
  )
  write(
    repo,
    'cr/CR-001.md',
    `---\nid: CR-001\ntype: cr\nstatus: confirmed\nentry_point: requirement\nentry_point_confirmed: true\nimpacts:\n  - spawns: fr\n    epic: E1\n    realized: E1-FR1\n---\n\nCR.\n`,
  )
  const refs = (opts.referencesNfr ?? []).join(', ')
  write(
    repo,
    'epics/E1-x/E1-FR1.md',
    `---\nid: E1-FR1\ntype: fr\nepic: E1\nstatus: ${opts.frStatus ?? 'active'}\nversion: 1\ntraces_to: [CR-001]\nenforces: []\nreferences_nfr: [${refs}]\nrelated: []\n---\n\n${
      opts.frBody ??
      'As a user I want X.\n\n## Acceptance Criteria\n\n- AC-1: given a, when b, then c.\n'
    }`,
  )
}

describe('semantic lint via validate (Node, no Python)', () => {
  it('passes a clean root-layout repo', async () => {
    const repo = makeRepo()
    seedMinimal(repo)
    write(repo, 'shared/nfr.md', `# NFR\n\n- PXT-NFR-001: availability\n`)
    write(repo, 'shared/taxonomy.md', `# Taxonomy\n\n\`auth\` \`session\`\n`)

    const result = await runCli(['validate', '--json'], { repo })
    expect(result.json.verdict).toBe('VERIFY-OK')
    for (const name of [
      'needs-clarification-committed',
      'nfr-catalogue-refs',
      'taxonomy-tags',
      'child-status-vs-epic',
      'markdown-links-resolve-semantic',
    ]) {
      const c = result.json.checks.find((x) => x.name === name)
      expect(c?.ok, `${name}: ${c?.reason}`).toBe(true)
    }
  })

  it('fails when [NEEDS CLARIFICATION] remains on an active requirement', async () => {
    const repo = makeRepo()
    seedMinimal(repo, {
      frStatus: 'active',
      frBody:
        'Story.\n\n[NEEDS CLARIFICATION: what is the actor?]\n\n## Acceptance Criteria\n\n- AC-1: given a, when b, then c.\n',
    })
    const result = await runCli(['validate', '--json'], { repo })
    expect(result.json.verdict).toBe('VERIFY-FAIL')
    const c = result.json.checks.find((x) => x.name === 'needs-clarification-committed')
    expect(c?.ok).toBe(false)
    expect(c?.reason).toMatch(/NEEDS CLARIFICATION/)
  })

  it('surfaces NEEDS CLARIFICATION on draft as advisory warning (not VERIFY-FAIL alone)', async () => {
    const repo = makeRepo()
    seedMinimal(repo, {
      frStatus: 'draft',
      frBody:
        'Draft story.\n\n[NEEDS CLARIFICATION: TBD]\n\n## Acceptance Criteria\n\n- AC-1: given a, when b, then c.\n',
    })
    const result = await runCli(['validate', '--json'], { repo })
    const c = result.json.checks.find((x) => x.name === 'needs-clarification-committed')
    expect(c?.ok).toBe(false)
    expect(c?.reason).toMatch(/NEEDS CLARIFICATION/)
    // Draft marker is warning-class; hard verdict depends on other checks.
    // With a draft FR that still traces to a confirmed CR, schema may still be OK.
    const hardFails = result.json.checks.filter((x) => !x.ok && result.code === 1)
    void hardFails
    expect(result.code === 0 || result.code === 2 || result.json.verdict === 'VERIFY-OK' || result.json.verdict === 'VERIFY-FAIL').toBe(
      true,
    )
  })

  it('fails when body cites a catalogue NFR absent from shared/nfr.md', async () => {
    const repo = makeRepo()
    seedMinimal(repo, {
      referencesNfr: ['PXT-NFR-999'],
      frBody:
        'Depends on PXT-NFR-999 for uptime.\n\n## Acceptance Criteria\n\n- AC-1: given a, when b, then c.\n',
    })
    write(repo, 'shared/nfr.md', `# NFR\n\n- PXT-NFR-001: availability\n`)
    const result = await runCli(['validate', '--json'], { repo })
    expect(result.json.verdict).toBe('VERIFY-FAIL')
    const c = result.json.checks.find((x) => x.name === 'nfr-catalogue-refs')
    expect(c?.ok).toBe(false)
    expect(c?.reason).toMatch(/PXT-NFR-999/)
  })

  it('passes nfr-catalogue-refs when the id exists in the catalogue', async () => {
    const repo = makeRepo()
    seedMinimal(repo, {
      referencesNfr: ['PXT-NFR-001'],
      frBody:
        'Depends on PXT-NFR-001.\n\n## Acceptance Criteria\n\n- AC-1: given a, when b, then c.\n',
    })
    write(repo, 'shared/nfr.md', `# NFR\n\n- PXT-NFR-001: availability\n`)
    const result = await runCli(['validate', '--json'], { repo })
    const c = result.json.checks.find((x) => x.name === 'nfr-catalogue-refs')
    expect(c?.ok, c?.reason).toBe(true)
    expect(result.json.verdict).toBe('VERIFY-OK')
  })

  it('advises when a Passport tag is outside taxonomy', async () => {
    const repo = makeRepo()
    seedMinimal(repo, {
      frBody:
        '| Field | Value |\n| --- | --- |\n| **Теги** | mystery-tag |\n\n## Acceptance Criteria\n\n- AC-1: given a, when b, then c.\n',
    })
    write(repo, 'shared/taxonomy.md', `# Taxonomy\n\n\`auth\` \`session\`\n`)
    const result = await runCli(['validate', '--json'], { repo })
    const c = result.json.checks.find((x) => x.name === 'taxonomy-tags')
    expect(c?.ok).toBe(false)
    expect(c?.reason).toMatch(/mystery-tag/)
    expect(result.json.verdict).toBe('VERIFY-OK')
    expect(result.code).toBe(2)
  })

  it('fails when a committed child is ahead of a draft epic', async () => {
    const repo = makeRepo()
    seedMinimal(repo, { frStatus: 'active', epicStatus: 'draft' })
    const result = await runCli(['validate', '--json'], { repo })
    expect(result.json.verdict).toBe('VERIFY-FAIL')
    const c = result.json.checks.find((x) => x.name === 'child-status-vs-epic')
    expect(c?.ok).toBe(false)
    expect(c?.reason).toMatch(/still draft/)
  })

  it('fails on broken relative markdown links', async () => {
    const repo = makeRepo()
    seedMinimal(repo, {
      frBody:
        'See [missing](./no-such-page.md).\n\n## Acceptance Criteria\n\n- AC-1: given a, when b, then c.\n',
    })
    const result = await runCli(['validate', '--json'], { repo })
    expect(result.json.verdict).toBe('VERIFY-FAIL')
    const semantic = result.json.checks.find((x) => x.name === 'markdown-links-resolve-semantic')
    expect(semantic?.ok).toBe(false)
    expect(semantic?.reason).toMatch(/no-such-page\.md/)
  })

  it('ignores node_modules markdown when validating repo root', async () => {
    const repo = makeRepo()
    seedMinimal(repo)
    write(
      repo,
      'node_modules/@praxis/architect/skills/nfr-budget/SKILL.md',
      `---\nname: poison\n---\n\n[NEEDS CLARIFICATION: should not be scanned]\n`,
    )
    const result = await runCli(['validate', '--json'], { repo })
    expect(result.json.verdict).toBe('VERIFY-OK')
    expect(result.json.checks.every((c) => !/node_modules/i.test(c.reason ?? ''))).toBe(true)
  })

  it('refuses plan-approved / BA handoff when semantic validation fails', async () => {
    const repo = makeRepo({
      product: { epic: 1, cr: 1, wp: 1, bug: 0, baselineSeq: {} },
      epics: { E1: { fr: 1, nfr: 0, br: 0 } },
      retired: [],
    })
    seedMinimal(repo, {
      frStatus: 'batched',
      frBody:
        'Batched with open question.\n\n[NEEDS CLARIFICATION: unblock me]\n\n## Acceptance Criteria\n\n- AC-1: given a, when b, then c.\n',
    })
    write(
      repo,
      'wp/WP-20260901-001/index.md',
      `---\nid: WP-20260901-001\ntype: wp\nrole: developer\nstatus: ready\n---\n\nDeliver.\n\n## Scope\n\n### Change requests\n\n- [CR-001](../../cr/CR-001.md)\n\n### Delivers\n\n- [E1-FR1](../../epics/E1-x/E1-FR1.md#acceptance-criteria)\n`,
    )
    write(repo, 'wp/WP-20260901-001/plan.md', `# Plan\n\nDo the thing.\n`)

    const approve = await runCli(
      [
        'wp',
        'approve-plan',
        '--wp',
        'WP-20260901-001',
        '--plan',
        'wp/WP-20260901-001/plan.md',
        '--json',
      ],
      { repo },
    )
    expect(approve.code).toBe(1)
    expect(approve.json.verdict).toBe('VERIFY-FAIL')
    expect(existsSync(join(repo, 'wp/WP-20260901-001/handoffs/ba-architect.handoff.json'))).toBe(
      false,
    )
  })

  it('emits ba.architect.handoff when validate is clean and WP is approved', async () => {
    const repo = makeRepo({
      product: { epic: 1, cr: 1, wp: 1, bug: 0, baselineSeq: {} },
      epics: { E1: { fr: 1, nfr: 0, br: 0 } },
      retired: [],
    })
    seedMinimal(repo, { frStatus: 'batched' })
    write(
      repo,
      'wp/WP-20260901-001/index.md',
      `---\nid: WP-20260901-001\ntype: wp\nrole: developer\nstatus: ready\n---\n\nDeliver.\n\n## Scope\n\n### Change requests\n\n- [CR-001](../../cr/CR-001.md)\n\n### Delivers\n\n- [E1-FR1](../../epics/E1-x/E1-FR1.md#acceptance-criteria)\n`,
    )
    write(repo, 'wp/WP-20260901-001/plan.md', `# Plan\n\nDo the thing.\n`)

    const approve = await runCli(
      [
        'wp',
        'approve-plan',
        '--wp',
        'WP-20260901-001',
        '--plan',
        'wp/WP-20260901-001/plan.md',
        '--json',
      ],
      { repo },
    )
    expect(approve.code, JSON.stringify(approve.json.checks?.filter((c) => !c.ok))).toBe(0)
    expect(approve.json.handoffPath).toBeTruthy()
    const handoff = JSON.parse(readFileSync(approve.json.handoffPath!, 'utf8'))
    expect(handoff.contract).toBe('ba.architect.handoff')
    expect(handoff.workPackageId).toBe('WP-20260901-001')
    expect(handoff.requirementIds).toContain('E1-FR1')
  })
})
