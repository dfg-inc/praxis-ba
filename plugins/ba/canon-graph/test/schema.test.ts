import { describe, it, expect } from 'vitest'
import {
  schemas,
  countersSchema,
  baselineManifestSchema,
  verifyEvidenceSchema,
  validateFrontmatter,
  crSchema,
  crImpactSchema,
  configSchema,
} from '../src/schema'

describe('schema — requirement types (unified Status enum)', () => {
  it('accepts a valid FR frontmatter', () => {
    const r = validateFrontmatter('fr', {
      id: 'E1-FR8',
      type: 'fr',
      epic: 'E1',
      status: 'draft',
      version: 1,
      traces_to: ['CR-001'],
      enforces: [],
      references_nfr: [],
      related: [],
    })
    expect(r.ok).toBe(true)
  })

  it('rejects an unknown status', () => {
    const r = validateFrontmatter('fr', {
      id: 'E1-FR8',
      type: 'fr',
      epic: 'E1',
      status: 'nope',
      version: 1,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.length).toBeGreaterThan(0)
  })

  it('rejects a malformed FR id', () => {
    const r = validateFrontmatter('fr', {
      id: 'FR8',
      type: 'fr',
      epic: 'E1',
      status: 'draft',
      version: 1,
      traces_to: [],
      enforces: [],
      references_nfr: [],
      related: [],
    })
    expect(r.ok).toBe(false)
  })

  it('accepts a valid NFR frontmatter', () => {
    const r = validateFrontmatter('nfr', {
      id: 'E1-NFR3',
      type: 'nfr',
      epic: 'E1',
      status: 'active',
      version: 2,
      traces_to: ['CR-002'],
      verified_by: [],
      related: [],
    })
    expect(r.ok).toBe(true)
  })

  it('accepts a valid BR frontmatter (unified status enum, active)', () => {
    const r = validateFrontmatter('br', {
      id: 'E1-BR2',
      type: 'br',
      epic: 'E1',
      kind: 'structural',
      enforcement: 'hard',
      status: 'active',
      version: 1,
    })
    expect(r.ok).toBe(true)
  })

  it('rejects a BR with an unknown kind', () => {
    const r = validateFrontmatter('br', {
      id: 'E1-BR2',
      type: 'br',
      epic: 'E1',
      kind: 'weird',
      enforcement: 'hard',
      status: 'active',
      version: 1,
    })
    expect(r.ok).toBe(false)
  })

  it('accepts baselined FR/NFR/BR with baseline + provenance set (and preserves baseline in data)', () => {
    const fr = validateFrontmatter('fr', {
      id: 'E1-FR8',
      type: 'fr',
      epic: 'E1',
      status: 'baselined',
      version: 3,
      traces_to: ['CR-001'],
      enforces: ['E1-BR2'],
      references_nfr: ['E1-NFR3'],
      related: [],
      baseline: 'BL-20260713',
      provenance: 'migrated',
    })
    expect(fr.ok).toBe(true)
    if (fr.ok) expect((fr.data as { baseline?: string }).baseline).toBe('BL-20260713')

    const nfr = validateFrontmatter('nfr', {
      id: 'E1-NFR3',
      type: 'nfr',
      epic: 'E1',
      status: 'baselined',
      version: 2,
      traces_to: ['CR-002'],
      verified_by: [],
      related: [],
      baseline: 'BL-20260713',
      provenance: 'migrated',
    })
    expect(nfr.ok).toBe(true)
    if (nfr.ok) expect((nfr.data as { baseline?: string }).baseline).toBe('BL-20260713')

    const br = validateFrontmatter('br', {
      id: 'E1-BR2',
      type: 'br',
      epic: 'E1',
      kind: 'structural',
      enforcement: 'hard',
      status: 'baselined',
      version: 1,
      baseline: 'BL-20260713',
      provenance: 'migrated',
    })
    expect(br.ok).toBe(true)
    if (br.ok) expect((br.data as { baseline?: string }).baseline).toBe('BL-20260713')
  })

  it('accepts a BR carrying supersedes/superseded_by', () => {
    const br = validateFrontmatter('br', {
      id: 'E1-BR2',
      type: 'br',
      epic: 'E1',
      kind: 'operative',
      enforcement: 'advisory',
      status: 'superseded',
      version: 1,
      superseded_by: 'E1-BR5',
    })
    expect(br.ok).toBe(true)
  })
})

describe('schema — vision/cr/wp/bug/epic', () => {
  it('accepts a draft vision (no confirmed_at/by yet)', () => {
    const r = validateFrontmatter('vision', { type: 'vision', status: 'draft' })
    expect(r.ok).toBe(true)
  })

  it('accepts a confirmed vision with confirmed_at/by', () => {
    const r = validateFrontmatter('vision', {
      type: 'vision',
      status: 'confirmed',
      confirmed_at: '2026-07-13',
      confirmed_by: 'alex',
    })
    expect(r.ok).toBe(true)
  })

  it('rejects a vision with an unknown status', () => {
    const r = validateFrontmatter('vision', { type: 'vision', status: 'nope' })
    expect(r.ok).toBe(false)
  })

  it('accepts a captured CR', () => {
    const r = validateFrontmatter('cr', { id: 'CR-001', type: 'cr', status: 'captured' })
    expect(r.ok).toBe(true)
  })

  it('accepts a confirmed CR with entry_point fields', () => {
    const r = validateFrontmatter('cr', {
      id: 'CR-001',
      type: 'cr',
      status: 'confirmed',
      entry_point: 'requirement',
      entry_point_confirmed: true,
    })
    expect(r.ok).toBe(true)
  })

  it('rejects a malformed CR id', () => {
    const r = validateFrontmatter('cr', { id: 'CR-1', type: 'cr', status: 'captured' })
    expect(r.ok).toBe(false)
  })

  it('accepts a valid (v3 slim) WP frontmatter', () => {
    const r = validateFrontmatter('wp', {
      id: 'WP-20260713-001',
      type: 'wp',
      role: 'developer',
      status: 'draft',
    })
    expect(r.ok).toBe(true)
  })

  it('accepts a WP with a plan path', () => {
    const r = validateFrontmatter('wp', {
      id: 'WP-20260713-001',
      type: 'wp',
      role: 'qa',
      status: 'plan-approved',
      plan: 'thoughts/shared/plans/2026-07-13-foo.md',
    })
    expect(r.ok).toBe(true)
  })

  it('rejects a legacy v2 WP page\'s fr_ids/extra_brs/extra_nfrs (v3: wpSchema is .strict() once `wp author` — the one verb that still emitted them — is retired; migrate-v3, Task 9, is the real transform path for an actual legacy page)', () => {
    const r = validateFrontmatter('wp', {
      id: 'WP-20260713-001',
      type: 'wp',
      role: 'developer',
      status: 'draft',
      fr_ids: ['E1-FR8'],
      extra_brs: ['E1-BR2'],
      extra_nfrs: ['E1-NFR3'],
    })
    expect(r.ok).toBe(false)
  })

  it('rejects a malformed WP id', () => {
    const r = validateFrontmatter('wp', {
      id: 'WP-2026-001',
      type: 'wp',
      role: 'developer',
      status: 'draft',
    })
    expect(r.ok).toBe(false)
  })

  it('accepts a valid BUG frontmatter', () => {
    const r = validateFrontmatter('bug', {
      id: 'BUG-001',
      type: 'bug',
      status: 'open',
      severity: 'high',
      affects: ['E1-FR8'],
      reported: '2026-07-13',
      reporter: 'alex',
    })
    expect(r.ok).toBe(true)
  })

  it('accepts a resolved BUG with spawned_cr', () => {
    const r = validateFrontmatter('bug', {
      id: 'BUG-001',
      type: 'bug',
      status: 'duplicate',
      severity: 'low',
      affects: ['E1-FR8'],
      reported: '2026-07-13',
      reporter: 'alex',
      spawned_cr: 'CR-003',
    })
    expect(r.ok).toBe(true)
  })

  it('rejects a malformed BUG id', () => {
    const r = validateFrontmatter('bug', {
      id: 'BUG-1',
      type: 'bug',
      status: 'open',
      severity: 'high',
      affects: [],
      reported: '2026-07-13',
      reporter: 'alex',
    })
    expect(r.ok).toBe(false)
  })

  it('accepts a valid EPIC-INDEX frontmatter', () => {
    const r = validateFrontmatter('epic', {
      id: 'E1',
      type: 'epic',
      title: 'Entry & board',
      status: 'active',
    })
    expect(r.ok).toBe(true)
  })

  it('rejects a malformed EPIC id', () => {
    const r = validateFrontmatter('epic', {
      id: 'Epic1',
      type: 'epic',
      title: 'Entry & board',
      status: 'active',
    })
    expect(r.ok).toBe(false)
  })
})

describe('crSchema v3', () => {
  const base = { id: 'CR-017', type: 'cr', status: 'confirmed' }
  it('accepts entry_point requirement with an impacts set', () => {
    const fm = {
      ...base,
      entry_point: 'requirement',
      entry_point_confirmed: true,
      impacts: [{ amends: 'E2-FR1' }, { spawns: 'fr', epic: 'E2' }, { spawns: 'nfr', epic: 'E1', realized: 'E1-NFR12' }],
    }
    expect(crSchema.safeParse(fm).success).toBe(true)
  })
  it("rejects the retired 'solution' entry_point", () => {
    expect(crSchema.safeParse({ ...base, entry_point: 'solution' }).success).toBe(false)
  })
  it('rejects an impact that is neither amends nor spawns, and a spawns without epic', () => {
    expect(crImpactSchema.safeParse({ delivers: 'E2-FR1' }).success).toBe(false)
    expect(crImpactSchema.safeParse({ spawns: 'fr' }).success).toBe(false)
    expect(crImpactSchema.safeParse({ amends: 'not-an-id' }).success).toBe(false)
  })
  it('accepts provenance: backfilled and rejects other provenance values', () => {
    expect(crSchema.safeParse({ ...base, provenance: 'backfilled' }).success).toBe(true)
    expect(crSchema.safeParse({ ...base, provenance: 'migrated' }).success).toBe(false)
  })
})

describe('configSchema link_root', () => {
  it('accepts optional link_root', () => {
    expect(configSchema.safeParse({ canon_roots: ['cr/'], link_root: 'product' }).success).toBe(true)
    expect(configSchema.safeParse({ canon_roots: ['cr/'] }).success).toBe(true)
  })
})

describe('schema — validateFrontmatter issue formatting', () => {
  it('reports a root-level issue when the frontmatter is not an object', () => {
    const r = validateFrontmatter('fr', null)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.some((i) => i.startsWith('(root):'))).toBe(true)
  })
})

describe('schema — schemas record covers every NodeType', () => {
  it('has an entry for each node type named in the brief', () => {
    const types = Object.keys(schemas).sort()
    expect(types).toEqual(['bug', 'cr', 'epic', 'fr', 'goal', 'nfr', 'vision', 'wp', 'br'].sort())
  })
})

describe('schema — machine schemas (§6.9)', () => {
  it('validates the counters shape', () => {
    const r = countersSchema.safeParse({
      product: { epic: 6, cr: 16, wp: 15, bug: 0, baselineSeq: {} },
      epics: { E1: { fr: 8, nfr: 4, br: 3 } },
      retired: [],
    })
    expect(r.success).toBe(true)
  })

  it('validates counters with a populated baselineSeq', () => {
    const r = countersSchema.safeParse({
      product: { epic: 6, cr: 16, wp: 15, bug: 0, baselineSeq: { '20260713': 2 } },
      epics: { E1: { fr: 8, nfr: 4, br: 3 } },
      retired: ['E1-FR2'],
    })
    expect(r.success).toBe(true)
  })

  it('rejects counters whose retired[] holds a non-requirement id', () => {
    const r = countersSchema.safeParse({
      product: { epic: 6, cr: 16, wp: 15, bug: 0, baselineSeq: {} },
      epics: { E1: { fr: 8, nfr: 4, br: 3 } },
      retired: ['CR-001'],
    })
    expect(r.success).toBe(false)
  })

  it('rejects counters missing a required field', () => {
    const r = countersSchema.safeParse({
      product: { epic: 6, cr: 16, wp: 15, baselineSeq: {} },
      epics: {},
      retired: [],
    })
    expect(r.success).toBe(false)
  })

  it('validates a baseline manifest', () => {
    const r = baselineManifestSchema.safeParse({
      id: 'BL-20260713',
      date: '20260713',
      wp_ids: ['WP-20260713-001'],
      triggered_by: 'WP-20260713-001',
      items: [{ id: 'E1-FR8', version: 3, content_hash: 'abc123' }],
      accepted_by: 'alex',
      verify_evidence_ref: '.ba/cache/verify-WP-20260713-001.json',
    })
    expect(r.success).toBe(true)
  })

  it('validates a baseline manifest whose delivered set mixes FR/NFR/BR ids', () => {
    const r = baselineManifestSchema.safeParse({
      id: 'BL-20260713-2',
      date: '20260713',
      wp_ids: ['WP-20260713-001'],
      triggered_by: 'WP-20260713-001',
      items: [
        { id: 'E1-FR8', version: 3, content_hash: 'abc123' },
        { id: 'E1-NFR3', version: 1, content_hash: 'def456' },
        { id: 'E1-BR2', version: 1, content_hash: 'ghi789' },
      ],
      accepted_by: 'alex',
      verify_evidence_ref: '.ba/cache/verify-WP-20260713-001.json',
    })
    expect(r.success).toBe(true)
  })

  it('rejects a baseline manifest item whose id is not a FR/NFR/BR id', () => {
    const r = baselineManifestSchema.safeParse({
      id: 'BL-20260713',
      date: '20260713',
      wp_ids: ['WP-20260713-001'],
      triggered_by: 'WP-20260713-001',
      items: [{ id: 'CR-001', version: 1, content_hash: 'abc123' }],
      accepted_by: 'alex',
      verify_evidence_ref: '.ba/cache/verify-WP-20260713-001.json',
    })
    expect(r.success).toBe(false)
  })

  it('rejects a baseline manifest with zero delivered items (items must be non-empty)', () => {
    const r = baselineManifestSchema.safeParse({
      id: 'BL-20260713',
      date: '20260713',
      wp_ids: ['WP-20260713-001'],
      triggered_by: 'WP-20260713-001',
      items: [],
      accepted_by: 'alex',
      verify_evidence_ref: '.ba/cache/verify-WP-20260713-001.json',
    })
    expect(r.success).toBe(false)
  })

  it('rejects a baseline manifest with a malformed baseline id', () => {
    const r = baselineManifestSchema.safeParse({
      id: 'BL-2026071',
      date: '20260713',
      wp_ids: ['WP-20260713-001'],
      triggered_by: 'WP-20260713-001',
      items: [{ id: 'E1-FR8', version: 3, content_hash: 'abc123' }],
      accepted_by: 'alex',
      verify_evidence_ref: '.ba/cache/verify-WP-20260713-001.json',
    })
    expect(r.success).toBe(false)
  })

  it('validates verify-evidence', () => {
    const r = verifyEvidenceSchema.safeParse({
      wpId: 'WP-20260713-001',
      commit: 'abc123def',
      testRunHashes: ['h1', 'h2'],
      suites: ['mobile', 'core'],
      producedAt: '2026-07-13T10:00:00Z',
      producedBy: 'claude',
      toolVersion: '0.0.1',
    })
    expect(r.success).toBe(true)
  })

  it('rejects verify-evidence missing testRunHashes', () => {
    const r = verifyEvidenceSchema.safeParse({
      wpId: 'WP-20260713-001',
      commit: 'abc123def',
      suites: ['mobile'],
      producedAt: '2026-07-13T10:00:00Z',
      producedBy: 'claude',
      toolVersion: '0.0.1',
    })
    expect(r.success).toBe(false)
  })
})
