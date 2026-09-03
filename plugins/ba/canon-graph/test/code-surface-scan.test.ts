import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { scanCodeSurface } from '../src/code-surface-scan.js'

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/code-surface')

describe('scanCodeSurface', () => {
  it('finds every expected operation exactly once with file+line', () => {
    const report = scanCodeSurface({ root: fixture })
    const keys = report.operations.map((o) => `${o.label} -> ${o.file}:${o.line}`).sort()
    expect(keys).toEqual(
      [
        'GET /health -> server/app.js:3',
        'GET /orders/:id -> server/app.js:11',
        'POST /orders -> server/app.js:7',
        'POST /orders/from-history -> server/hidden/history.js:4',
        'onClick addToCart -> web/app.js:6',
        'onClick addFromHistory -> web/app.js:10',
        'onSubmit checkout -> web/app.js:7',
      ].sort(),
    )
    expect(report.operations.filter((o) => o.label === 'GET /health')).toHaveLength(1)
    expect(keys.some((k) => k.includes('/commented-out'))).toBe(false)
  })

  it('warns on a missing anchor', () => {
    const report = scanCodeSurface({
      root: fixture,
      anchors: ['server/app.js', 'does-not-exist.js'],
    })
    expect(report.warnings.some((w) => /does-not-exist/.test(w.message))).toBe(true)
    expect(report.operations.some((o) => o.label === 'GET /health')).toBe(true)
    expect(report.operations.some((o) => o.file.includes('history'))).toBe(false)
  })

  it('incremental scan reports only new/changed fingerprints', () => {
    const dir = mkdtempSync(join(tmpdir(), 'surface-inc-'))
    cpSync(fixture, dir, { recursive: true })
    const statePath = join(dir, '.ba', 'code-surface-state.json')
    const first = scanCodeSurface({ root: dir, statePath, accept: true })
    expect(first.operations.length).toBe(7)
    const again = scanCodeSurface({ root: dir, statePath, incremental: true })
    expect(again.newOrChanged).toEqual([])
    const app = join(dir, 'server/app.js')
    writeFileSync(app, `${readFileSync(app, 'utf8')}\napp.post('/returns', () => {})\n`)
    const delta = scanCodeSurface({ root: dir, statePath, incremental: true })
    expect(delta.newOrChanged.map((o) => o.label)).toEqual(['POST /returns'])
  })

  it('does not re-emit operations already described in existing CR/FR text', () => {
    const report = scanCodeSurface({
      root: fixture,
      incremental: true,
      knownMeanings: ['GET /health is shipped as E1-FR1\nPOST /orders'],
    })
    const labels = report.newOrChanged.map((o) => o.label)
    expect(labels).not.toContain('GET /health')
    expect(labels).not.toContain('POST /orders')
    expect(labels).toContain('POST /orders/from-history')
  })
})
