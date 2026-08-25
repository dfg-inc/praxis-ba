import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { parse as yamlParse, stringify as yamlStringify } from 'yaml'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { allocateId, allocateBaselineId, maxGuard, readCounters, writeCounters, type Counters } from '../src/ids'
import { parsePage, type ParsedPage } from '../src/parse'
import type { Scope } from '../src/types'

// ---- fixture repo helpers — a temp dir per test/run, never the real
// `product/` (per the brief's global constraint on this task). ----

const tempDirs: string[] = []

function baseCounters(): Counters {
  return {
    product: { epic: 0, cr: 0, wp: 0, bug: 0, baselineSeq: {} },
    epics: {},
    retired: [],
  }
}

function makeRepo(counters: Counters = baseCounters()): string {
  const dir = mkdtempSync(join(tmpdir(), 'canon-ids-'))
  mkdirSync(join(dir, '.ba'), { recursive: true })
  writeFileSync(join(dir, '.ba', 'counters.yaml'), yamlStringify(counters), 'utf8')
  tempDirs.push(dir)
  return dir
}

function readRawCounters(repo: string): Counters {
  return yamlParse(readFileSync(join(repo, '.ba', 'counters.yaml'), 'utf8')) as Counters
}

function page(raw: string, type: Parameters<typeof parsePage>[1]): ParsedPage {
  const r = parsePage(raw, type)
  if ('error' in r) throw new Error(`fixture page failed to parse: ${r.error}`)
  return r
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('allocateId — sequential, per-scope', () => {
  it('allocates monotonic ids for {kind:"cr"} from a seeded counter', async () => {
    const repo = makeRepo({ ...baseCounters(), product: { ...baseCounters().product, cr: 16 } })
    const a = await allocateId(repo, { kind: 'cr' })
    const b = await allocateId(repo, { kind: 'cr' })
    expect([a, b]).toEqual(['CR-017', 'CR-018'])
    expect(readRawCounters(repo).product.cr).toBe(18)
  })

  it('allocates per-epic fr ids from a seeded epic counter', async () => {
    const repo = makeRepo({ ...baseCounters(), epics: { E1: { fr: 8, nfr: 0, br: 0 } } })
    const id = await allocateId(repo, { kind: 'fr', epic: 'E1' })
    expect(id).toBe('E1-FR9')
    expect(readRawCounters(repo).epics.E1?.fr).toBe(9)
  })

  it('allocates per-epic nfr and br ids independently of fr', async () => {
    const repo = makeRepo({ ...baseCounters(), epics: { E1: { fr: 8, nfr: 2, br: 0 } } })
    const nfr = await allocateId(repo, { kind: 'nfr', epic: 'E1' })
    const br = await allocateId(repo, { kind: 'br', epic: 'E1' })
    expect(nfr).toBe('E1-NFR3')
    expect(br).toBe('E1-BR1')
  })

  it('allocates fr1 for an epic with no prior counters.epics entry at all', async () => {
    const repo = makeRepo() // counters.epics = {} — E9 was never seeded
    const id = await allocateId(repo, { kind: 'fr', epic: 'E9' })
    expect(id).toBe('E9-FR1')
  })

  it('keeps two different epics independent', async () => {
    const repo = makeRepo({ ...baseCounters(), epics: { E1: { fr: 5, nfr: 0, br: 0 }, E2: { fr: 1, nfr: 0, br: 0 } } })
    const e1 = await allocateId(repo, { kind: 'fr', epic: 'E1' })
    const e2 = await allocateId(repo, { kind: 'fr', epic: 'E2' })
    expect(e1).toBe('E1-FR6')
    expect(e2).toBe('E2-FR2')
  })

  it('allocates a fresh epic id and seeds its fr/nfr/br bucket at zero', async () => {
    const repo = makeRepo({ ...baseCounters(), product: { ...baseCounters().product, epic: 4 } })
    const id = await allocateId(repo, { kind: 'epic' })
    expect(id).toBe('E5')
    expect(readRawCounters(repo).epics.E5).toEqual({ fr: 0, nfr: 0, br: 0 })
  })

  it('allocates bug ids zero-padded to 3 digits', async () => {
    const repo = makeRepo({ ...baseCounters(), product: { ...baseCounters().product, bug: 6 } })
    const id = await allocateId(repo, { kind: 'bug' })
    expect(id).toBe('BUG-007')
  })

  it('allocates a wp id from the passed-in creation date (3rd arg), flat monotonic NNN', async () => {
    const repo = makeRepo({ ...baseCounters(), product: { ...baseCounters().product, wp: 12 } })
    const id = await allocateId(repo, { kind: 'wp' }, '20260713')
    expect(id).toBe('WP-20260713-013')
  })

  it('is a COMPILE error to allocate a wp id without a date (overload type-guard)', () => {
    // Type-level assertion only — never executed. If the wp overload ever
    // stops requiring the 3rd `date` arg, the @ts-expect-error goes unused
    // and `tsc --noEmit` fails, catching the regression at compile time (the
    // guarantee Tasks 10/12/13 rely on).
    const wontCompileWithoutDate = (repo: string): Promise<string> =>
      // @ts-expect-error — { kind: 'wp' } requires a 3rd `date` argument
      allocateId(repo, { kind: 'wp' })
    // A fully-typed Scope variable also can't be passed bare (it might be wp):
    const scopeVarNeedsNarrowing = (repo: string, s: Scope): Promise<string> =>
      // @ts-expect-error — a wide Scope value must be narrowed (wp needs a date)
      allocateId(repo, s)
    expect(typeof wontCompileWithoutDate).toBe('function')
    expect(typeof scopeVarNeedsNarrowing).toBe('function')
  })

  it('still throws at runtime if the date guard is bypassed (defense in depth)', async () => {
    const repo = makeRepo()
    // Reach the implementation signature past the overloads, to prove the
    // runtime `bump` guard is a real second line of defense (not dead code
    // behind the type check).
    const bypass = allocateId as (repo: string, scope: Scope, date?: string) => Promise<string>
    await expect(bypass(repo, { kind: 'wp' })).rejects.toThrow(/date/i)
  })

  it('throws for a wp scope with a malformed date', async () => {
    const repo = makeRepo()
    await expect(allocateId(repo, { kind: 'wp' }, '2026-07-13')).rejects.toThrow(/date/i)
  })
})

describe('allocateBaselineId — first-of-day then -2, -3…', () => {
  it('mints the bare id on the first call for a date, then suffixed', async () => {
    const repo = makeRepo()
    const first = await allocateBaselineId(repo, '20260713')
    const second = await allocateBaselineId(repo, '20260713')
    const third = await allocateBaselineId(repo, '20260713')
    expect([first, second, third]).toEqual(['BL-20260713', 'BL-20260713-2', 'BL-20260713-3'])
  })

  it('keeps two different dates independent', async () => {
    const repo = makeRepo()
    const a = await allocateBaselineId(repo, '20260713')
    const b = await allocateBaselineId(repo, '20260714')
    expect([a, b]).toEqual(['BL-20260713', 'BL-20260714'])
  })

  it('rejects a non-YYYYMMDD date', async () => {
    const repo = makeRepo()
    await expect(allocateBaselineId(repo, '2026-07-13')).rejects.toThrow(/date/i)
  })
})

describe('lockfile — O_EXCL create, mtime-based stale-break', () => {
  it('force-breaks a lock older than 30s and warns to stderr, then proceeds', async () => {
    const repo = makeRepo()
    const lock = join(repo, '.ba', '.lock')
    writeFileSync(lock, '999999') // simulate a lock left behind by a dead process
    const oldTime = new Date(Date.now() - 31_000)
    utimesSync(lock, oldTime, oldTime)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const id = await allocateId(repo, { kind: 'cr' })
    expect(id).toBe('CR-001')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stale lock'))
    warn.mockRestore()
  })

  it('does not touch a fresh (non-stale) lock — caller must wait it out', async () => {
    const repo = makeRepo()
    const lock = join(repo, '.ba', '.lock')
    writeFileSync(lock, String(process.pid)) // fresh lock, not stale
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Release it shortly after so the (short, real-timeout) test doesn't hang
    // for the full 10s acquisition window.
    setTimeout(() => rmSync(lock, { force: true }), 100)
    const id = await allocateId(repo, { kind: 'cr' })
    expect(id).toBe('CR-001')
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  }, 15_000)

  it('gives up and throws after the 10s acquisition timeout (fake timers — no real wait)', async () => {
    vi.useFakeTimers()
    try {
      const repo = makeRepo()
      const lock = join(repo, '.ba', '.lock')
      writeFileSync(lock, String(process.pid)) // fresh lock, held for the whole window, never released
      const pending = allocateId(repo, { kind: 'cr' })
      const assertion = expect(pending).rejects.toThrow(/timed out acquiring lock/i)
      await vi.advanceTimersByTimeAsync(11_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('rethrows immediately (no retry) on a non-EEXIST open failure', async () => {
    // `.ba` deliberately absent → openSync('wx') fails ENOENT, not EEXIST —
    // acquireLock must propagate it rather than retrying/timing out.
    const dir = mkdtempSync(join(tmpdir(), 'canon-ids-no-ba-'))
    tempDirs.push(dir)
    await expect(allocateId(dir, { kind: 'cr' })).rejects.toThrow()
  })

  it('does NOT break a lock that is stale by mtime but whose owner is still alive (liveness gate)', async () => {
    const repo = makeRepo()
    const lock = join(repo, '.ba', '.lock')
    writeFileSync(lock, String(process.pid)) // owner = THIS process → provably alive
    const oldTime = new Date(Date.now() - 31_000) // old enough to be "stale" by the mtime rule
    utimesSync(lock, oldTime, oldTime)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    vi.useFakeTimers()
    try {
      const pending = allocateId(repo, { kind: 'cr' })
      const assertion = expect(pending).rejects.toThrow(/timed out acquiring lock/i)
      await vi.advanceTimersByTimeAsync(11_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
    // The lock was old, but its owner is alive → must never have been broken.
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('breaks a stale lock with a garbage (non-numeric) pid payload', async () => {
    const repo = makeRepo()
    const lock = join(repo, '.ba', '.lock')
    writeFileSync(lock, 'not-a-pid') // corrupt body → owner unknowable → treat as breakable
    const oldTime = new Date(Date.now() - 31_000)
    utimesSync(lock, oldTime, oldTime)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const id = await allocateId(repo, { kind: 'cr' })
    expect(id).toBe('CR-001')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stale lock'))
    warn.mockRestore()
  })

  it('stays consistent when many allocations race on a pre-existing STALE lock (no double-hold)', async () => {
    // The HIGH-fix regression guard: seed an already-stale, dead-owner lock,
    // then fire N concurrent allocations. If the atomic break ever let two
    // waiters both "hold" the lock, two of them would read the same counter
    // and mint a DUPLICATE id (or the ledger would end below N). Asserting N
    // distinct, contiguous ids + a ledger of exactly N is the no-double-hold
    // + no-corruption invariant.
    const repo = makeRepo()
    const lock = join(repo, '.ba', '.lock')
    writeFileSync(lock, '999999') // dead owner
    const oldTime = new Date(Date.now() - 31_000)
    utimesSync(lock, oldTime, oldTime)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const n = 8
    const ids = await Promise.all(Array.from({ length: n }, () => allocateId(repo, { kind: 'cr' })))
    expect(new Set(ids).size).toBe(n) // no duplicate id → no double-hold
    const nums = ids.map((id) => Number(id.slice('CR-'.length))).sort((a, b) => a - b)
    expect(nums).toEqual(Array.from({ length: n }, (_, i) => i + 1)) // contiguous 1..n
    expect(readRawCounters(repo).product.cr).toBe(n) // ledger consistent
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stale lock')) // the stale lock WAS broken
    warn.mockRestore()
  }, 15_000)
})

describe('allocateId — concurrency property (fast-check)', () => {
  it('N "concurrent" allocations (Promise.all wrapping the locked call) yield N distinct, monotonic ids', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 15 }), async (n) => {
        const repo = makeRepo()
        try {
          const ids = await Promise.all(Array.from({ length: n }, () => allocateId(repo, { kind: 'cr' })))
          expect(new Set(ids).size).toBe(n) // no duplicates
          const nums = ids.map((id) => Number(id.slice('CR-'.length))).sort((a, b) => a - b)
          expect(nums).toEqual(Array.from({ length: n }, (_, i) => i + 1)) // contiguous 1..n, no gaps
          expect(readRawCounters(repo).product.cr).toBe(n)
        } finally {
          rmSync(repo, { recursive: true, force: true })
        }
      }),
      { numRuns: 20 }
    )
  })
})

describe('maxGuard — validate-time corpus max-guard', () => {
  it('ok:true when the ledger is at/above every id seen in the corpus', () => {
    const repo = makeRepo({ ...baseCounters(), product: { ...baseCounters().product, cr: 17 } })
    const pages = [page('---\nid: CR-017\ntype: cr\nstatus: captured\n---\n\nbody', 'cr')]
    const result = maxGuard(repo, pages, [])
    expect(result).toEqual({ ok: true, violations: [] })
  })

  it('flags a ledger rewound below a live id in the corpus', () => {
    const repo = makeRepo({ ...baseCounters(), product: { ...baseCounters().product, cr: 5 } })
    const pages = [page('---\nid: CR-017\ntype: cr\nstatus: captured\n---\n\nbody', 'cr')]
    const result = maxGuard(repo, pages, [])
    expect(result.ok).toBe(false)
    expect(result.violations).toEqual(['product.cr: ledger=5 but corpus has CR-017 (17)'])
  })

  it('flags a rewound wp flat-monotonic counter (date in the id is informational only)', () => {
    const repo = makeRepo({ ...baseCounters(), product: { ...baseCounters().product, wp: 2 } })
    const pages = [
      page('---\nid: WP-20260101-007\ntype: wp\nrole: developer\nstatus: draft\n---\n\nbody', 'wp'),
    ]
    const result = maxGuard(repo, pages, [])
    expect(result.ok).toBe(false)
    expect(result.violations).toEqual(['product.wp: ledger=2 but corpus has WP-20260101-007 (7)'])
  })

  it('flags a rewound per-epic fr counter', () => {
    const repo = makeRepo({ ...baseCounters(), epics: { E1: { fr: 2, nfr: 0, br: 0 } } })
    const pages = [
      page(
        '---\nid: E1-FR9\ntype: fr\nepic: E1\nstatus: active\nversion: 1\ntraces_to: []\nenforces: []\nreferences_nfr: []\nrelated: []\n---\n\nbody',
        'fr'
      ),
    ]
    const result = maxGuard(repo, pages, [])
    expect(result.ok).toBe(false)
    expect(result.violations).toEqual(['epics.E1.fr: ledger=2 but corpus has E1-FR9 (9)'])
  })

  it('scans baseline snapshots too (both the manifest id and its item ids)', () => {
    const repo = makeRepo({ ...baseCounters(), product: { ...baseCounters().product, baselineSeq: { '20260711': 1 } } })
    const baselines = [
      {
        id: 'BL-20260711-2',
        date: '20260711',
        wp_ids: [],
        triggered_by: 'WP-20260711-001',
        items: [{ id: 'E1-BR3', version: 1, content_hash: 'x' }],
        accepted_by: 'owner',
        verify_evidence_ref: 'ref',
      },
    ]
    const result = maxGuard(repo, [], baselines)
    expect(result.ok).toBe(false)
    expect(result.violations).toEqual(
      ['baselineSeq.20260711: ledger=1 but corpus has BL-20260711-2 (2)', 'epics.E1.br: ledger=0 but corpus has E1-BR3 (3)'].sort()
    )
  })

  it('scans retired ids from the ledger itself', () => {
    const repo = makeRepo({ ...baseCounters(), epics: { E1: { fr: 0, nfr: 0, br: 0 } }, retired: ['E1-FR4'] })
    const result = maxGuard(repo, [], [])
    expect(result.ok).toBe(false)
    expect(result.violations).toEqual(['epics.E1.fr: ledger=0 but corpus has E1-FR4 (4)'])
  })

  it('ignores a vision page (no id) and non-tracked id shapes', () => {
    const repo = makeRepo()
    const pages = [page('---\ntype: vision\nstatus: draft\n---\n\nbody', 'vision')]
    const result = maxGuard(repo, pages, [])
    expect(result).toEqual({ ok: true, violations: [] })
  })

  it('ignores a page whose frontmatter carries a non-string id', () => {
    const repo = makeRepo()
    const pages = [{ frontmatter: { id: 123, type: 'cr' }, body: '', acs: [] }]
    const result = maxGuard(repo, pages, [])
    expect(result).toEqual({ ok: true, violations: [] })
  })

  it('classifies epic/nfr/bug ids and a bare (unsuffixed) baseline id', () => {
    const repo = makeRepo({
      ...baseCounters(),
      product: { ...baseCounters().product, epic: 0, bug: 0, baselineSeq: { '20260711': 0 } },
      epics: { E3: { fr: 0, nfr: 0, br: 0 } },
    })
    const pages = [
      page('---\nid: E5\ntype: epic\ntitle: Later epic\nstatus: active\n---\n\nbody', 'epic'),
      page(
        '---\nid: E3-NFR2\ntype: nfr\nepic: E3\nstatus: active\nversion: 1\ntraces_to: []\nverified_by: []\nrelated: []\n---\n\nbody',
        'nfr'
      ),
      page(
        '---\nid: BUG-004\ntype: bug\nstatus: open\nseverity: high\naffects: []\nreported: 2026-07-13\nreporter: alex\n---\n\nbody',
        'bug'
      ),
    ]
    const baselines = [
      {
        id: 'BL-20260711', // no suffix — first-of-day shape
        date: '20260711',
        wp_ids: [],
        triggered_by: 'WP-20260711-001',
        items: [],
        accepted_by: 'owner',
        verify_evidence_ref: 'ref',
      },
    ]
    const result = maxGuard(repo, pages, baselines)
    expect(result.ok).toBe(false)
    expect(result.violations).toEqual(
      [
        'product.epic: ledger=0 but corpus has E5 (5)',
        'epics.E3.nfr: ledger=0 but corpus has E3-NFR2 (2)',
        'product.bug: ledger=0 but corpus has BUG-004 (4)',
        'baselineSeq.20260711: ledger=0 but corpus has BL-20260711 (1)',
      ].sort()
    )
  })

  it('keeps the true max when a smaller id for the same key is seen after a larger one', () => {
    const repo = makeRepo({ ...baseCounters(), product: { ...baseCounters().product, cr: 10 } })
    const pages = [
      page('---\nid: CR-017\ntype: cr\nstatus: captured\n---\n\nbody', 'cr'),
      page('---\nid: CR-003\ntype: cr\nstatus: captured\n---\n\nbody', 'cr'),
    ]
    // The later, SMALLER id (CR-003) must not clobber the already-recorded
    // max (CR-017) — the violation must still name CR-017 (17), not CR-003.
    const result = maxGuard(repo, pages, [])
    expect(result.ok).toBe(false)
    expect(result.violations).toEqual(['product.cr: ledger=10 but corpus has CR-017 (17)'])
  })
})

describe('readCounters / writeCounters — the seam migrate (Task 13) seeds through', () => {
  it('round-trips a counters value atomically', () => {
    const repo = makeRepo()
    const seeded: Counters = { product: { epic: 3, cr: 9, wp: 1, bug: 0, baselineSeq: { '20260701': 1 } }, epics: {}, retired: [] }
    writeCounters(repo, seeded)
    expect(readCounters(repo)).toEqual(seeded)
  })

  it('throws on a corrupt ledger rather than silently coercing', () => {
    const repo = makeRepo()
    writeFileSync(join(repo, '.ba', 'counters.yaml'), 'product: { epic: "not-a-number" }', 'utf8')
    expect(() => readCounters(repo)).toThrow()
  })
})
