/**
 * Helpers for body-file ingest and NFR mention extraction.
 * Keeps FR frontmatter mutations single-block and references_nfr in sync
 * with explicit body dependencies.
 */
import { CATALOG_NFR_ID, NFR_ID } from './schema.js'

const CATALOG_NFR_RE = /\b([A-Z][A-Z0-9]{1,9}-NFR-\d{3})\b/g
const CANON_NFR_RE = /\b(E\d+-NFR\d+)\b/g

/**
 * If `raw` starts with a YAML frontmatter fence pair, return only the body
 * after the closing fence. Otherwise return `raw` unchanged.
 * Used by `req edit --body-file` so agents that pass a full page do not
 * create a second frontmatter block on write.
 */
export function stripLeadingFrontmatter(raw: string): string {
  // Agents sometimes leave a blank line before a pasted full-page fence;
  // trimStart so healing matches bodyHasLeadingFrontmatterFence.
  const candidate = raw.trimStart()
  if (!candidate.startsWith('---')) return raw
  const match = candidate.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  if (!match) return raw
  return candidate.slice(match[0].length)
}

/** True when body still contains a leading `---` fence (duplicate FM smell). */
export function bodyHasLeadingFrontmatterFence(body: string): boolean {
  return /^\s*---\r?\n/.test(body)
}

/** Strip every leading YAML fence until the body is clean (heal stacked dups). */
export function stripAllLeadingFrontmatter(raw: string): string {
  let body = raw
  // Cap iterations so a malformed open fence cannot loop forever.
  for (let i = 0; i < 8 && bodyHasLeadingFrontmatterFence(body); i++) {
    const next = stripLeadingFrontmatter(body)
    if (next === body) break
    body = next
  }
  return body
}

export function isCatalogNfrId(id: string): boolean {
  return CATALOG_NFR_ID.test(id) && !NFR_ID.test(id)
}

export function isCanonNfrId(id: string): boolean {
  return NFR_ID.test(id)
}

/** Extract canon + catalogue NFR ids mentioned in free text (rationale etc.). */
export function extractNfrMentions(text: string): {
  canon: string[]
  catalog: string[]
} {
  const canon = new Set<string>()
  const catalog = new Set<string>()
  for (const m of text.matchAll(CANON_NFR_RE)) {
    if (m[1]) canon.add(m[1])
  }
  for (const m of text.matchAll(CATALOG_NFR_RE)) {
    if (m[1] && !NFR_ID.test(m[1])) catalog.add(m[1])
  }
  return {
    canon: [...canon].sort(),
    catalog: [...catalog].sort(),
  }
}

/**
 * Merge NFR mentions from body into `references_nfr` (deduped, sorted).
 * Both canon `E#-NFR#` and catalogue `KEY-NFR-NNN` ids are kept.
 */
export function mergeReferencesNfr(
  existing: readonly string[] | undefined,
  body: string,
): string[] {
  const { canon, catalog } = extractNfrMentions(body)
  const set = new Set<string>([...(existing ?? []), ...canon, ...catalog])
  return [...set].sort()
}
