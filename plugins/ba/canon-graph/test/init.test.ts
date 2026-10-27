import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import matter from 'gray-matter'
import { afterEach, describe, expect, it } from 'vitest'
import { CANON_FOLDERS, initCanon } from '../src/init'
import { runCli } from '../src/cli'
import { configSchema, countersSchema } from '../src/schema'
import { parse as yamlParse } from 'yaml'

const dirs: string[] = []
function tmp(prefix = 'canon-init-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tree(dir: string, rel = ''): string[] {
  const out: string[] = []
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name
    out.push(e.isDirectory() ? `${r}/` : r)
    if (e.isDirectory()) out.push(...tree(dir, r))
  }
  return out.sort()
}

describe('initCanon', () => {
  it('creates a valid canon in an empty directory', async () => {
    const repo = tmp()
    const r = await initCanon(repo)
    expect(r.dryRun).toBe(false)
    expect(r.skipped).toEqual([])
    expect(r.created).toEqual(
      expect.arrayContaining(['.ba/', '.ba/config.yaml', '.ba/counters.yaml', 'vision.md', ...CANON_FOLDERS.map((f) => `${f}/`)]),
    )
    expect(configSchema.safeParse(yamlParse(readFileSync(join(repo, '.ba/config.yaml'), 'utf8'))).success).toBe(true)
    const counters = countersSchema.parse(yamlParse(readFileSync(join(repo, '.ba/counters.yaml'), 'utf8')))
    expect(counters.product).toEqual({ epic: 0, cr: 0, wp: 0, bug: 0, baselineSeq: {} })
    for (const f of CANON_FOLDERS) expect(lstatSync(join(repo, f)).isDirectory()).toBe(true)
    expect(r.next.join('\n')).toMatch(/ba-scaffold/)
    expect(existsSync(join(repo, 'project.md'))).toBe(false) // the project layer stays separate
  })

  it('writes a draft vision that matches the vision template frontmatter', async () => {
    const repo = tmp()
    await initCanon(repo, { product: 'Acme  Shop' })
    const vision = matter(readFileSync(join(repo, 'vision.md'), 'utf8'))
    const template = matter(readFileSync(new URL('../../templates/vision.md', import.meta.url), 'utf8'))
    expect(vision.data).toEqual(template.data)
    expect(vision.data).toEqual({ type: 'vision', status: 'draft' })
    expect(vision.content).toMatch(/^\s*# Acme Shop/)
  })

  it('is idempotent: a second run creates nothing and changes nothing', async () => {
    const repo = tmp()
    await initCanon(repo, { epic: 'First' })
    const before = tree(repo)
    const content = readFileSync(join(repo, '.ba/counters.yaml'), 'utf8')
    const again = await initCanon(repo, { epic: 'Another' })
    expect(again.created).toEqual([])
    expect(again.notes.join(' ')).toMatch(/already has epics/)
    expect(tree(repo)).toEqual(before)
    expect(readFileSync(join(repo, '.ba/counters.yaml'), 'utf8')).toBe(content)
  })

  it('never overwrites existing files', async () => {
    const repo = tmp()
    writeFileSync(join(repo, 'vision.md'), 'my own vision\n')
    mkdirSync(join(repo, '.ba'))
    writeFileSync(join(repo, '.ba/config.yaml'), 'canon_roots:\n  - vision.md\n')
    const r = await initCanon(repo)
    expect(r.skipped).toEqual(expect.arrayContaining(['vision.md', '.ba/', '.ba/config.yaml']))
    expect(readFileSync(join(repo, 'vision.md'), 'utf8')).toBe('my own vision\n')
    expect(readFileSync(join(repo, '.ba/config.yaml'), 'utf8')).toBe('canon_roots:\n  - vision.md\n')
    expect(existsSync(join(repo, '.ba/counters.yaml'))).toBe(true)
  })

  it('--dry-run lists the plan and writes nothing', async () => {
    const repo = tmp()
    const r = await initCanon(repo, { dryRun: true, epic: 'First epic' })
    expect(r.dryRun).toBe(true)
    expect(r.created).toEqual(expect.arrayContaining(['.ba/config.yaml', 'vision.md', 'epics/E1-first-epic/index.md']))
    expect(r.epic?.id).toBe('E1')
    expect(readdirSync(repo)).toEqual([])
  })

  it('--epic mints the first epic through the epic writer and bumps the ledger', async () => {
    const repo = tmp()
    const r = await initCanon(repo, { epic: 'Checkout flow' })
    expect(r.epic).toEqual({ id: 'E1', path: 'epics/E1-checkout-flow/index.md' })
    expect(r.created).toContain('epics/E1-checkout-flow/index.md')
    expect(r.created.filter((p) => p.endsWith('index.md'))).toHaveLength(1)
    expect(countersSchema.parse(yamlParse(readFileSync(join(repo, '.ba/counters.yaml'), 'utf8'))).product.epic).toBe(1)
    const res = await runCli(['validate', '--check'], { repo })
    expect(res.json.verdict).toBe('VERIFY-OK')
  })

  it('refuses an invalid existing config and writes nothing', async () => {
    const repo = tmp()
    mkdirSync(join(repo, '.ba'))
    writeFileSync(join(repo, '.ba/config.yaml'), 'canon_roots: nope\n')
    await expect(initCanon(repo)).rejects.toThrow(/config.*failed schema validation/)
    expect(tree(repo)).toEqual(['.ba/', '.ba/config.yaml'])
    expect(readFileSync(join(repo, '.ba/config.yaml'), 'utf8')).toBe('canon_roots: nope\n')
  })

  it('refuses an invalid existing counters ledger', async () => {
    const repo = tmp()
    mkdirSync(join(repo, '.ba'))
    writeFileSync(join(repo, '.ba/counters.yaml'), 'product: 1\n')
    await expect(initCanon(repo)).rejects.toThrow(/counters.yaml/)
    expect(tree(repo)).toEqual(['.ba/', '.ba/counters.yaml'])
  })

  it('refuses when the target is a file, missing, or when a needed path has the wrong kind', async () => {
    const root = tmp()
    writeFileSync(join(root, 'afile'), 'x')
    await expect(initCanon(join(root, 'afile'))).rejects.toThrow(/is a file/)
    await expect(initCanon(join(root, 'nope'))).rejects.toThrow(/does not exist/)
    const repo = tmp()
    writeFileSync(join(repo, '.ba'), 'a file where the folder belongs')
    await expect(initCanon(repo)).rejects.toThrow(/\.ba exists but is a file/)
    const repo2 = tmp()
    writeFileSync(join(repo2, 'epics'), 'x')
    await expect(initCanon(repo2)).rejects.toThrow(/epics exists but is a file/)
    expect(tree(repo2)).toEqual(['epics']) // nothing else was written before the refusal
  })

  it('does not write through a symlinked .ba or folder', async () => {
    const outside = tmp('canon-outside-')
    const repo = tmp()
    symlinkSync(outside, join(repo, '.ba'))
    await expect(initCanon(repo)).rejects.toThrow(/symbolic link/)
    expect(readdirSync(outside)).toEqual([])
    const repo2 = tmp()
    symlinkSync(outside, join(repo2, 'cr'))
    await expect(initCanon(repo2)).rejects.toThrow(/symbolic link/)
    expect(readdirSync(outside)).toEqual([])
    expect(tree(repo2)).toEqual(['cr'])
  })

  it('accepts a symlinked repo path and writes only inside its target', async () => {
    const real = tmp()
    const holder = tmp()
    const link = join(holder, 'link')
    symlinkSync(real, link)
    await initCanon(link)
    expect(existsSync(join(real, '.ba/counters.yaml'))).toBe(true)
  })

  it('leaves unrelated files in the directory untouched', async () => {
    const repo = tmp()
    writeFileSync(join(repo, 'README.md'), '# hello\n')
    mkdirSync(join(repo, 'src'))
    writeFileSync(join(repo, 'src/app.ts'), 'export {}\n')
    writeFileSync(join(repo, 'notes.md'), 'not canon\n')
    await initCanon(repo)
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# hello\n')
    expect(readFileSync(join(repo, 'src/app.ts'), 'utf8')).toBe('export {}\n')
    expect(readFileSync(join(repo, 'notes.md'), 'utf8')).toBe('not canon\n')
    const res = await runCli(['validate', '--check'], { repo })
    expect(res.json.verdict).toBe('VERIFY-OK') // unrelated .md is outside canon_roots
  })
})

describe('the canon works after init', () => {
  it('id next, status, validate, epic add and cr allocation all succeed', async () => {
    const repo = tmp()
    const init = await runCli(['init'], { repo })
    expect(init.code).toBe(0)
    expect(init.json.created).toContain('.ba/counters.yaml')
    expect(init.json.dryRun).toBe(false)
    const cr = await runCli(['id', 'next', '--scope', 'cr'], { repo })
    expect(cr.code).toBe(0)
    expect(cr.json.checks[0]?.reason).toBe('CR-001')
    expect((await runCli(['id', 'next', '--scope', 'cr'], { repo })).json.checks[0]?.reason).toBe('CR-002')
    const epic = await runCli(['epic', 'add', '--title', 'Billing'], { repo })
    expect(epic.json.id).toBe('E1')
    expect((await runCli(['id', 'next', '--scope', 'fr:E1'], { repo })).json.checks[0]?.reason).toBe('E1-FR1')
    expect((await runCli(['status'], { repo })).json.verdict).toBe('VERIFY-OK')
    expect((await runCli(['validate', '--check'], { repo })).json.verdict).toBe('VERIFY-OK')
  })

  it('CLI --dry-run writes nothing and reports the plan', async () => {
    const repo = tmp()
    const r = await runCli(['init', '--dry-run'], { repo })
    expect(r.code).toBe(0)
    expect(r.json.dryRun).toBe(true)
    expect(r.json.created).toContain('.ba/config.yaml')
    expect(readdirSync(repo)).toEqual([])
  })

  it('CLI init on an invalid config exits 1 with the reason', async () => {
    const repo = tmp()
    mkdirSync(join(repo, '.ba'))
    writeFileSync(join(repo, '.ba/config.yaml'), '[]')
    const r = await runCli(['init'], { repo })
    expect(r.code).toBe(1)
    expect(r.json.checks[0]?.reason).toMatch(/config/)
  })
})

describe('verbs on a directory without a canon give an actionable error', () => {
  const verbs: string[][] = [
    ['id', 'next', '--scope', 'cr'],
    ['status'],
    ['validate'],
    ['epic', 'add', '--title', 'x'],
    ['bug', 'capture', '--affects', 'E1-FR1', '--severity', 'low', '--body-file', '/dev/null'],
    ['cr', 'confirm', '--cr', 'CR-001', '--entry', 'vision'],
    ['vision', 'confirm'],
  ]
  it.each(verbs)('%s', async (...argv) => {
    const repo = tmp()
    const r = await runCli(argv, { repo })
    expect(r.code).toBe(1)
    const reason = r.json.checks[0]?.reason ?? ''
    expect(reason).toMatch(/^no canon here/)
    expect(reason).toContain(`run praxis-ba init --repo ${repo}`)
    expect(reason).not.toMatch(/ENOENT/)
    expect(readdirSync(repo)).toEqual([]) // the failing verb created nothing (e.g. no .ba/.lock)
  })

  it('read-only verbs still run on a canon made before init existed (vision.md, no .ba)', async () => {
    const repo = tmp()
    writeFileSync(join(repo, 'vision.md'), '# Vision\n')
    const r = await runCli(['status'], { repo })
    expect(r.json.checks[0]?.reason ?? '').not.toMatch(/^no canon here/)
  })

  it('a .ba without a ledger is reported as incomplete, not as ENOENT', async () => {
    const repo = tmp()
    mkdirSync(join(repo, '.ba'))
    const r = await runCli(['id', 'next', '--scope', 'cr'], { repo })
    expect(r.json.checks[0]?.reason).toMatch(/counters\.yaml is missing.*praxis-ba init/)
  })
})
