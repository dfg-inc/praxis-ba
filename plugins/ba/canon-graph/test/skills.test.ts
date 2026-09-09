// ---- skills.test.ts: structural test for Task 18's 9 SKILL.md files under
// `.claude/plugins/praxis-ba/skills/` — the flow/judgment layer over the
// Task 12 CLI (`cli.ts`) + Task 17 templates, written under the HYBRID
// write-path contract (owner decision, 2026-07-14, progress.md): skills
// author canon md DIRECTLY (`Write`) from a template after `id next`, then
// `fmt` + `validate --check`; the CLI is reserved for transactional ops
// (`req edit` on a baselined item, `accept`, gates, reads). Two CREATE verbs
// are retired-but-real for skill use (`bug capture`/`epic add` — still real,
// dispatchable verbs; just unused under the hybrid contract, `RETIRED_VERBS`
// below). Three MORE — `cr capture`/`req add`/`wp author` — were retired AND
// deleted outright: `wp author` first (Task 5; WP authoring is exclusively
// the `id next` + direct `Write` pattern now), `cr capture`/`req add`
// following the same posture in Task 8 (CR/FR/NFR/BR authoring too). All
// three live in `REMOVED_VERBS` below (not `RETIRED_VERBS` — they are no
// longer real dispatch verbs at all, so a SKILL.md could never legitimately
// mention them as an `praxis-ba <verb>` command).
//
// v3 (Task 11/12): a 9th skill, `grill-cr`, sits between `capture-cr` and
// `shape-requirement` — the relentless product-only interview over a
// captured CR that now OWNS the CR entry-point + impact-set human gate.
// `capture-cr` itself slimmed down to capture-only (no entry-point judgment
// left in it at all — see the `HUMAN_GATE_SKILLS` note below) and its own
// closing line hands off explicitly to `grill-cr`, which `shape-requirement`
// then executes the confirmed impact set of.
//
// This suite proves, without duplicating any of cli.ts's own logic:
//   1. every SKILL.md exists and has valid frontmatter (name + description);
//   2. **verb-reality:** every `praxis-ba <verb…>` mention inside a SKILL.md's
//      code spans names a verb cli.ts's own dispatch switch actually
//      recognizes. The authoritative verb table is EXTRACTED from cli.ts's
//      source text (never hand-duplicated) so this suite can't silently
//      drift from the real dispatch — a sanity test below proves the
//      extraction itself is sound before anything trusts it.
//   3. **hybrid-enforcement:** no authoring skill ever instructs running a
//      retired create verb, and every authoring skill DOES instruct the
//      direct-Write pattern (`Write` + `id next` + `fmt` + `validate
//      --check`).
//   4. **human-gate:** every skill that owns a human decision (confirm-vision,
//      capture-cr's entry-point confirm, prepare-wp's plan-approval step,
//      approve-plan, accept) instructs a real human primitive
//      (`AskUserQuestion`) rather than an agent self-deciding.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import matter from 'gray-matter'
import { describe, expect, it } from 'vitest'

// Plugin root is the parent of canon-graph/ (two levels up from test/).
const pluginRoot = fileURLToPath(new URL('../..', import.meta.url))
const repoRoot = (relPath: string): string =>
  fileURLToPath(new URL(relPath, `file://${pluginRoot}/`))

const PLUGIN_ROOT = '.'
const SKILLS_ROOT = 'skills'
const CLI_SRC_PATH = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const cliSrc = readFileSync(CLI_SRC_PATH, 'utf8')

const SKILL_NAMES = [
  'confirm-vision',
  'capture-cr',
  'grill-cr',
  'shape-requirement',
  'prepare-wp',
  'approve-plan',
  'accept',
  'capture-bug',
  'status',
  'goals',
] as const

// The 4 skills whose whole point is authoring a brand-new canon page
// directly (per the HYBRID contract) rather than wrapping a CLI create verb.
const AUTHORING_SKILLS = ['capture-cr', 'shape-requirement', 'prepare-wp', 'capture-bug'] as const

// Every skill that owns (or, for prepare-wp, re-instructs inline) a human
// decision — design §7's "four human gates" (vision confirm / CR entry-point
// + impact-set confirm / WP plan approval / accept) plus the reusable
// approve-plan skill. v3: the CR entry-point gate moved from `capture-cr` to
// `grill-cr` (the interview that now owns it end-to-end) — `capture-cr`
// itself is capture-only and no longer belongs in this list at all.
const HUMAN_GATE_SKILLS = ['confirm-vision', 'grill-cr', 'prepare-wp', 'approve-plan', 'accept'] as const

// The brief's own named retired set: CLI verbs that mint a page via a
// bespoke writer path the HYBRID contract replaces with `id next` + a
// direct `Write`. Still real, dispatchable cli.ts verbs (confirmed below) —
// "retired" means "not used by these skills", not "fictitious".
//
// v3 (Task 8): `cr capture`/`req add` were ALSO deleted outright (same
// posture as `wp author`, Task 5) — CR/FR/NFR/BR authoring is exclusively
// the hybrid `id next` + direct `Write` pattern now, and neither verb's
// bespoke inline-writer implementation survived the rewire onto
// `writer.ts`'s `confirmCr`/`realizeCrSpawn`/`addRequirement`. They moved
// from RETIRED_VERBS (retired-but-real) to REMOVED_VERBS (retired AND gone)
// below, alongside `wp author`.
const RETIRED_VERBS = ['bug capture', 'epic add'] as const

// Retired AND gone outright — no longer a real cli.ts dispatch verb at all.
const REMOVED_VERBS = ['cr capture', 'req add', 'wp author'] as const

function skillPath(name: string): string {
  return repoRoot(`${SKILLS_ROOT}/${name}/SKILL.md`)
}

function readSkill(name: string): string {
  return readFileSync(skillPath(name), 'utf8')
}

// ==========================================================================
// cli.ts extraction — the authoritative verb table, re-derived from source
// on every run so it can never silently drift from the real dispatch.
// ==========================================================================

/** `positionals[0]` values that take a `positionals[1]` sub-verb (cli.ts's
 * own `TWO_WORD_COMMANDS` set) — extracted from the literal source line so a
 * change to that set is picked up automatically. */
function extractTwoWordCommands(src: string): ReadonlySet<string> {
  const m = /TWO_WORD_COMMANDS:[^=]*=\s*new Set\(\[([^\]]*)\]\)/.exec(src)
  if (!m) throw new Error('skills.test: could not locate TWO_WORD_COMMANDS in cli.ts — extraction regex drifted from source')
  // Non-null: the regex has exactly one unconditional capture group.
  const names = m[1]!
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter((s) => s.length > 0)
  if (names.length === 0) throw new Error('skills.test: TWO_WORD_COMMANDS extraction produced zero entries — regex drifted')
  return new Set(names)
}

/** Every `case '<verb>':` label inside `dispatch()`'s own switch — bounded to
 * that one function's source text (from its `async function dispatch(`
 * signature to the next top-level `// ====…` banner comment) so this never
 * picks up an UNRELATED switch's single-word case labels elsewhere in the
 * file (`idNext`'s scope switch has bare `'epic'`/`'cr'`/`'bug'`/`'wp'`/
 * `'fr'`/`'nfr'`/`'br'` cases; `renderView`'s `--what` switch has
 * `'prd'`/`'rtm'`/`'backlog'`) — those would corrupt this verb table if
 * scanned promiscuously. */
function extractDispatchVerbs(src: string): ReadonlySet<string> {
  const start = src.indexOf('async function dispatch(')
  if (start === -1) throw new Error('skills.test: could not locate dispatch() in cli.ts — extraction regex drifted from source')
  const bannerIdx = src.indexOf('\n// ====', start)
  const body = bannerIdx === -1 ? src.slice(start) : src.slice(start, bannerIdx)
  const verbs = new Set<string>()
  const re = /case '([^']+)':/g
  let m: RegExpExecArray | null
  // Non-null: the regex has exactly one unconditional capture group.
  while ((m = re.exec(body))) verbs.add(m[1]!)
  if (verbs.size < 20) {
    throw new Error(`skills.test: only extracted ${verbs.size} verbs from dispatch() — extraction regex likely drifted`)
  }
  return verbs
}

const dispatchVerbs = extractDispatchVerbs(cliSrc)
const twoWordCommands = extractTwoWordCommands(cliSrc)

// ==========================================================================
// SKILL.md verb-mention extraction — scoped to CODE SPANS only (fenced
// ``` blocks and inline `…` spans), each scanned independently so an
// `praxis-ba` mention in one span can never bleed into an unrelated span
// (whitespace in the regex would otherwise happily match across a naive
// newline-joined concatenation of spans).
// ==========================================================================

function extractCodeSpans(md: string): string[] {
  const spans: string[] = []
  const fence = /```[\s\S]*?```/g
  let m: RegExpExecArray | null
  while ((m = fence.exec(md))) spans.push(m[0])
  const withoutFences = md.replace(fence, '')
  const inline = /`[^`\n]+`/g
  while ((m = inline.exec(withoutFences))) spans.push(m[0])
  return spans
}

/** Every `praxis-ba <verb>` (one word, or two if the first word is a
 * `TWO_WORD_COMMANDS` member and a second lowercase/hyphen token follows)
 * mentioned across `md`'s code spans. */
function extractCliVerbMentions(md: string): string[] {
  const mentions: string[] = []
  const re = /\bpraxis-ba\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/g
  for (const span of extractCodeSpans(md)) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(span))) {
      // Non-null: group 1 is the regex's unconditional capture; group 2 is
      // genuinely optional (a one-word verb has no second token).
      const cmd = m[1]!
      const sub = m[2]
      mentions.push(twoWordCommands.has(cmd) && sub ? `${cmd} ${sub}` : cmd)
    }
  }
  return mentions
}

// ==========================================================================
// tests
// ==========================================================================

describe('cli.ts verb extraction — sanity (the extraction itself must be sound before anything trusts it)', () => {
  it('TWO_WORD_COMMANDS extraction finds the 8 real two-word command prefixes', () => {
    expect(twoWordCommands).toEqual(new Set(['vision', 'cr', 'epic', 'req', 'wp', 'bug', 'id', 'goals']))
  })

  it('dispatch() extraction finds every expected real verb, including the 2 retired-but-real authoring verbs', () => {
    const expectedReal = [
      'vision confirm',
      'cr confirm',
      'cr realize',
      'req edit',
      'req retire',
      'wp prepare',
      'wp approve-plan',
      'wp abandon',
      'accept',
      'bug resolve',
      'id next',
      'status',
      'goals status',
      'check-goals',
      'one-pager',
      'render',
      'export',
      'validate',
      'fmt',
    ]
    for (const verb of expectedReal) expect(dispatchVerbs.has(verb), `expected dispatch verb '${verb}'`).toBe(true)
    // "Retired" means "unused by the 8 skills" — not fictitious. Confirmed
    // real against the same extraction so a retired-verb typo in this test
    // file itself couldn't slip past the hybrid-enforcement checks below.
    for (const verb of RETIRED_VERBS) expect(dispatchVerbs.has(verb), `expected retired-but-real verb '${verb}'`).toBe(true)
  })

  it('`cr capture`/`req add` are gone outright (Task 8) — replaced by the hybrid Write path, same as `wp author`', () => {
    for (const verb of REMOVED_VERBS) expect(dispatchVerbs.has(verb), `expected '${verb}' to be absent`).toBe(false)
  })

  it('does not invent a verb — a nonsense string is absent', () => {
    expect(dispatchVerbs.has('cr publish')).toBe(false)
    expect(dispatchVerbs.has('wp destroy')).toBe(false)
  })
})

describe('the 9 SKILL.md files — .claude/plugins/praxis-ba/skills/*/SKILL.md', () => {
  // Completeness guard: every it.each in this file iterates SKILL_NAMES, a
  // hand-maintained array — without this check, a 10th skill added on disk
  // but never registered here would silently escape EVERY suite below (the
  // permanent contamination ban above all). Read the real directory listing
  // and require exact set equality, so any new skill fails loudly until it
  // is registered in SKILL_NAMES.
  it('skills/ on disk contains every registered SKILL_NAMES entry (extras allowed)', () => {
    const onDisk = readdirSync(repoRoot(SKILLS_ROOT), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    for (const name of SKILL_NAMES) {
      expect(onDisk, `missing skill dir ${name}`).toContain(name)
    }
  })

  it.each(SKILL_NAMES)('%s/SKILL.md exists', (name) => {
    expect(existsSync(skillPath(name))).toBe(true)
  })

  it.each(SKILL_NAMES)('%s/SKILL.md has valid frontmatter (name + description)', (name) => {
    const { data } = matter(readSkill(name))
    expect(typeof data.name).toBe('string')
    expect((data.name as string).length).toBeGreaterThan(0)
    expect(typeof data.description).toBe('string')
    expect((data.description as string).length).toBeGreaterThan(0)
  })

  it.each(SKILL_NAMES)("%s/SKILL.md's frontmatter name matches its directory", (name) => {
    const { data } = matter(readSkill(name))
    expect(data.name).toBe(name)
  })
})

describe('verb-reality — every `praxis-ba <verb>` mention in a SKILL.md is a real cli.ts dispatch verb', () => {
  it.each(SKILL_NAMES)('%s/SKILL.md mentions at least one real verb, and only real verbs', (name) => {
    const mentions = extractCliVerbMentions(readSkill(name))
    expect(mentions.length, `${name}/SKILL.md names no praxis-ba verb at all`).toBeGreaterThan(0)
    for (const verb of mentions) {
      expect(dispatchVerbs.has(verb), `${name}/SKILL.md mentions unknown verb '${verb}'`).toBe(true)
    }
  })
})

describe('hybrid-enforcement — authoring skills never invoke a retired create verb, and DO instruct the direct-Write pattern', () => {
  it.each(AUTHORING_SKILLS)('%s/SKILL.md never invokes a retired or removed create verb', (name) => {
    const mentions = extractCliVerbMentions(readSkill(name))
    for (const retired of [...RETIRED_VERBS, ...REMOVED_VERBS]) {
      expect(mentions.includes(retired), `${name}/SKILL.md invokes retired/removed verb '${retired}'`).toBe(false)
    }
  })

  it.each(AUTHORING_SKILLS)('%s/SKILL.md instructs a direct Write of a template', (name) => {
    expect(readSkill(name)).toMatch(/\bWrite\b/)
    expect(readSkill(name)).toMatch(/templates\//)
  })

  it.each(AUTHORING_SKILLS)('%s/SKILL.md instructs `id next` to get the id', (name) => {
    expect(extractCliVerbMentions(readSkill(name))).toContain('id next')
  })

  it.each(AUTHORING_SKILLS)('%s/SKILL.md instructs `fmt` after authoring', (name) => {
    expect(extractCliVerbMentions(readSkill(name))).toContain('fmt')
  })

  it.each(AUTHORING_SKILLS)('%s/SKILL.md instructs `validate --check` after authoring', (name) => {
    expect(readSkill(name)).toMatch(/validate --check/)
  })
})

describe('human-gate — every human-gate skill instructs a real human primitive (AskUserQuestion)', () => {
  it.each(HUMAN_GATE_SKILLS)('%s/SKILL.md instructs AskUserQuestion', (name) => {
    expect(readSkill(name)).toMatch(/AskUserQuestion/)
  })
})

describe('status is read-only — never instructs a mutating verb', () => {
  it('status/SKILL.md mentions only read verbs (status/validate/render/export/goals)', () => {
    const mentions = extractCliVerbMentions(readSkill('status'))
    const readVerbs = new Set(['status', 'validate', 'render', 'export', 'goals status', 'check-goals'])
    for (const verb of mentions) expect(readVerbs.has(verb), `status/SKILL.md mentions mutating verb '${verb}'`).toBe(true)
  })
})

describe('capture-cr → grill-cr handoff — capture-cr no longer owns the entry-point gate', () => {
  it('capture-cr/SKILL.md directs to grill-cr as the next step', () => {
    expect(readSkill('capture-cr')).toMatch(/grill-cr/)
  })
})

describe('WP folder shape — prepare-wp and approve-plan both name the v3 folder layout', () => {
  it.each(['prepare-wp', 'approve-plan'] as const)('%s/SKILL.md references both wp/<id>/index.md and wp/<id>/plan.md', (name) => {
    const text = readSkill(name)
    expect(text, `${name}/SKILL.md never mentions wp/<id>/index.md`).toMatch(/wp\/<id>\/index\.md/)
    expect(text, `${name}/SKILL.md never mentions wp/<id>/plan.md`).toMatch(/wp\/<id>\/plan\.md/)
  })
})

// ==========================================================================
// PERMANENT CONTAMINATION BAN (mandate 3, locked forever) — Task 12.
//
// This suite guards the harness-agnostic mandate: the BA canon prepares
// INPUT for development (a confirmed vision / a confirmed CR / a shaped,
// active requirement / a plan-approved WP folder) — it must never assume,
// name, or otherwise couple itself to any SPECIFIC downstream development
// harness, workflow-plugin convention, dev-loop file layout, or model
// vendor. v2 leaked exactly this kind of coupling (references to a specific
// skills plugin, its plan-file convention, a specific model-delegation
// policy, a specific test methodology, a specific device/tooling name) —
// this ban is permanent so a future edit can never silently reintroduce it:
// any skill or template that names one of these patterns fails this suite,
// not just a human review.
// ==========================================================================
const BANNED = [
  /superpowers/i,
  /thoughts\/shared/,
  /brainstorm/i,
  /writing-plans/,
  /subagent/i,
  /\bTDD\b/,
  /\bMetro\b/,
  /\bSonnet\b/,
  /\bOpus\b/,
  /device-gate/i,
]

const BANNED_TEMPLATES = ['cr.md', 'wp.md', 'bug.md'] as const

describe('dev-harness-agnostic — PERMANENT ban (mandate 3): no skill or template names a specific downstream dev harness', () => {
  it.each(SKILL_NAMES)('%s/SKILL.md is dev-harness-agnostic', (name) => {
    const text = readSkill(name)
    for (const pattern of BANNED) expect(text, `${name}/SKILL.md matched banned pattern ${pattern}`).not.toMatch(pattern)
  })

  it.each(BANNED_TEMPLATES)('template %s is dev-harness-agnostic', (file) => {
    const text = readFileSync(repoRoot(`templates/${file}`), 'utf8')
    for (const pattern of BANNED) expect(text, `templates/${file} matched banned pattern ${pattern}`).not.toMatch(pattern)
  })
})
