// ---- fmt.ts: `praxis-ba fmt` — the canonical byte-stable formatter (Task 16,
// the HYBRID write-path's first piece). Under the hybrid decision, the
// harness SKILLS (Task 18) author md canon by writing files DIRECTLY, then
// call `praxis-ba fmt` to canonicalize them — like running prettier over the
// canon. This module adds NO new serialization logic: `formatText` is
// exactly `emitPage(type, parsePage(raw, type).frontmatter, parsePage(raw,
// type).body)`, so every guarantee parse.ts/serialize.ts already give
// carries over untouched — fixed per-type key order, natural-sorted ref
// arrays, a single trailing LF, and (critically) an OPAQUE body: parse.ts's
// body substring is never re-parsed or reflowed here, so an in-body `---`
// horizontal rule survives byte-for-byte (it is never mistaken for a second
// frontmatter fence — see parse.ts's own header for why gray-matter's fence
// anchoring already guarantees that on the read side).

import { readFileSync } from 'node:fs'
import { parsePage, peekType as peekRawType } from './parse.js'
import { emitPage, type FrontmatterFor } from './serialize.js'
import { atomicWrite } from './writer.js'
import { schemas } from './schema.js'
import type { NodeType } from './types.js'

/**
 * Canonicalizes one page string: `parsePage` then `emitPage`, nothing else.
 * Idempotent — a second pass over already-canonical text is a no-op,
 * because `emitPage`'s own output re-parses to the identical frontmatter +
 * body it was built from. The body is passed through exactly as `parsePage`
 * hands it back: opaque, verbatim, never reflowed or re-parsed.
 *
 * Throws if `raw` fails to parse/validate under `type` (a `parsePage`
 * `{error}`) — surfacing that error rather than emitting garbage, per the
 * task brief's own guardrail.
 */
export function formatText(raw: string, type: NodeType): string {
  const parsed = parsePage(raw, type)
  if ('error' in parsed) {
    throw new Error(`fmt: cannot format as '${type}': ${parsed.error}`)
  }
  // Same boundary-widening cast cli.ts's `roundTripViolations` already uses
  // for exactly this shape (a runtime-determined `NodeType`, not a literal
  // the compiler can narrow `emitPage`'s generic `T` from directly).
  return emitPage(type, parsed.frontmatter as FrontmatterFor<typeof type>, parsed.body)
}

/** Narrows parse.ts's shared `peekType` (a plain `string | undefined`) down
 * to a known `NodeType` — this is what lets `formatFile` infer a file's
 * node type from its own frontmatter alone, with no external type hint
 * required. The real, schema-validated read still happens inside
 * `formatText`. */
function peekType(raw: string): NodeType | undefined {
  const type = peekRawType(raw)
  return type !== undefined && type in schemas ? (type as NodeType) : undefined
}

export type FormatFileResult = { changed: boolean }

/**
 * Reads `path`, infers its node type from frontmatter alone, canonicalizes
 * via `formatText`, and atomic-writes back ONLY if the canonical bytes
 * differ from what's on disk — `changed` reflects exactly that comparison.
 *
 * `repo` is accepted (mirroring both the task's pinned `(repo, path)`
 * interface and every writer.ts mutator's `(repo, ...)` convention) but is
 * NOT used to resolve `path`: `path` is expected already-resolved (absolute,
 * or relative to the process's cwd) — exactly what this CLI's other
 * path-taking flags (`--body-file`/`--plan`/`--evidence`) already expect,
 * and exactly what `cli.ts`'s `--repo` canon walker already hands back.
 * Re-joining `path` against `repo` here would double-prefix a walked path
 * whenever `--repo` itself was given as a relative directory.
 */
export function formatFile(repo: string, path: string): FormatFileResult {
  void repo
  const raw = readFileSync(path, 'utf8')
  const type = peekType(raw)
  if (type === undefined) {
    throw new Error(`fmt: ${path}: missing or unrecognized frontmatter 'type'`)
  }
  const formatted = formatText(raw, type)
  if (formatted === raw) return { changed: false }
  atomicWrite(path, formatted)
  return { changed: true }
}
