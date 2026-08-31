// ---- fs.ts: canon-file discovery — the ONE shared corpus walker (design
// spec §5 layout; Plan-2 Task 0 "canon-path scoping").
//
// Before this consolidation, `validate`'s corpus walk (cli.ts), `loadGraph`
// (writer.ts), and `fmt`'s whole-repo `--repo` enumeration (cli.ts) each
// carried their OWN private copy of the same recursive `.md` walker (a
// related `peekType` helper was triplicated too — see parse.ts's own header
// for that consolidation). Real `product/` mixes VitePress **prose**
// (`process/`, `architecture/`, `overview/`, …) with canon — the old
// walk-everything walker would ingest prose `.md` as canon and hard-fail
// `validate`'s `schema-valid` check. This module fixes that at the source,
// for every consumer at once:
//
//   - `readCanonConfig` — the OPTIONAL `<repo>/.ba/config.yaml`
//     (`canon_roots: string[]`, schema.ts's `configSchema`). Absent config
//     is the ORDINARY case (every pre-Task-0 repo/fixture has none) — not
//     an error.
//   - `walkCanonFiles` — resolves the scan roots (config's `canon_roots`
//     when present, else {@link DEFAULT_CANON_ROOTS}) and returns every `.md`
//     path under them, deduped, in first-encounter order.
//
// Installed/generated/internal directories (`.git/`, `node_modules/`, `dist/`,
// …) are excluded UNCONDITIONALLY inside the recursive walk — a `--repo .`
// validate must never interpret packaged plugin `SKILL.md` files under
// `node_modules/@praxis/*` as project canon documents.
//
// `.ba/` (the machine ledger/lock/cache) and `baselines/` (frozen
// snapshots) are excluded UNCONDITIONALLY, regardless of config — never
// made a scannable root (task constraint: these two exclusions must never
// change). A real `accept()`-produced baseline dir contains frozen
// `<id>.md` copies with perfectly valid fr/nfr/br frontmatter; scanning it
// would double-count those ids into the live graph, which is exactly the
// bug this exclusion prevents — so it is enforced inside the walk itself,
// not left to whatever a config happens to list.
//
// A WP-folder attachment (currently just `plan.md`, `EXCLUDED_ATTACHMENT_FILENAMES`
// below) is excluded by BASENAME the same unconditional way: it lives INSIDE
// the `wp/` canon root (`wp/<id>/plan.md`, next to that WP's own
// `index.md`), so without this it would be swept up as a candidate canon
// page and hard-fail `validate` with "unrecognized or missing 'type' field"
// — a real defect this package's own migrated `product/wp/WP-*/plan.md`
// files triggered.

import { readFileSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { parse as yamlParse } from 'yaml'
import type { z } from 'zod'
import { configSchema } from './schema.js'

// Inferred straight from `configSchema` (schema.ts) rather than a hand-copied
// shape, so a schema field (e.g. `link_root`, v3) is never invisible to this
// module's own return type — a prior hand-written `{ canon_roots: string[] }`
// literal silently dropped `link_root` from every caller's view even though
// `readCanonConfig` already returned it at runtime (schema.ts's zod parse
// always includes it); `cli.ts`'s Task 7 `resolveLinkRoot` is the first
// caller that actually reads `link_root`, which is what surfaced the gap.
type CanonConfig = z.infer<typeof configSchema>

/**
 * Default BA/project surface when `.ba/config.yaml` is absent.
 * Prefer an explicit allowlist over walking the whole tree (which would
 * ingest VitePress prose and installed dependency Markdown).
 */
export const DEFAULT_CANON_ROOTS: readonly string[] = [
  'vision.md',
  'epics/',
  'br/',
  'cr/',
  'wp/',
  'bugs/',
  'goals/',
]

/** Directory basenames never traversed, even when listed under a root. */
export const EXCLUDED_DIR_NAMES = new Set([
  '.ba',
  'baselines',
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'tmp',
  'vendor',
])

// WP-folder attachment files — canon-ATTACHED artifacts (e.g. a WP's
// `plan.md`, `writer.ts`'s `wpPath` sibling) that live INSIDE the `wp/`
// canon root but are never canon PAGES themselves (no `type` frontmatter at
// all). Real `product/wp/WP-*/plan.md` sits directly under the scanned
// `wp/` root, so the walker would otherwise ingest it as a candidate canon
// page and `validate` hard-fails it with "unrecognized or missing 'type'
// field" — this is the one place that exclusion is enforced, by BASENAME,
// so it's applied uniformly regardless of directory depth or `canon_roots`
// scoping. Add any FUTURE wp-folder attachment filename here, not as a new
// special case elsewhere.
const EXCLUDED_ATTACHMENT_FILENAMES = new Set(['plan.md'])

function configPath(repo: string): string {
  return join(repo, '.ba', 'config.yaml')
}

/** Reads + zod-validates the optional `<repo>/.ba/config.yaml`. Returns
 * `undefined` when the file is absent (ENOENT) — the ordinary,
 * backward-compatible case. A PRESENT-but-malformed config throws with the
 * joined zod issues, never silently coerced — same posture as `ids.ts`'s
 * `readCounters`. */
export function readCanonConfig(repo: string): CanonConfig | undefined {
  let raw: string
  try {
    raw = readFileSync(configPath(repo), 'utf8')
  } catch {
    return undefined
  }
  const parsed: unknown = yamlParse(raw)
  const result = configSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    throw new Error(`config: ${configPath(repo)} failed schema validation: ${issues.join('; ')}`)
  }
  return result.data
}

/** Recursively collects every `.md` file path under `dir` into `out`,
 * skipping excluded directories unconditionally (see file header). The one
 * recursive primitive both the default surface walk and each configured
 * root's walk share. */
function walkMdFilesUnder(dir: string, out: string[]): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue
      walkMdFilesUnder(join(dir, entry.name), out)
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      if (EXCLUDED_ATTACHMENT_FILENAMES.has(entry.name)) continue
      out.push(join(dir, entry.name))
    }
  }
}

/** Resolves one configured `canon_roots` entry (a repo-relative path — a
 * single file like `vision.md`, or a directory like `epics/`) to its `.md`
 * file(s). A root that doesn't exist yet on disk (e.g. `bugs/` before the
 * first `bug capture`) resolves to zero files, not an error — the same
 * tolerance the default surface walk already has for an unreadable directory. */
function walkRoot(repo: string, root: string): string[] {
  const abs = join(repo, root)
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(abs)
  } catch {
    return []
  }
  if (stat.isFile()) return abs.endsWith('.md') ? [abs] : []
  const out: string[] = []
  walkMdFilesUnder(abs, out)
  return out
}

function collectFromRoots(repo: string, roots: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const root of roots) {
    for (const file of walkRoot(repo, root)) {
      if (!seen.has(file)) {
        seen.add(file)
        out.push(file)
      }
    }
  }
  return out
}

/**
 * The ONE canon-file discovery function every consumer routes through:
 * `validate`'s corpus walk and `fmt`'s whole-repo enumeration (both
 * cli.ts), and `loadGraph` (writer.ts) — which the VitePress data loaders
 * (`product/.vitepress/loaders/*.data.ts`) call transitively via
 * `@praxis-ba/canon-graph`.
 *
 * When `<repo>/.ba/config.yaml` exists, scans ONLY its `canon_roots`.
 * Absent config: scans {@link DEFAULT_CANON_ROOTS} (explicit project
 * surface) — never a whole-tree walk into `node_modules/` or prose trees.
 */
export function walkCanonFiles(repo: string): string[] {
  const config = readCanonConfig(repo)
  return collectFromRoots(repo, config?.canon_roots ?? DEFAULT_CANON_ROOTS)
}
