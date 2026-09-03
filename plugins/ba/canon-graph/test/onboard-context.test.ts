import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkOnboardContext, initOnboardContext } from '../src/onboard-context.js'

const templates = join(dirname(fileURLToPath(import.meta.url)), '../../templates/layer')

describe('onboard-context', () => {
  it('init writes the expected layer and never overwrites', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onboard-ctx-'))
    const first = initOnboardContext({ projectRoot: dir, templatesDir: templates })
    expect(first.created.sort()).toEqual([
      'as-is.md',
      'glossary.md',
      'project.md',
      'shared/data-model.md',
      'shared/integrations.md',
      'shared/nfr.md',
      'shared/rbac.md',
    ])
    const check = checkOnboardContext(dir)
    expect(check.missing).toEqual([])
    expect(check.headingGaps).toEqual([])
    writeFileSync(join(dir, 'project.md'), '# custom project\n')
    const second = initOnboardContext({ projectRoot: dir, templatesDir: templates })
    expect(second.created).toEqual([])
    expect(second.skipped).toContain('project.md')
    expect(readFileSync(join(dir, 'project.md'), 'utf8')).toBe('# custom project\n')
  })

  it('does not invent business intent — templates keep [NEEDS CLARIFICATION] or placeholders', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onboard-nci-'))
    initOnboardContext({ projectRoot: dir, templatesDir: templates })
    const asIs = readFileSync(join(dir, 'as-is.md'), 'utf8')
    expect(asIs).toMatch(/NEEDS CLARIFICATION|\[❓\]/)
    expect(existsSync(join(dir, 'canon'))).toBe(false)
  })
})
