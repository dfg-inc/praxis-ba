import { z } from 'zod'
import type { NodeType, Status } from './types.js'

// ---- id-format regexes (pinned; verbatim from the design spec §6 / Global Constraints) ----
export const EPIC_ID = /^E\d+$/
export const FR_ID = /^E\d+-FR\d+$/
export const NFR_ID = /^E\d+-NFR\d+$/
/** Project catalogue NFR ids (e.g. PXT-NFR-001 in shared/nfr.md). */
export const CATALOG_NFR_ID = /^[A-Z][A-Z0-9]{1,9}-NFR-\d{3}$/
export const BR_ID = /^E\d+-BR\d+$/
export const CR_ID = /^CR-\d{3}$/
export const WP_ID = /^WP-\d{8}-\d{3}$/
export const BUG_ID = /^BUG-\d{3}$/
export const GOAL_ID = /^G\d+$/
export const BASELINE_ID = /^BL-\d{8}(-\d+)?$/
const DATE_KEY = /^\d{8}$/

const isRequirementId = (v: string): boolean => FR_ID.test(v) || NFR_ID.test(v) || BR_ID.test(v)

// ---- the unified Status enum, shared by fr/nfr/br (§7) ----
const STATUS_VALUES = ['draft', 'active', 'batched', 'baselined', 'superseded', 'retired'] as const
export const statusSchema: z.ZodType<Status> = z.enum(STATUS_VALUES)

// ---- §6.1 VISION — product/vision.md ----
export const visionSchema = z.object({
  type: z.literal('vision'),
  status: z.enum(['draft', 'confirmed']),
  confirmed_at: z.string().optional(),
  confirmed_by: z.string().optional(),
})

// ---- §6.2 FR — epics/E{n}-slug/E{n}-FR{m}.md ----
export const frSchema = z.object({
  id: z.string().regex(FR_ID),
  type: z.literal('fr'),
  epic: z.string().regex(EPIC_ID),
  status: statusSchema,
  version: z.number().int().min(1),
  traces_to: z.array(z.string().regex(CR_ID)),
  enforces: z.array(z.string().regex(BR_ID)),
  // Canon NFR nodes (E#-NFR#) and/or project-catalogue ids (KEY-NFR-NNN).
  references_nfr: z.array(z.union([z.string().regex(NFR_ID), z.string().regex(CATALOG_NFR_ID)])),
  related: z.array(z.string()),
  // Optional goals layer (WBS 1.11): FR↔goal link; absent means unlinked.
  goal_ids: z.array(z.string().regex(GOAL_ID)).optional(),
  baseline: z.string().regex(BASELINE_ID).optional(),
  supersedes: z.string().regex(FR_ID).optional(),
  superseded_by: z.string().regex(FR_ID).optional(),
  provenance: z.literal('migrated').optional(),
})

// ---- §6.3 NFR — epics/E{n}-slug/E{n}-NFR{m}.md ----
export const nfrSchema = z.object({
  id: z.string().regex(NFR_ID),
  type: z.literal('nfr'),
  epic: z.string().regex(EPIC_ID),
  status: statusSchema,
  version: z.number().int().min(1),
  traces_to: z.array(z.string().regex(CR_ID)),
  verified_by: z.array(z.string()),
  related: z.array(z.string()),
  goal_ids: z.array(z.string().regex(GOAL_ID)).optional(),
  baseline: z.string().regex(BASELINE_ID).optional(),
  supersedes: z.string().regex(NFR_ID).optional(),
  superseded_by: z.string().regex(NFR_ID).optional(),
  provenance: z.literal('migrated').optional(),
})

// ---- §6.4 BR — br/E{n}-BR{m}.md (decoupled catalog) ----
export const brSchema = z.object({
  id: z.string().regex(BR_ID),
  type: z.literal('br'),
  epic: z.string().regex(EPIC_ID),
  kind: z.enum(['structural', 'operative']),
  enforcement: z.enum(['advisory', 'hard']),
  status: statusSchema,
  version: z.number().int().min(1),
  goal_ids: z.array(z.string().regex(GOAL_ID)).optional(),
  baseline: z.string().regex(BASELINE_ID).optional(),
  supersedes: z.string().regex(BR_ID).optional(),
  superseded_by: z.string().regex(BR_ID).optional(),
  provenance: z.literal('migrated').optional(),
})

// ---- Goal — goals/G{n}.md (WBS 1.11): product outcome a requirement advances.
// Linked requirements are reverse-walked from FR/NFR/BR `goal_ids` (never a
// stored backlink field on the goal page itself). ----
export const goalSchema = z.object({
  id: z.string().regex(GOAL_ID),
  type: z.literal('goal'),
  title: z.string().min(1),
  status: z.enum(['draft', 'active', 'achieved', 'retired']),
})

// ---- §6.5 CR — cr/CR-###.md (v3: entry enum + impact set, spec §2.1) ----
//
// `impacts` replaces the old free-text entry_point-only shape with a typed
// set of what the CR actually touches: each entry either AMENDS an existing
// requirement (bumping its version — Task 5) or SPAWNS a brand-new one under
// an epic (optionally already REALIZED as a concrete id, once minted). This
// is an array of OBJECTS, not ref-id strings — it deliberately stays OUT of
// serialize.ts's REF_ARRAY_KEYS (whose sort is string-array-only) and keeps
// insertion order, which is meaningful for `cr realize` (Task 5+).
export const crImpactSchema = z.union([
  z.object({ amends: z.string().refine(isRequirementId, { message: 'must be a FR/NFR/BR id' }) }).strict(),
  z.object({
    spawns: z.enum(['fr', 'nfr', 'br']),
    epic: z.string().regex(EPIC_ID),
    realized: z.string().refine(isRequirementId, { message: 'must be a FR/NFR/BR id' }).optional(),
  }).strict(),
])
export type CrImpact = z.infer<typeof crImpactSchema>

export const crSchema = z.object({
  id: z.string().regex(CR_ID),
  type: z.literal('cr'),
  status: z.enum(['captured', 'confirmed', 'resolved']),
  // v3: the old free-text entry_point is now a closed enum — 'vision' (new
  // product surface) or 'requirement' (amends/spawns off the existing
  // canon). The retired third level ('solution'/'epic'/'feature', v1-v2 CLI
  // free text) no longer validates — see migrate-v3 (Task 9) for the
  // backfill path that maps old advisory strings onto this enum or falls
  // back to `provenance: backfilled` when no confident mapping exists.
  entry_point: z.enum(['vision', 'requirement']).optional(),
  entry_point_confirmed: z.boolean().optional(),
  impacts: z.array(crImpactSchema).optional(),
  // Set only by the v2→v3 migration/backfill map (Task 10) for CRs whose
  // impact set could not be reconstructed with confidence from history —
  // never written by any live CLI verb.
  provenance: z.literal('backfilled').optional(),
  spawned_from_bug: z.string().regex(BUG_ID).optional(),
})

// ---- §6.6 WP — wp/<id>/index.md (v3: FOLDER layout — writer.ts's `wpPath`
// resolves a WP id to `wp/<id>/index.md`, not a flat `wp/<id>.md` file, the
// same folder-per-item shape epics already use, Task 5). Slim frontmatter —
// the FR/NFR/BR scope a WP delivers/constrains doesn't live here at all. It
// lives in the page BODY's machine-readable `## Scope` section
// (scopelinks.ts's `parseScope`/`ParsedScope`, graph.ts's `wpScope`/
// `wpDelivers`/`closure` consume it). `.strict()` (Task 5): a v2 page's
// `fr_ids`/`extra_brs`/`extra_nfrs` frontmatter is now a hard schema-validation
// FAILURE on read, not a silent strip — the one CLI verb that still emitted
// that old shape (`wp author`, via `writer.ts`'s now-deleted `authorWp`) is
// retired this task, so nothing live writes it anymore; a real legacy v2
// page's transform to the v3 shape is migrate-v3's job (Task 9), not a
// read-time tolerance here. ----
export const wpSchema = z
  .object({
    id: z.string().regex(WP_ID),
    type: z.literal('wp'),
    role: z.enum(['developer', 'qa']),
    status: z.enum(['draft', 'ready', 'plan-approved', 'accepted', 'abandoned']),
    plan: z.string().optional(),
  })
  .strict()

// ---- §6.7 BUG — bugs/BUG-###.md (client-reported only) ----
export const bugSchema = z.object({
  id: z.string().regex(BUG_ID),
  type: z.literal('bug'),
  status: z.enum(['open', 'fixed', 'wontfix', 'duplicate']),
  severity: z.string().min(1),
  affects: z.array(z.string().min(1)),
  reported: z.string(),
  reporter: z.string(),
  spawned_cr: z.string().regex(CR_ID).optional(),
})

// ---- §6.8 EPIC-INDEX — epics/E{n}-slug/index.md ----
export const epicSchema = z.object({
  id: z.string().regex(EPIC_ID),
  type: z.literal('epic'),
  title: z.string().min(1),
  status: z.string().min(1),
})

// ---- the per-node-type registry (dispatch table for validateFrontmatter) ----
export const schemas: Record<NodeType, z.ZodTypeAny> = {
  vision: visionSchema,
  fr: frSchema,
  nfr: nfrSchema,
  br: brSchema,
  cr: crSchema,
  wp: wpSchema,
  bug: bugSchema,
  epic: epicSchema,
  goal: goalSchema,
}

// ---- §6.9 machine schemas ----
export const countersSchema = z.object({
  product: z.object({
    epic: z.number().int().nonnegative(),
    cr: z.number().int().nonnegative(),
    wp: z.number().int().nonnegative(),
    bug: z.number().int().nonnegative(),
    baselineSeq: z.record(z.string().regex(DATE_KEY), z.number().int().nonnegative()),
  }),
  epics: z.record(
    z.string().regex(EPIC_ID),
    z.object({
      fr: z.number().int().nonnegative(),
      nfr: z.number().int().nonnegative(),
      br: z.number().int().nonnegative(),
    })
  ),
  retired: z.array(z.string().refine(isRequirementId, { message: 'must be a FR/NFR/BR id' })),
})

// ---- CONFIG — `<repo>/.ba/config.yaml` (OPTIONAL, backward-compatible;
// Plan-2 "canon-path scoping" addendum). `canon_roots` is a list of
// repo-relative paths — a single file (`vision.md`) or a directory
// (`epics/`, `br/`, `cr/`, `wp/`, `bugs/`) — that canon discovery
// (`fs.ts`'s `walkCanonFiles`) scans EXCLUSIVELY when this file is present.
// A repo with no `.ba/config.yaml` at all (every pre-existing Plan-1
// fixture/repo) keeps the ORIGINAL default: walk every `.md` under the repo
// except `.ba/` and `baselines/` — this schema/file is purely additive. Real
// `product/` mixes VitePress prose (`process/`, `architecture/`, …) with
// canon, so a migrated repo seeds this file (`migrate.ts`) to scope
// `validate`/`loadGraph`/the VitePress loaders to just the canon roots.
//
// `link_root` (v3, OPTIONAL, additive): the repo-relative directory that
// rewritten canon links (e.g. a WP's `## Scope` links, Task 3) resolve
// against, for repos where the canon roots don't sit at the repo root
// (e.g. `product/`). Absent means "resolve relative to the repo root",
// matching every pre-v3 repo's existing behavior.
export const configSchema = z.object({
  canon_roots: z.array(z.string().min(1)),
  link_root: z.string().min(1).optional(),
})

export const baselineManifestSchema = z.object({
  id: z.string().regex(BASELINE_ID),
  date: z.string().regex(DATE_KEY),
  wp_ids: z.array(z.string().regex(WP_ID)),
  triggered_by: z.string().regex(WP_ID),
  // `.min(1)`: a baseline with zero delivered items is invalid — accept never
  // freezes "nothing" (the accept transaction throws before writing a marker
  // if the delivered set is empty). This is the last-line guard that turns a
  // would-be empty/garbage baseline into a hard validation error rather than a
  // silently-committed no-content snapshot.
  items: z
    .array(
      z.object({
        id: z.string().refine(isRequirementId, { message: 'must be a FR/NFR/BR id' }),
        version: z.number().int().min(1),
        content_hash: z.string().min(1),
      })
    )
    .min(1),
  accepted_by: z.string(),
  verify_evidence_ref: z.string(),
})

// ---- PENDING-MARKER — `<repo>/.ba/cache/pending-<wpId>.json` (§8a crash
// safety, Task 11). The durable write-ahead intent-of-record for an in-flight
// accept transaction: written (atomically) BEFORE any item/baseline write,
// deleted as the LAST step of a completed accept. Its PRESENCE — keyed to the
// WP id — is the sole proof a transaction is mid-flight and must be resumed;
// its ABSENCE (plus WP `accepted`) is the sole proof one completed. Resume is
// driven entirely off this marker's own `baselineId`/`deliveredIds` — never
// re-inferred from directory/filename shape. Zod-validated on read (a corrupt
// or tampered marker fails loudly, never silently coerces). ----
export const pendingMarkerSchema = z.object({
  wpId: z.string().regex(WP_ID),
  baselineId: z.string().regex(BASELINE_ID),
  deliveredIds: z.array(z.string().refine(isRequirementId, { message: 'must be a FR/NFR/BR id' })).min(1),
  date: z.string().regex(DATE_KEY),
  headCommit: z.string(),
  verifyEvidenceRef: z.string(),
})

export const verifyEvidenceSchema = z.object({
  wpId: z.string().regex(WP_ID),
  commit: z.string(),
  testRunHashes: z.array(z.string()),
  suites: z.array(z.string()),
  producedAt: z.string(),
  producedBy: z.string(),
  toolVersion: z.string(),
})

// ---- dispatch ----
export function validateFrontmatter(
  type: NodeType,
  fm: unknown
): { ok: true; data: unknown } | { ok: false; issues: string[] } {
  const result = schemas[type].safeParse(fm)
  if (result.success) return { ok: true, data: result.data }
  const issues = result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
    return `${path}: ${issue.message}`
  })
  return { ok: false, issues }
}
