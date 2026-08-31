// ---- cli.ts: the thin dispatch behind `bin/praxis-ba.mjs` (design spec §4.2,
// §11) — a real arg parser (node:util's `parseArgs`, not v1's naive
// splitter), a `switch` on `cmd (+sub)`, and a `validate` aggregator.
//
// **Testability seam:** `bin/praxis-ba.mjs` is a few-line wrapper around the one
// export here, `runCli(argv, opts)` — every test in `test/cli.test.ts` calls
// this function directly (no spawned process), per the task brief.
//
// **The exit/json contract (§11), one shape for every verb:**
//   `{ id?, path?, verdict: 'VERIFY-OK'|'VERIFY-FAIL', checks: [{name,ok,reason}] }`
// is exactly the `Verdict` shape `types.ts` already pins, plus the two
// optional identity fields. `runCli` never throws: any error from flag
// validation or a verb handler is caught at the top level and folded into a
// single `{ok:false}` check under a synthetic `'error'` name — VERIFY-FAIL,
// exit 1 (§11's own catch-all for a hard failure).
//
// **Exit-code mapping beyond plain VERIFY-OK/FAIL (§11's "2 advisory"):** a
// gate's own `Verdict` (types.ts) only ever carries `ok`, never a severity —
// so verbs that need an advisory-vs-hard distinction (`req retire`'s dangling
// backlink, `validate`'s several soft signals) build their checks through the
// local `toResult` helper below, which tags each check `severity: 'hard'`
// (default) or `'advisory'` for EXIT-CODE PURPOSES ONLY: the tag never leaks
// into the printed/returned `checks[]` (still exactly `{name,ok,reason}`),
// preserving "the Verdict shape IS the json payload" for every verb.
//
// **Why some verbs write canon without a bespoke `writer.ts` mutator:** Task
// 10/11 gave `writer.ts` its mint/edit/retire-a-requirement, mint-an-epic,
// generic FR/NFR/BR status-transition, confirm-vision, and accept mutators;
// `authorWp` (mint-a-WP) was retired (Task 5 — the WP-folder/Scope-body
// layout replaced it with the hybrid `id next` + direct `Write` skill
// pattern), and Task 5 also added two CR-only mutators, `confirmCr`/
// `realizeCrSpawn`. Task 8 rewired `cr confirm` onto `confirmCr` and added
// `cr realize` onto `realizeCrSpawn`, and retired `cr capture`/`req add`
// outright (same hybrid-authoring posture as `wp author` — CR/FR/NFR/BR
// authoring is exclusively `id next` + direct `Write` now, so their old
// inline mint implementations simply have nothing left to be called for).
// There is still no dedicated BUG mutator, and no generic "set a WP's own
// status" mutator (the one WP-status writer, `setWpAccepted`, is
// accept-only and private). Rather than widen `writer.ts` further or
// hand-roll raw `fs` writes here (which WOULD break the single-writer
// invariant), `bug capture/resolve` and the WP-status edges inside `wp
// prepare`/`wp approve-plan`/`wp abandon` compose the SAME exported
// primitives `reconcile.ts` already uses for exactly this reason
// (`atomicWrite`, `crPath`, `emitPage`, `parseFile`, `allocateId`) — every
// byte written by this file still goes through `writer.ts`'s one
// atomic-write mechanics. Flagged in the Task 12 report as a real design gap
// for a future `writer.ts` extension, not silently papered over.
//
// **Determinism / the IO boundary (carried-in note #1):** `writer.ts`/`ids.ts`
// never read the clock; every date-taking call here reads `--date` if given,
// else `todayDate()` (this module's one clock read) — same for `--by`
// (identity) via `currentUser()`. This file is the ONE place in the package
// allowed to do either.

import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs'
import { execSync } from 'node:child_process'
import { userInfo } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { parse as yamlParse } from 'yaml'
import { parseAcBlock } from './ac.js'
import { bodyHasLeadingFrontmatterFence, extractNfrMentions } from './body-refs.js'
import { formatFile, formatText } from './fmt.js'
import { readCanonConfig, walkCanonFiles } from './fs.js'
import { buildGraph, type Graph } from './graph.js'
import type { FrontmatterFor } from './graph.js'
import { definitionOfReady, scopeLinkIssues, scopeVersionIssues, type VerifyEvidence } from './gates.js'
import { checkGoals } from './goals.js'
import { allocateId, maxGuard } from './ids.js'
import { migrate, verifyParity } from './migrate.js'
import { backfillMapSchema, migrateV3, paritySnapshotSchema, verifyParityV3 } from './migrate-v3.js'
import { historyCrRefs } from './history.js'
import { parseFile, parsePage, peekType, type ParsedPage } from './parse.js'
import { crImpactsDelivered, requirementNodeIndex } from './reconcile.js'
import { evaluateBaRules, loadBaRules } from './rules.js'
import { fileURLToPath } from 'node:url'
import {
  baselineManifestSchema,
  crImpactSchema,
  schemas,
  verifyEvidenceSchema,
  BR_ID,
  FR_ID,
  NFR_ID,
  type CrImpact,
} from './schema.js'
import { slugifyHeading } from './scopelinks.js'
import { emitPage, exportBacklog, exportPrd, exportRtm } from './serialize.js'
import { findMissingItems } from './status.js'
import type { NodeType, Status, Check } from './types.js'
import {
  accept,
  addEpic,
  atomicWrite,
  confirmCr,
  crPath,
  editRequirement,
  loadGraph,
  realizeCrSpawn,
  retireRequirement,
  setStatus,
  setVisionConfirmed,
  wpPath,
} from './writer.js'

// ==========================================================================
// public surface
// ==========================================================================

export type CliJson = {
  id?: string
  path?: string
  verdict: 'VERIFY-OK' | 'VERIFY-FAIL'
  checks: Check[]
}

export type CliResult = { code: number; json: CliJson }

/** Thin dispatch: parse flags with `node:util`'s `parseArgs`, switch on
 * `cmd(+sub)`, delegate to one library function per verb, map the result to
 * `{code, json}`. `opts.repo` lets tests skip threading `--repo` through
 * every `argv` array; real CLI use always supplies `--repo` in `argv`
 * itself. Never throws — every path returns a `CliResult`. */
export async function runCli(argv: readonly string[], opts: { repo?: string } = {}): Promise<CliResult> {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    })

    const repo = opts.repo ?? asString(values.repo)
    if (!repo) throw new Error('praxis-ba: --repo <dir> is required')

    const cmd = positionals[0]
    if (!cmd) throw new Error('praxis-ba: no command given')
    const sub = positionals[1]
    const verb = TWO_WORD_COMMANDS.has(cmd) && sub ? `${cmd} ${sub}` : cmd

    return await dispatch(verb, repo, values, positionals)
  } catch (err) {
    return {
      code: 1,
      json: { verdict: 'VERIFY-FAIL', checks: [{ name: 'error', ok: false, reason: message(err) }] },
    }
  }
}

// ==========================================================================
// flag table (node:util's parseArgs — a real parser: typed arity, `strict`
// rejects an unrecognized flag, vs. v1's naive positional splitter)
// ==========================================================================

const TWO_WORD_COMMANDS: ReadonlySet<string> = new Set(['vision', 'cr', 'epic', 'req', 'wp', 'bug', 'id', 'goals'])

type OptionSpec = { type: 'string' | 'boolean'; default?: string | boolean }
const OPTIONS: Record<string, OptionSpec> = {
  repo: { type: 'string' },
  json: { type: 'boolean', default: false },
  'body-file': { type: 'string' },
  check: { type: 'boolean', default: false },
  title: { type: 'string' },
  req: { type: 'string' },
  cr: { type: 'string' },
  activate: { type: 'boolean', default: false },
  wp: { type: 'string' },
  plan: { type: 'string' },
  evidence: { type: 'string' },
  date: { type: 'string' },
  affects: { type: 'string' },
  severity: { type: 'string' },
  status: { type: 'string' },
  'spawn-cr': { type: 'boolean', default: false },
  scope: { type: 'string' },
  what: { type: 'string' },
  entry: { type: 'string' },
  'impacts-file': { type: 'string' },
  spawn: { type: 'string' },
  id: { type: 'string' },
  by: { type: 'string' },
  'head-commit': { type: 'string' },
  reporter: { type: 'string' },
  bug: { type: 'string' },
  out: { type: 'string' },
  rules: { type: 'string' },
  verify: { type: 'boolean', default: false },
  backfill: { type: 'string' },
  'repo-root': { type: 'string' },
}

type FlagValues = Record<string, string | boolean | undefined>

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function requireFlag(v: unknown, msg: string): string {
  const s = asString(v)
  if (!s) throw new Error(msg)
  return s
}

function splitCsv(v: unknown): string[] {
  const s = asString(v)
  return s
    ? s
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x.length > 0)
    : []
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ==========================================================================
// the CLI's own clock/identity reads (the ONE allowed place, per file header)
// ==========================================================================

function todayDate(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

function currentUser(): string {
  try {
    return userInfo().username
  } catch {
    return 'unknown'
  }
}

function gitHeadCommit(repo: string): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim()
  } catch {
    throw new Error(
      'praxis-ba accept: --head-commit was not given and `git rev-parse HEAD` failed under --repo; pass --head-commit explicitly'
    )
  }
}

// ==========================================================================
// result-building — the shared severity/exit-code mechanism (file header)
// ==========================================================================

type SeverityCheck = Check & { severity?: 'advisory' }

function toResult(checks: readonly SeverityCheck[], extra: { id?: string; path?: string } = {}): CliResult {
  const hardFail = checks.some((c) => !c.ok && c.severity !== 'advisory')
  const advisoryFail = checks.some((c) => !c.ok && c.severity === 'advisory')
  const verdict: 'VERIFY-OK' | 'VERIFY-FAIL' = hardFail ? 'VERIFY-FAIL' : 'VERIFY-OK'
  const code = hardFail ? 1 : advisoryFail ? 2 : 0
  const cleanChecks: Check[] = checks.map(({ name, ok, reason }) => ({ name, ok, reason }))
  const json: CliJson = { verdict, checks: cleanChecks }
  if (extra.id) json.id = extra.id
  if (extra.path) json.path = extra.path
  return { code, json }
}

function ok(name: string, reason: string, extra: { id?: string; path?: string } = {}): CliResult {
  return toResult([{ name, ok: true, reason }], extra)
}

// ==========================================================================
// path helpers for entity kinds `writer.ts` doesn't expose a path fn for
// (CR's `crPath` is exported; BUG/WP are not — §5/§6.6/§6.7 layout, mirrored
// here rather than reaching into writer.ts's private helpers)
// ==========================================================================

function bugPath(repo: string, id: string): string {
  return join(repo, 'bugs', `${id}.md`)
}
// `wpPath` itself is imported from writer.js (Task 5's WP-path seam) — no
// private copy here anymore; the folder-form path (`wp/<id>/index.md`) lives
// in exactly one place.

function setWpFrontmatter(repo: string, wpId: string, patch: Record<string, unknown>): { path: string } {
  const path = wpPath(repo, wpId)
  const parsed = parseFile(path, 'wp')
  if ('error' in parsed) throw new Error(`praxis-ba: cannot read WP ${wpId} at ${path}: ${parsed.error}`)
  const fm = parsed.frontmatter as Record<string, unknown>
  const nextFm = { ...fm, ...patch }
  atomicWrite(path, emitPage('wp', nextFm as unknown as FrontmatterFor<'wp'>, parsed.body))
  return { path }
}

function statusOfMember(graph: Graph, id: string): Status | undefined {
  return (
    graph.frs.find((n) => n.frontmatter.id === id)?.frontmatter.status ??
    graph.nfrs.find((n) => n.frontmatter.id === id)?.frontmatter.status ??
    graph.brs.find((n) => n.frontmatter.id === id)?.frontmatter.status
  )
}

function isVisionConfirmed(repo: string): boolean {
  const parsed = parseFile(join(repo, 'vision.md'), 'vision')
  if ('error' in parsed) return false
  return (parsed.frontmatter as { status?: unknown }).status === 'confirmed'
}

/** The directory a WP's `## Scope` links (Task 3's grammar) resolve
 * against: `<repo>/.ba/config.yaml`'s optional `link_root` when set, else
 * the repo directory's own basename — the real `product/` repo has
 * `link_root: product` explicitly configured (set by the v3 migration), so
 * its Scope links resolve as `product/...` (the canon root's own folder
 * name), matching how those links actually render from the monorepo root
 * (schema.ts's `configSchema` header comment). */
function resolveLinkRoot(repo: string): string {
  return readCanonConfig(repo)?.link_root ?? basename(resolve(repo))
}

// ==========================================================================
// dispatch
// ==========================================================================

async function dispatch(verb: string, repo: string, values: FlagValues, positionals: readonly string[]): Promise<CliResult> {
  switch (verb) {
    case 'vision confirm': {
      const by = asString(values.by) ?? currentUser()
      const date = asString(values.date) ?? todayDate()
      const { path } = await setVisionConfirmed(repo, by, date)
      return ok('vision-confirm', `vision confirmed by ${by} on ${date}`, { path })
    }

    // `cr capture` was retired (Task 8) — CR authoring is exclusively the
    // hybrid `id next` + direct `Write` skill pattern now (same posture as
    // `wp author`'s Task 5 retirement); `writer.ts` never grew a bespoke
    // mint-a-CR mutator to replace this inline implementation, so there is
    // nothing left to rewire it onto.

    case 'cr confirm': {
      const crId = requireFlag(values.cr, 'cr confirm: --cr <id> is required')
      const entry = requireFlag(values.entry, 'cr confirm: --entry <level> is required')
      if (entry !== 'vision' && entry !== 'requirement') {
        throw new Error(`cr confirm: --entry must be vision|requirement, got '${entry}'`)
      }
      const impactsFile = asString(values['impacts-file'])
      let impacts: CrImpact[] | undefined
      if (impactsFile !== undefined) {
        const raw: unknown = JSON.parse(readFileSync(impactsFile, 'utf8'))
        impacts = z.array(crImpactSchema).parse(raw)
      }
      const { path } = await confirmCr(repo, { crId, entry, impacts })
      return ok('cr-confirm', `${crId} confirmed (entry: ${entry})`, { id: crId, path })
    }

    case 'cr realize': {
      const crId = requireFlag(values.cr, 'cr realize: --cr <id> is required')
      const spawnSpec = requireFlag(values.spawn, 'cr realize: --spawn <E#>:<fr|nfr|br> is required')
      const newId = requireFlag(values.id, 'cr realize: --id <new-id> is required')
      const m = /^(E\d+):(fr|nfr|br)$/.exec(spawnSpec)
      if (!m) {
        throw new Error(`cr realize: --spawn must look like <epic>:<fr|nfr|br> (e.g. E2:fr), got '${spawnSpec}'`)
      }
      // Non-null: the regex has exactly two unconditional capture groups.
      const epic = m[1]!
      const type = m[2]! as 'fr' | 'nfr' | 'br'
      const { path } = await realizeCrSpawn(repo, { crId, epic, type, newId })
      return ok('cr-realize', `${crId} realized its '${type}' spawn under ${epic} as ${newId}`, { id: crId, path })
    }

    case 'epic add': {
      const title = requireFlag(values.title, 'epic add: --title <t> is required')
      const { id } = await addEpic(repo, title)
      return ok('epic-add', `minted ${id}`, { id })
    }

    // `req add` was retired (Task 8) — same posture as `cr capture`: FR/NFR/BR
    // authoring is exclusively the hybrid `id next` + direct `Write` skill
    // pattern now. `writer.ts`'s `addRequirement` mutator ITSELF is untouched
    // (still used directly by `writer.test.ts`) — only this CLI verb is gone.

    case 'req edit': {
      const id = requireFlag(values.req, 'req edit: --req <id> is required')
      const bodyFile = requireFlag(values['body-file'], 'req edit: --body-file <path> is required')
      const body = readFileSync(bodyFile, 'utf8')
      const cr = asString(values.cr)
      const activate = values.activate === true
      const date = asString(values.date) ?? todayDate()
      const { path, bumped } = await editRequirement(repo, { id, body, cr, activate, date })
      return ok('req-edit', `updated ${id}${bumped ? ' (version bumped)' : ''}`, { id, path })
    }

    case 'req retire': {
      const id = requireFlag(values.req, 'req retire: --req <id> is required')
      const { path } = await retireRequirement(repo, id)
      const graph = loadGraph(repo)
      const backlinks = graph.backlinks(id)
      const checks: SeverityCheck[] = [{ name: 'req-retire', ok: true, reason: `retired ${id}` }]
      checks.push(
        backlinks.length === 0
          ? { name: 'dangling-backlinks', ok: true, reason: 'no other page references the retired id' }
          : {
              name: 'dangling-backlinks',
              ok: false,
              reason: `${id} is retired but still referenced by ${backlinks.join(', ')}`,
              severity: 'advisory',
            }
      )
      return toResult(checks, { id, path })
    }

    case 'wp prepare':
      return wpPrepare(repo, requireFlag(values.wp, 'wp prepare: --wp <id> is required'))

    case 'wp approve-plan': {
      const wpId = requireFlag(values.wp, 'wp approve-plan: --wp <id> is required')
      const plan = requireFlag(values.plan, 'wp approve-plan: --plan <path> is required')
      // v3 (Task 8): `--plan` is no longer any path — it must be the
      // canon-relative convention `wp/<wpId>/plan.md` (matching `wpPath`'s
      // own folder-per-item layout), so a plan can never be approved sitting
      // somewhere else in — or entirely outside — the canon repo.
      const expectedPlan = `wp/${wpId}/plan.md`
      if (plan !== expectedPlan) {
        throw new Error(`wp approve-plan: --plan must be the canon-relative path '${expectedPlan}', got '${plan}'`)
      }
      const planAbsPath = join(repo, plan)
      if (!existsSync(planAbsPath)) {
        return toResult([{ name: 'plan-exists', ok: false, reason: `${planAbsPath} does not exist` }], { id: wpId })
      }
      const path = wpPath(repo, wpId)
      const parsed = parseFile(path, 'wp')
      if ('error' in parsed) throw new Error(`wp approve-plan: cannot read ${wpId}: ${parsed.error}`)
      const fm = parsed.frontmatter as Record<string, unknown>
      if (fm.status !== 'ready') {
        throw new Error(`wp approve-plan: ${wpId} status is '${String(fm.status)}', expected 'ready'`)
      }
      // Hard gate: structural + semantic validation must execute and PASS
      // before plan-approved. Use the same check set as `validate` (not
      // `--check` round-trip/idempotency extras). Never soft-downgrade.
      const validation = await validate(repo, false)
      if (validation.code !== 0) {
        return {
          code: 1,
          json: {
            id: wpId,
            verdict: 'VERIFY-FAIL',
            checks: [
              {
                name: 'pre-approve-validate',
                ok: false,
                reason: 'wp approve-plan blocked: praxis-ba validate must PASS before plan-approved',
              },
              ...validation.json.checks,
            ],
          },
        }
      }
      setWpFrontmatter(repo, wpId, { status: 'plan-approved', plan })
      return ok('wp-approve-plan', `${wpId} is plan-approved (plan: ${plan})`, { id: wpId, path })
    }

    case 'wp abandon':
      return wpAbandon(repo, requireFlag(values.wp, 'wp abandon: --wp <id> is required'))

    case 'accept': {
      const wpId = requireFlag(values.wp, 'accept: --wp <id> is required')
      const evidencePath = requireFlag(values.evidence, 'accept: --evidence <path> is required')
      const date = asString(values.date) ?? todayDate()
      const evidence: VerifyEvidence = verifyEvidenceSchema.parse(JSON.parse(readFileSync(evidencePath, 'utf8')))
      const headCommit = asString(values['head-commit']) ?? gitHeadCommit(repo)
      const verdict = await accept(repo, wpId, evidence, date, headCommit)
      const code = verdict.verdict === 'VERIFY-OK' ? 0 : 1
      return { code, json: { id: wpId, verdict: verdict.verdict, checks: verdict.checks } }
    }

    case 'bug capture': {
      const affects = splitCsv(values.affects)
      if (affects.length === 0) throw new Error('bug capture: --affects <id> is required')
      const severity = requireFlag(values.severity, 'bug capture: --severity <s> is required')
      const bodyFile = requireFlag(values['body-file'], 'bug capture: --body-file <path> is required')
      const body = readFileSync(bodyFile, 'utf8')
      const date = asString(values.date) ?? todayDate()
      const reporter = asString(values.reporter) ?? currentUser()
      const id = await allocateId(repo, { kind: 'bug' })
      const path = bugPath(repo, id)
      const frontmatter = { id, type: 'bug' as const, status: 'open' as const, severity, affects, reported: date, reporter }
      atomicWrite(path, emitPage('bug', frontmatter as unknown as FrontmatterFor<'bug'>, body))
      return ok('bug-capture', `minted ${id} (status: open)`, { id, path })
    }

    case 'bug resolve':
      return bugResolve(repo, values)

    case 'id next':
      return idNext(repo, requireFlag(values.scope, 'id next: --scope <spec> is required'), asString(values.date))

    case 'status':
      return statusSummary(repo)

    case 'goals status':
    case 'check-goals':
      return goalsStatus(repo)

    case 'rules-lint':
      return rulesLint(repo, asString(values.rules))

    case 'render':
    case 'export':
      return renderView(repo, asString(values.what))

    case 'migrate': {
      // `--repo` is the v1 SOURCE dir here (not a v2 canon repo to load) —
      // `migrate`/`verifyParity` (migrate.ts, Task 13) both read v1 JSON
      // straight off disk, so `repo` is threaded through unchanged as
      // `v1Dir`. `--out` is the v2 md canon destination, required for both
      // the plain run and `--verify` (parity has no meaning without an
      // output to check against). Neither function reads the clock or takes
      // a `--date` — every date comes from the v1 JSON's own date fields
      // (migrate.ts's file header) — so no date flag is threaded here.
      const outDir = requireFlag(values.out, 'migrate: --out <dir> is required')
      if (values.verify === true) {
        const verdict = verifyParity(repo, outDir)
        // `verifyParity`'s checks (migrate.ts) never carry a `severity` tag —
        // there is no advisory distinction to make here, so this mirrors
        // `accept`'s own plain OK->0/FAIL->1 mapping (the other verb that
        // consumes a raw imported `Verdict` rather than building one through
        // `toResult`), not `validate`'s advisory->2 aggregator behavior.
        const code = verdict.verdict === 'VERIFY-OK' ? 0 : 1
        return { code, json: { verdict: verdict.verdict, checks: verdict.checks } }
      }
      const { written } = migrate(repo, outDir)
      return ok('migrate', `wrote ${written.length} file(s) under ${outDir}`, { path: outDir })
    }

    // `migrate-v3` (Task 9, moved here from Task 8's own scope): `--repo` IS
    // the v2 canon dir here (unlike `migrate` above, which treats it as the
    // v1 SOURCE) — `migrateV3`/`verifyParityV3` both transform/verify IN
    // PLACE. `--repo-root` defaults to `resolve(repo, '..')` (the real
    // monorepo shape: `canonDir` = `product/`, `repoRoot` = its parent) —
    // `git mv` (migrate-v3.ts's own plan/WP-file moves) needs the actual git
    // root, not the canon subdirectory. `--verify` reads the durable
    // pre-migration snapshot `migrateV3` itself wrote as its first step
    // (`<repo>/.ba/cache/migrate-v3-snapshot.json`) — snapshot-based parity
    // is the only option once the transform has already run in place (see
    // migrate-v3.ts's own header for why). `--date` feeds ONLY the plain-run
    // path's final reconcile step (never `--verify`, which reads no clock at
    // all) — defaults to `todayDate()`, this file's one clock read, exactly
    // like every other date-taking verb.
    case 'migrate-v3': {
      const repoRoot = asString(values['repo-root']) ?? resolve(repo, '..')
      if (values.verify === true) {
        const snapshotPath = join(repo, '.ba', 'cache', 'migrate-v3-snapshot.json')
        const snapshot = paritySnapshotSchema.parse(JSON.parse(readFileSync(snapshotPath, 'utf8')))
        const verdict = verifyParityV3(snapshot, repo, repoRoot)
        const code = verdict.verdict === 'VERIFY-OK' ? 0 : 1
        return { code, json: { verdict: verdict.verdict, checks: verdict.checks } }
      }
      const backfillPath = requireFlag(values.backfill, 'migrate-v3: --backfill <path> is required')
      const backfill = backfillMapSchema.parse(JSON.parse(readFileSync(backfillPath, 'utf8')))
      const date = asString(values.date) ?? todayDate()
      const { written, moved, advisories } = migrateV3(repo, repoRoot, backfill, date)
      const checks: SeverityCheck[] = [
        { name: 'migrate-v3', ok: true, reason: `wrote ${written.length} file(s), moved ${moved.length} file(s)` },
      ]
      if (advisories.length > 0) {
        checks.push({ name: 'migrate-v3-advisories', ok: false, reason: advisories.join('; '), severity: 'advisory' })
      }
      return toResult(checks, { path: repo })
    }

    case 'validate':
      return validate(repo, values.check === true)

    case 'fmt':
      return fmtCommand(repo, positionals.slice(1), values.check === true)

    case 'baseline':
      // Deliberate omission (design spec §4.2): the only code path that ever
      // writes a `baselines/BL-.../` dir is the `accept` handler.
      throw new Error("praxis-ba: there is no standalone 'baseline' verb — only 'accept' writes baselines")

    default:
      throw new Error(`praxis-ba: unknown command '${verb}'`)
  }
}

// ==========================================================================
// wp prepare / wp abandon — the WP-status edges writer.ts doesn't expose a
// generic mutator for (file header) — composed from `setStatus` (fr/nfr/br,
// already generic) + `setWpFrontmatter` (this file's own WP-only primitive).
// ==========================================================================

async function wpPrepare(repo: string, wpId: string): Promise<CliResult> {
  const graph = loadGraph(repo)
  const wp = graph.wps.find((w) => w.frontmatter.id === wpId)
  // Carried-in note #3 / progress.md Task 9: definitionOfReady passes
  // vacuously on an empty/unknown WP closure — this guard is the deferred
  // call-site check, run BEFORE the gate.
  if (!wp || graph.wpDelivers(wpId).length === 0) {
    return toResult([
      { name: 'wp-resolves', ok: false, reason: `${wpId}: WP not found or its Scope lists no Delivers FR (empty closure)` },
    ], { id: wpId })
  }

  const verdict = definitionOfReady(graph, wpId, isVisionConfirmed(repo), { linkRoot: resolveLinkRoot(repo) })
  if (verdict.verdict === 'VERIFY-FAIL') {
    return { code: 1, json: { id: wpId, verdict: verdict.verdict, checks: verdict.checks } }
  }

  const closure = graph.closure(wpId)
  const memberIds = [...new Set<string>([...closure.frs, ...closure.nfrs, ...closure.brs])]
  for (const id of memberIds) {
    const status = statusOfMember(graph, id)
    if (status === 'draft' || status === 'active') await setStatus(repo, id, 'batched')
  }
  setWpFrontmatter(repo, wpId, { status: 'ready' })

  return { code: 0, json: { id: wpId, verdict: verdict.verdict, checks: verdict.checks } }
}

async function wpAbandon(repo: string, wpId: string): Promise<CliResult> {
  const graph = loadGraph(repo)
  const wp = graph.wps.find((w) => w.frontmatter.id === wpId)
  if (!wp) return toResult([{ name: 'wp-resolves', ok: false, reason: `${wpId}: WP not found` }], { id: wpId })

  const closure = graph.closure(wpId)
  const memberIds = [...new Set<string>([...closure.frs, ...closure.nfrs, ...closure.brs])]
  for (const id of memberIds) {
    // Only a still-`batched` member reverts; an already-`baselined` shared
    // item (accepted by a different WP in the meantime) is untouched — the
    // legal-transition matrix in writer.ts would reject baselined->active
    // anyway, but this filter avoids ever attempting it.
    if (statusOfMember(graph, id) === 'batched') await setStatus(repo, id, 'active')
  }
  setWpFrontmatter(repo, wpId, { status: 'abandoned' })
  return ok('wp-abandon', `${wpId} abandoned; batched members reverted to active`, { id: wpId })
}

async function bugResolve(repo: string, values: FlagValues): Promise<CliResult> {
  const id = requireFlag(values.bug, 'bug resolve: --bug <id> is required')
  const status = requireFlag(values.status, 'bug resolve: --status fixed|wontfix|duplicate is required')
  if (status !== 'fixed' && status !== 'wontfix' && status !== 'duplicate') {
    throw new Error(`bug resolve: --status must be fixed|wontfix|duplicate, got '${status}'`)
  }
  const path = bugPath(repo, id)
  const parsed = parseFile(path, 'bug')
  if ('error' in parsed) throw new Error(`bug resolve: cannot read ${id}: ${parsed.error}`)
  const fm = parsed.frontmatter as Record<string, unknown>
  const nextFm: Record<string, unknown> = { ...fm, status }
  let spawnedCr: string | undefined
  if (values['spawn-cr'] === true) {
    spawnedCr = await allocateId(repo, { kind: 'cr' })
    atomicWrite(
      crPath(repo, spawnedCr),
      emitPage('cr', { id: spawnedCr, type: 'cr', status: 'captured' } as unknown as FrontmatterFor<'cr'>, `Spawned from ${id}.\n`)
    )
    nextFm.spawned_cr = spawnedCr
  }
  atomicWrite(path, emitPage('bug', nextFm as unknown as FrontmatterFor<'bug'>, parsed.body))
  return ok('bug-resolve', `${id} -> ${status}${spawnedCr ? ` (spawned ${spawnedCr})` : ''}`, { id, path })
}

/** Mints (and PERSISTS — via `allocateId`'s locked, atomic ledger bump) the
 * next id for `scopeSpec`. This is the real allocation, not a preview: a
 * second `id next` for the same scope returns the NEXT id, never the same
 * one — the hybrid write-path (skills `Write` the page themselves after this
 * call) needs a persisting mint, not a computed guess, or two same-scope
 * mints in one session would collide and `validate`'s id-max-guard would
 * trip on every mint (the bug this function exists to fix). `wp` still
 * requires `--date` (`allocateId` enforces the compile-time contract; the
 * runtime check here just produces a clean `id next`-scoped error message
 * before hitting it). */
async function idNext(repo: string, scopeSpec: string, date: string | undefined): Promise<CliResult> {
  const [kind, epic] = scopeSpec.split(':')
  let id: string
  switch (kind) {
    case 'epic':
    case 'cr':
    case 'bug':
      id = await allocateId(repo, { kind })
      break
    case 'wp': {
      if (date === undefined) throw new Error("id next: scope 'wp' requires --date <YYYYMMDD>")
      id = await allocateId(repo, { kind: 'wp' }, date)
      break
    }
    case 'fr':
    case 'nfr':
    case 'br': {
      if (!epic) throw new Error(`id next: scope '${kind}' requires an epic, e.g. --scope ${kind}:E1`)
      id = await allocateId(repo, { kind, epic })
      break
    }
    default:
      throw new Error(`id next: unrecognized scope '${scopeSpec}'`)
  }
  return ok('id-next', id)
}

function statusSummary(repo: string): CliResult {
  const graph = loadGraph(repo)
  const countBy = (nodes: readonly { frontmatter: { status: string } }[]): string => {
    const m = new Map<string, number>()
    for (const n of nodes) m.set(n.frontmatter.status, (m.get(n.frontmatter.status) ?? 0) + 1)
    return [...m.entries()].map(([s, c]) => `${s}:${c}`).join(', ') || 'none'
  }
  const missing = findMissingItems(graph)
  const byKind = new Map<string, string[]>()
  for (const item of missing) {
    const list = byKind.get(item.kind) ?? []
    list.push(`${item.id}: ${item.detail}`)
    byKind.set(item.kind, list)
  }
  const checks: SeverityCheck[] = [
    { name: 'epics', ok: true, reason: `${graph.epics.length} epic(s)` },
    { name: 'frs', ok: true, reason: countBy(graph.frs) },
    { name: 'nfrs', ok: true, reason: countBy(graph.nfrs) },
    { name: 'brs', ok: true, reason: countBy(graph.brs) },
    { name: 'crs', ok: true, reason: countBy(graph.crs) },
    { name: 'wps', ok: true, reason: countBy(graph.wps) },
    { name: 'bugs', ok: true, reason: countBy(graph.bugs) },
    { name: 'goals', ok: true, reason: countBy(graph.goals) },
  ]
  const missingKinds = [
    'requirement-without-ac',
    'requirement-unverifiable-ac',
    'requirement-not-linked-to-wp',
    'requirement-without-goal',
    'goal-without-requirements',
  ] as const
  for (const kind of missingKinds) {
    const list = byKind.get(kind) ?? []
    checks.push({
      name: `missing:${kind}`,
      ok: list.length === 0,
      reason: list.length === 0 ? 'none' : list.join('; '),
      severity: 'advisory',
    })
  }
  return toResult(checks)
}

function goalsStatus(repo: string): CliResult {
  const graph = loadGraph(repo)
  const result = checkGoals(graph)
  const checks: SeverityCheck[] = [
    {
      name: 'requirements-without-goals',
      ok: result.requirementsWithoutGoals.length === 0,
      reason:
        result.requirementsWithoutGoals.length === 0
          ? 'every open requirement cites at least one goal'
          : result.requirementsWithoutGoals.join(', '),
      severity: 'advisory',
    },
    {
      name: 'goals-without-requirements',
      ok: result.goalsWithoutRequirements.length === 0,
      reason:
        result.goalsWithoutRequirements.length === 0
          ? 'every open goal is cited by at least one requirement'
          : result.goalsWithoutRequirements.join(', '),
      severity: 'advisory',
    },
  ]
  return toResult(checks)
}

function rulesLint(repo: string, rulesDirFlag?: string): CliResult {
  const graph = loadGraph(repo)
  const pluginRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
  const rulesDir = rulesDirFlag ?? join(pluginRoot, 'rules')
  const loadErrors: string[] = []
  const rules = loadBaRules(rulesDir, loadErrors)
  const violations = evaluateBaRules(rules, graph)
  const checks: SeverityCheck[] = [
    {
      name: 'rules-loaded',
      ok: loadErrors.length === 0,
      reason:
        loadErrors.length === 0
          ? `${rules.length} rule file(s) from ${rulesDir}`
          : loadErrors.join('; '),
      severity: 'advisory',
    },
  ]
  if (violations.length === 0) {
    checks.push({ name: 'rules-violations', ok: true, reason: 'none' })
  } else {
    for (const v of violations) {
      checks.push({
        name: `rule:${v.ruleId}:${v.targetId}`,
        ok: false,
        reason: v.message,
        severity: v.severity === 'advisory' ? 'advisory' : undefined,
      })
    }
  }
  return toResult(checks)
}

function renderView(repo: string, what: string | undefined): CliResult {
  const graph = loadGraph(repo)
  const view = what ?? 'prd'
  let text: string
  switch (view) {
    case 'prd':
      text = exportPrd(graph)
      break
    case 'rtm':
      text = exportRtm(graph)
      break
    case 'backlog':
      text = exportBacklog(graph)
      break
    default:
      throw new Error(`render: unknown --what '${view}' (expected prd|rtm|backlog)`)
  }
  // Never writes canon (design spec §4.2) — the rendered text rides in the
  // one check's `reason` so every verb keeps the same `{verdict,checks}`
  // envelope (file header); `bin/praxis-ba.mjs` prints it raw in non-`--json`
  // mode.
  return ok(view, text)
}

// ==========================================================================
// validate — the aggregator (design spec §11, §8a's partial-state predicate,
// §12's provenance:migrated grandfather clause, §9's --check guardrails)
// ==========================================================================

type ValidWalk = { path: string; type: NodeType; parsed: ParsedPage }
type InvalidWalk = { path: string; type?: string; error: string }
type Walk = ValidWalk | InvalidWalk

/** `.md` pages this verb walks: `fs.ts`'s `walkCanonFiles` — scoped to
 * `<repo>/.ba/config.yaml`'s `canon_roots` when present (so real `product/`
 * prose docs living alongside the canon are never mistaken for it), else
 * the whole repo minus `.ba/`+`baselines/` (the original default). Was a
 * private, duplicated `walkMdFiles` here (and in writer.ts/fmt.ts) before
 * the canon-path-scoping consolidation. */
function walkCorpus(repo: string): Walk[] {
  const files = walkCanonFiles(repo)
  const results: Walk[] = []
  for (const file of files) {
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch (err) {
      results.push({ path: file, error: message(err) })
      continue
    }
    const type = peekType(raw)
    if (type === undefined || !(type in schemas)) {
      results.push({ path: file, type, error: "unrecognized or missing 'type' field" })
      continue
    }
    const parsed = parsePage(raw, type as NodeType)
    if ('error' in parsed) {
      results.push({ path: file, type, error: parsed.error })
      continue
    }
    results.push({ path: file, type: type as NodeType, parsed })
  }
  return results
}

function isValid(w: Walk): w is ValidWalk {
  return 'parsed' in w
}

type BaselineManifest = ReturnType<typeof baselineManifestSchema.parse>

/** Reads every `baselines/BL-.../manifest.yaml`. A manifest that fails to
 * parse/validate is reported as a schema error (folded into `schema-valid`)
 * rather than silently dropped — an absent manifest (no directory / no file)
 * is the ordinary, expected case and is not an error here (that's the
 * accept partial-state predicate's job, driven off each item's own
 * `baseline:` field instead). */
function readBaselineManifests(repo: string): { manifests: BaselineManifest[]; errors: string[] } {
  const dir = join(repo, 'baselines')
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return { manifests: [], errors: [] }
  }
  const manifests: BaselineManifest[] = []
  const errors: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(dir, entry.name, 'manifest.yaml')
    let raw: string
    try {
      raw = readFileSync(manifestPath, 'utf8')
    } catch {
      continue
    }
    try {
      manifests.push(baselineManifestSchema.parse(yamlParse(raw)))
    } catch (err) {
      errors.push(`${manifestPath}: ${message(err)}`)
    }
  }
  return { manifests, errors }
}

/** The accept crash-safety partial-state predicate (design spec §8a): any
 * item claiming `baseline: BL-X` whose `baselines/BL-X/manifest.yaml` is
 * absent, or present but doesn't list the item in `items[]`, is a hard
 * failure — the on-disk signature of an accept transaction that crashed
 * before its manifest write (or was hand-tampered with afterwards). */
function partialStateViolations(repo: string, pages: readonly ParsedPage[]): string[] {
  const violations: string[] = []
  for (const page of pages) {
    const fm = page.frontmatter as Record<string, unknown>
    const baseline = typeof fm.baseline === 'string' ? fm.baseline : undefined
    const id = typeof fm.id === 'string' ? fm.id : undefined
    if (!baseline || !id) continue
    const manifestPath = join(repo, 'baselines', baseline, 'manifest.yaml')
    let raw: string
    try {
      raw = readFileSync(manifestPath, 'utf8')
    } catch {
      violations.push(`${id}: claims baseline ${baseline} but ${manifestPath} is absent`)
      continue
    }
    let manifest: BaselineManifest
    try {
      manifest = baselineManifestSchema.parse(yamlParse(raw))
    } catch (err) {
      violations.push(`${id}: ${manifestPath} failed schema validation: ${message(err)}`)
      continue
    }
    if (!manifest.items.some((item) => item.id === id)) {
      violations.push(`${id}: baseline ${baseline}'s manifest.yaml does not list it in items[]`)
    }
  }
  return violations
}

/** An orphaned write-ahead pending marker (writer.ts's crash-safety
 * mechanism, §8a) left over from an interrupted `accept` — self-heals on the
 * next `accept` invocation for that WP, so this is reported as advisory, not
 * hard (progress.md's Task 11 carried note flags it as "a partial-state
 * signal" without pinning severity; treated the same class as the other
 * soft/operational advisories in §11's list, e.g. a stale-lock force-break). */
function orphanedPendingMarkers(repo: string): string[] {
  const dir = join(repo, '.ba', 'cache')
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.filter((e) => e.isFile() && e.name.startsWith('pending-') && e.name.endsWith('.json')).map((e) => e.name)
}

function frontmatterBlock(raw: string): string | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw)
  return m?.[1]
}

/** §9's guardrail (a): `emit(parse(f)) == f`'s frontmatter block, diffed
 * against the committed file on disk (a real round-trip against canon, not
 * just an in-memory property). */
function roundTripViolations(valid: readonly ValidWalk[]): string[] {
  const violations: string[] = []
  for (const w of valid) {
    const raw = readFileSync(w.path, 'utf8')
    const original = frontmatterBlock(raw)
    const reEmitted = frontmatterBlock(emitPage(w.type, w.parsed.frontmatter as FrontmatterFor<typeof w.type>, w.parsed.body))
    if (original !== reEmitted) violations.push(w.path)
  }
  return violations
}

/** §9's guardrail (b): derived-view idempotency `render(x) == render(x)` —
 * no committed view exists to diff against (per Q9), so this is exactly the
 * in-memory property the design doc pins, not a stronger claim. */
function derivedViewsIdempotent(graph: Graph): boolean {
  return (
    exportPrd(graph) === exportPrd(graph) &&
    exportRtm(graph) === exportRtm(graph) &&
    exportBacklog(graph) === exportBacklog(graph)
  )
}

// ==========================================================================
// v3 (Task 8) — five new `validate` checks. Each reuses an already-exported
// pure helper (gates.ts's `scopeLinkIssues`/`scopeVersionIssues`,
// reconcile.ts's `requirementNodeIndex`/`crImpactsDelivered`) rather than
// re-deriving the same integrity logic a second time — see this file's
// header note on why `cr capture`/`bug capture`/the WP-status edges below
// still compose writer.ts's primitives instead of a bespoke mutator; the
// SAME "don't duplicate a rule, reuse the exported function" posture applies
// here to gates.ts/reconcile.ts's own predicates.
// ==========================================================================

/** `wp-scope-links`: every WP's Scope link set, corpus-wide — the exact same
 * per-WP integrity rule `definitionOfReady`'s own `wp-scope-links` check
 * enforces at `wp prepare` time (gates.ts's `scopeLinkIssues`), just run
 * against EVERY WP in the corpus rather than one `wp prepare` call's target. */
function wpScopeLinkIssues(graph: Graph, linkRoot: string): string[] {
  const issues: string[] = []
  for (const wp of graph.wps) {
    for (const issue of scopeLinkIssues(graph, wp.frontmatter.id, linkRoot)) {
      issues.push(`${wp.frontmatter.id}: ${issue}`)
    }
  }
  return issues
}

/** `wp-scope-version-current`: same underlying rule (gates.ts's
 * `scopeVersionIssues`) as `definitionOfReady`'s own check, but SKIPPED for
 * a WP in either TERMINAL "done" state — `accepted` OR `abandoned` (finding
 * #9). Both are a historical record of what the WP referenced, not a live
 * intent: a later version bump on the SAME requirement (by a different WP)
 * legitimately leaves an old WP's stamp "stale" without that being a defect
 * in the old WP itself — the exact rationale `serialize.ts`'s `exportBacklog`
 * already applies when it treats `accepted`/`abandoned` as the same
 * no-longer-open class. */
function wpScopeVersionCurrentIssues(graph: Graph): string[] {
  const issues: string[] = []
  for (const wp of graph.wps) {
    if (wp.frontmatter.status === 'accepted' || wp.frontmatter.status === 'abandoned') continue
    for (const issue of scopeVersionIssues(graph, wp.frontmatter.id)) {
      issues.push(`${wp.frontmatter.id}: ${issue}`)
    }
  }
  return issues
}

/** `cr-impacts-present`: every `status: confirmed` CR with
 * `entry_point: requirement` must carry a non-empty `impacts` set, and every
 * entry must resolve (`amends` against a real FR/NFR/BR id; `spawns.epic`
 * against a real epic id) — the corpus-wide, always-on version of the
 * one-shot check `confirmCr` itself already runs at confirm time (writer.ts).
 * A `vision`-entry CR is exempt (impacts are a requirement-entry concept);
 * `captured`/`resolved` CRs are exempt too (this check is specifically about
 * the CONFIRMED state a requirement-entry CR must never be left in without
 * its impact set). */
function crImpactsPresentIssues(graph: Graph): string[] {
  const issues: string[] = []
  const reqIds = new Set<string>([
    ...graph.frs.map((n) => n.frontmatter.id),
    ...graph.nfrs.map((n) => n.frontmatter.id),
    ...graph.brs.map((n) => n.frontmatter.id),
  ])
  const epicIds = new Set<string>(graph.epics.map((e) => e.frontmatter.id))
  for (const cr of graph.crs) {
    const fm = cr.frontmatter
    if (fm.status !== 'confirmed' || fm.entry_point !== 'requirement') continue
    const impacts = fm.impacts ?? []
    if (impacts.length === 0) {
      issues.push(`${fm.id}: confirmed requirement-entry CR has an empty impacts set`)
      continue
    }
    for (const impact of impacts) {
      if ('amends' in impact) {
        if (!reqIds.has(impact.amends)) issues.push(`${fm.id}: impact amends '${impact.amends}', which does not resolve`)
      } else if (!epicIds.has(impact.epic)) {
        issues.push(`${fm.id}: impact spawns a '${impact.spawns}' under epic '${impact.epic}', which does not resolve`)
      }
    }
  }
  return issues
}

/** `cr-impacts-consistent`: three rules, corpus-wide —
 *   1. every ALREADY-`realized` spawn's id must both exist AND (for a
 *      fr/nfr spawn — a br spawn has no `traces_to` field) have that id's
 *      OWN `traces_to` include the citing CR, proving the trace-back
 *      `realizeCrSpawn` itself checks at write time still holds later. The
 *      traces_to half is provenance-gated exactly like rule 3's predicate
 *      (Task 9b): a `provenance: backfilled` CR's realized spawn carries no
 *      trace-back by migration design, so only the id-resolution (existence)
 *      half applies to it — a realized id pointing at nothing is a hard
 *      error regardless of provenance;
 *   2. (findings #5/#8 mirror) a realized id's OWN shape must match the
 *      impact's declared `spawns` type, and its OWN epic prefix must match
 *      the impact's declared `epic` — `realizeCrSpawn` enforces both at
 *      write time, but migrate-v3.ts's direct backfill-map write bypasses it
 *      entirely, so this is validate's independent, corpus-wide cross-check.
 *      Never provenance-gated: this is internal self-consistency (does the
 *      CR's own record even make sense?), not "proof of trace-back";
 *   3. every `resolved` CR must satisfy `reconcile.ts`'s OWN resolution
 *      predicate (`crImpactsDelivered`, provenance-gated per that module's
 *      header comment — Task 9b) — a `resolved` CR whose impacts AREN'T (or
 *      no longer are) all delivered is the sign of a hand-edited or
 *      corrupted status that `reconcileCrs` itself would never have set. */
function crImpactsConsistentIssues(graph: Graph): string[] {
  const issues: string[] = []
  const nodeOf = requirementNodeIndex(graph)
  for (const cr of graph.crs) {
    const crId = cr.frontmatter.id
    const impacts = cr.frontmatter.impacts ?? []
    const backfilled = cr.frontmatter.provenance === 'backfilled'
    for (const impact of impacts) {
      if (!('spawns' in impact) || impact.realized === undefined) continue
      const node = nodeOf(impact.realized)
      if (!node) {
        issues.push(`${crId}: realized id '${impact.realized}' does not resolve to a FR/NFR/BR`)
        continue
      }
      const realizedType = FR_ID.test(impact.realized)
        ? 'fr'
        : NFR_ID.test(impact.realized)
          ? 'nfr'
          : BR_ID.test(impact.realized)
            ? 'br'
            : undefined
      if (realizedType !== undefined && realizedType !== impact.spawns) {
        issues.push(`${crId}: realized id '${impact.realized}' is a '${realizedType}', but the impact declares spawns '${impact.spawns}'`)
      }
      const realizedEpic = /^(E\d+)-/.exec(impact.realized)?.[1]
      if (realizedEpic !== undefined && realizedEpic !== impact.epic) {
        issues.push(
          `${crId}: realized id '${impact.realized}'s epic ('${realizedEpic}') does not match the impact's declared epic '${impact.epic}'`
        )
      }
      if (backfilled) continue // no trace-back to demand — see doc comment rule 1
      const traces = 'traces_to' in node.frontmatter ? node.frontmatter.traces_to : undefined
      if (traces !== undefined && !traces.includes(crId)) {
        issues.push(`${crId}: realized id '${impact.realized}'s traces_to does not include ${crId}`)
      }
    }
    if (cr.frontmatter.status === 'resolved' && (impacts.length === 0 || !crImpactsDelivered(nodeOf, crId, impacts, backfilled))) {
      issues.push(`${crId}: status is 'resolved' but its impacts are not all provably delivered`)
    }
  }
  return issues
}

/** `cr-citations-declared` (finding #1): a requirement's own record of
 * "which CR amended/spawned me" must be backed by that CR's OWN declared
 * `impacts` — the write-time guard `editRequirement`'s `--cr` path enforces
 * (`assertConfirmedCr`, writer.ts), re-verified corpus-wide so a hand-edited
 * or otherwise-forged citation can never silently pass `validate`. Two
 * independent rules:
 *   (i) every fr/nfr's `traces_to` CR id that resolves to a
 *       `requirement`-entry CR must have a matching impact on that CR —
 *       either `{amends: <this id>}` or a `{spawns, realized: <this id>}`
 *       entry. A `traces_to` pointing at a `vision`-entry (or entry-point-
 *       less) CR is always legal — that's the genesis trace, not an
 *       amendment. A DANGLING `traces_to` (the CR id doesn't resolve at all)
 *       is `no-dangling-refs`'s job, not this check's — skipped here.
 *   (ii) every fr/nfr/br's `## History` CR-id citation (the depth-relaxed
 *       scan, `history.ts`'s `historyCrRefs` — so a demoted/nested entry
 *       from an earlier bump is still checked, finding #3/#6) must resolve
 *       to a CR whose impacts include `{amends: <this id>}` SPECIFICALLY —
 *       a bump is always an amendment (`realizeCrSpawn` never touches a
 *       page's own body/History at all), so a spawn-only backing doesn't
 *       count here. Legacy `BL-*` baseline refs are exempt (`historyCrRefs`
 *       already filters to `CR-\d{3}`-shaped refs only). */
function crCitationsDeclaredIssues(graph: Graph): string[] {
  const issues: string[] = []
  const crById = new Map(graph.crs.map((cr) => [cr.frontmatter.id, cr] as const))

  const crAmends = (crId: string, id: string): boolean => {
    const impacts = crById.get(crId)?.frontmatter.impacts ?? []
    return impacts.some((impact) => 'amends' in impact && impact.amends === id)
  }
  const crAmendsOrRealizes = (crId: string, id: string): boolean => {
    const impacts = crById.get(crId)?.frontmatter.impacts ?? []
    return impacts.some(
      (impact) => ('amends' in impact && impact.amends === id) || ('spawns' in impact && impact.realized === id)
    )
  }

  for (const nodes of [graph.frs, graph.nfrs]) {
    for (const node of nodes) {
      const id = node.frontmatter.id
      for (const crId of node.frontmatter.traces_to) {
        const cr = crById.get(crId)
        if (!cr) continue // dangling traces_to — no-dangling-refs' job
        if (cr.frontmatter.entry_point !== 'requirement') continue // genesis trace to a vision-entry CR
        if (!crAmendsOrRealizes(crId, id)) {
          issues.push(`${id}: traces_to ${crId}, a requirement-entry CR, but ${crId}'s impacts do not declare it`)
        }
      }
    }
  }

  for (const nodes of [graph.frs, graph.nfrs, graph.brs]) {
    for (const node of nodes) {
      const id = node.frontmatter.id
      for (const crId of historyCrRefs(node.body)) {
        if (!crAmends(crId, id)) {
          issues.push(`${id}: ## History cites ${crId}, but ${crId}'s impacts do not declare an amends entry for it`)
        }
      }
    }
  }

  return issues
}

/** `history-anchor-unique`: per fr/nfr/br page, no two `##`/`###` headings
 * may slugify (scopelinks.ts's `slugifyHeading`) to the same base anchor.
 * `scopelinks.ts`'s own `pageAnchors` silently de-duplicates a repeat by
 * appending a `-N` suffix (so an anchor LINK to it still resolves) — this
 * check exists to catch the ROOT CAUSE that produces the repeat in the first
 * place: a `## History` (or any other `##`/`###`) heading that was never
 * demoted (`history.ts`'s `demoteHeadings`) before a prior body was archived
 * into a new one, leaving two live headings of the same text at the same
 * page. Restricted to `#{2,3}` (h2/h3) — the only levels `## Scope`/
 * `## History`/`### <subsection>` ever use; deeper levels are free-form
 * prose headings inside a body, not structural.
 *
 * ACCEPTED scope note (finding #10): every archived generation's own
 * `#### Acceptance Criteria`/`#### History`/etc. (demoted h2s land at h4,
 * demoted h3s at h5) IS expected to recur, by construction, across multiple
 * archived generations on the same page — that's not a defect this check
 * should flag. Those h4+ headings are also never link TARGETS in practice
 * (a Scope link's `#anchor` names a LIVE section, never an archived one), and
 * `pageAnchors`' own `-N` numeric-suffix dedup keeps them individually
 * resolvable if anything ever did reference one — so the h2/h3-only scope
 * here is deliberate, not an oversight to widen. */
function historyAnchorDuplicateIssues(graph: Graph): string[] {
  const issues: string[] = []
  for (const nodes of [graph.frs, graph.nfrs, graph.brs]) {
    for (const node of nodes) {
      const seen = new Map<string, number>()
      const dupes = new Set<string>()
      for (const m of node.body.matchAll(/^#{2,3} (.+)$/gm)) {
        // Non-null: the regex's one capture group is unconditional whenever it matches.
        const slug = slugifyHeading(m[1]!)
        const count = (seen.get(slug) ?? 0) + 1
        seen.set(slug, count)
        if (count > 1) dupes.add(slug)
      }
      if (dupes.size > 0) issues.push(`${node.frontmatter.id}: duplicate heading slug(s) ${[...dupes].sort().join(', ')}`)
    }
  }
  return issues
}

function duplicateFrontmatterIssues(graph: Graph): string[] {
  const issues: string[] = []
  for (const nodes of [graph.frs, graph.nfrs, graph.brs, graph.wps, graph.crs]) {
    for (const node of nodes) {
      if (bodyHasLeadingFrontmatterFence(node.body)) {
        issues.push(`${node.frontmatter.id}: body starts with a YAML frontmatter fence (duplicate FM)`)
      }
    }
  }
  return issues
}

/** Body mentions of canon/catalogue NFR ids must appear in `references_nfr`. */
function referencesNfrTraceabilityIssues(graph: Graph): string[] {
  const issues: string[] = []
  for (const fr of graph.frs) {
    const { canon, catalog } = extractNfrMentions(fr.body)
    const mentioned = [...canon, ...catalog]
    if (mentioned.length === 0) continue
    const declared = new Set(fr.frontmatter.references_nfr)
    const missing = mentioned.filter((id) => !declared.has(id))
    if (missing.length > 0) {
      issues.push(
        `${fr.frontmatter.id}: body mentions ${missing.join(', ')} but references_nfr omits them`,
      )
    }
  }
  return issues
}

function brokenMarkdownLinkIssues(repo: string, graph: Graph): string[] {
  const issues: string[] = []
  const linkRe = /\]\(([^)#]+\.md)(#[^)]*)?\)/g
  for (const nodes of [graph.frs, graph.nfrs, graph.brs, graph.wps, graph.crs, graph.epics]) {
    for (const node of nodes) {
      const rel = graph.pathOf(node.frontmatter.id)
      if (!rel) continue
      const absDir = dirname(join(repo, rel))
      for (const m of node.body.matchAll(linkRe)) {
        const href = m[1]!
        if (href.includes('{') || href.includes('XXX')) continue
        // Only check relative / same-tree links (not https://).
        if (/^[a-z]+:\/\//i.test(href)) continue
        const target = join(absDir, href)
        if (!existsSync(target)) {
          issues.push(`${node.frontmatter.id}: broken link (${href}) from ${rel}`)
        }
      }
    }
  }
  return issues
}

async function validate(repo: string, check: boolean): Promise<CliResult> {
  const results = walkCorpus(repo)
  const validPages = results.filter(isValid)
  const schemaFailures = results.filter((r): r is InvalidWalk => !isValid(r))
  // v3 (Task 8): the `paths` map (Task 4's `buildGraph` 2nd argument) — every
  // valid page's CANON-RELATIVE path, POSIX-separated (same derivation as
  // `writer.ts`'s `loadGraph`) — so `graph.pathOf(id)` resolves here too.
  // Needed for the new `wp-scope-links` check below (`gates.ts`'s
  // `scopeLinkIssues` compares a Scope link's `path` against
  // `${linkRoot}/${graph.pathOf(id)}`) — every OTHER pre-existing `validate`
  // check only ever needed ids, never paths, which is why this was missing
  // until now.
  const paths = new Map<ParsedPage, string>()
  for (const r of validPages) paths.set(r.parsed, relative(repo, r.path).split(sep).join('/'))
  const graph = buildGraph(
    validPages.map((r) => r.parsed),
    paths
  )

  const { manifests, errors: manifestErrors } = readBaselineManifests(repo)
  const guard = maxGuard(
    repo,
    validPages.map((r) => r.parsed),
    manifests
  )
  const partial = partialStateViolations(repo, validPages.map((r) => r.parsed))
  const pendingMarkers = orphanedPendingMarkers(repo)

  const dangling = graph.danglingRefs()
  const orphanIds = graph.orphans()
  const frById = new Map(graph.frs.map((fr) => [fr.frontmatter.id, fr] as const))
  const hardOrphans = orphanIds.filter((id) => frById.get(id)?.frontmatter.provenance !== 'migrated')
  const migratedOrphans = orphanIds.filter((id) => frById.get(id)?.frontmatter.provenance === 'migrated')

  // §11 names "duplicate AC id" as its own hard-failure trigger, corpus-wide
  // — NOT scoped to a WP's closure the way gates.ts's acIssue is. parsePage
  // itself discards parseAcBlock's `.error` (Task 4's carried note), so this
  // is the one place that re-derives it directly from every FR's raw body.
  const duplicateAcFrs = graph.frs.filter((fr) => parseAcBlock(fr.body).error !== undefined).map((fr) => fr.frontmatter.id)

  const allSchemaFailures = [...schemaFailures.map((f) => `${f.path}: ${f.error}`), ...manifestErrors]

  // v3 (Task 8) — the five new checks, each reusing an already-exported pure
  // helper rather than re-deriving its rule a second time (see this file's
  // header note just above these helpers' own definitions).
  const wpScopeLinkIssueList = wpScopeLinkIssues(graph, resolveLinkRoot(repo))
  const wpScopeVersionIssueList = wpScopeVersionCurrentIssues(graph)
  const crImpactsPresentIssueList = crImpactsPresentIssues(graph)
  const crImpactsConsistentIssueList = crImpactsConsistentIssues(graph)
  const crCitationsDeclaredIssueList = crCitationsDeclaredIssues(graph)
  const historyAnchorIssueList = historyAnchorDuplicateIssues(graph)
  const duplicateFrontmatterIssueList = duplicateFrontmatterIssues(graph)
  const brokenMarkdownLinkIssueList = brokenMarkdownLinkIssues(repo, graph)
  const referencesNfrTraceabilityIssueList = referencesNfrTraceabilityIssues(graph)

  const checks: SeverityCheck[] = [
    {
      name: 'schema-valid',
      ok: allSchemaFailures.length === 0,
      reason: allSchemaFailures.length === 0 ? 'every canon page and baseline manifest is schema-valid' : allSchemaFailures.join('; '),
    },
    {
      name: 'no-dangling-refs',
      ok: dangling.length === 0,
      reason: dangling.length === 0 ? 'no dangling typed ref' : dangling.map((d) => `${d.from} -> ${d.to}`).join('; '),
    },
    {
      name: 'no-orphans',
      ok: hardOrphans.length === 0,
      reason: hardOrphans.length === 0 ? 'no un-migrated orphan FR' : hardOrphans.join(', '),
    },
    {
      name: 'no-duplicate-ac-ids',
      ok: duplicateAcFrs.length === 0,
      reason: duplicateAcFrs.length === 0 ? 'no FR has a duplicate AC id' : duplicateAcFrs.join(', '),
    },
    {
      name: 'migrated-orphans',
      ok: migratedOrphans.length === 0,
      reason:
        migratedOrphans.length === 0
          ? 'no provenance:migrated orphan pending re-import'
          : `${migratedOrphans.join(', ')} (provenance:migrated — re-import via shape-requirement to clear)`,
      severity: 'advisory',
    },
    {
      name: 'id-max-guard',
      ok: guard.ok,
      reason: guard.ok ? 'counters.yaml is >= every id seen in the corpus' : guard.violations.join('; '),
    },
    {
      name: 'accept-partial-state',
      ok: partial.length === 0,
      reason: partial.length === 0 ? 'no item claims an incomplete baseline' : partial.join('; '),
    },
    {
      name: 'no-orphaned-pending-markers',
      ok: pendingMarkers.length === 0,
      reason: pendingMarkers.length === 0 ? 'no orphaned accept pending-marker' : pendingMarkers.join(', '),
      severity: 'advisory',
    },
    {
      name: 'wp-scope-links',
      ok: wpScopeLinkIssueList.length === 0,
      reason:
        wpScopeLinkIssueList.length === 0
          ? 'every WP Scope link parses, resolves, path-matches, and anchor-matches'
          : wpScopeLinkIssueList.join('; '),
    },
    {
      name: 'wp-scope-version-current',
      ok: wpScopeVersionIssueList.length === 0,
      reason:
        wpScopeVersionIssueList.length === 0
          ? "every non-accepted WP's version-stamped Scope link matches its target's current version"
          : wpScopeVersionIssueList.join('; '),
    },
    {
      name: 'cr-impacts-present',
      ok: crImpactsPresentIssueList.length === 0,
      reason:
        crImpactsPresentIssueList.length === 0
          ? 'every confirmed requirement-entry CR has a non-empty, resolving impacts set'
          : crImpactsPresentIssueList.join('; '),
    },
    {
      name: 'cr-impacts-consistent',
      ok: crImpactsConsistentIssueList.length === 0,
      reason:
        crImpactsConsistentIssueList.length === 0
          ? 'every realized impact traces back to its CR, and every resolved CR is fully delivered'
          : crImpactsConsistentIssueList.join('; '),
    },
    {
      name: 'cr-citations-declared',
      ok: crCitationsDeclaredIssueList.length === 0,
      reason:
        crCitationsDeclaredIssueList.length === 0
          ? "every traces_to/## History CR citation is backed by that CR's own declared impacts"
          : crCitationsDeclaredIssueList.join('; '),
    },
    {
      name: 'history-anchor-unique',
      ok: historyAnchorIssueList.length === 0,
      reason:
        historyAnchorIssueList.length === 0
          ? 'no fr/nfr/br page has a duplicate ##/### heading slug'
          : historyAnchorIssueList.join('; '),
    },
    {
      name: 'no-duplicate-frontmatter',
      ok: duplicateFrontmatterIssueList.length === 0,
      reason:
        duplicateFrontmatterIssueList.length === 0
          ? 'no requirement body starts with a second YAML frontmatter fence'
          : duplicateFrontmatterIssueList.join('; '),
    },
    {
      name: 'markdown-links-resolve',
      ok: brokenMarkdownLinkIssueList.length === 0,
      reason:
        brokenMarkdownLinkIssueList.length === 0
          ? 'every relative .md link in the corpus resolves on disk'
          : brokenMarkdownLinkIssueList.join('; '),
    },
    {
      name: 'references-nfr-traceability',
      ok: referencesNfrTraceabilityIssueList.length === 0,
      reason:
        referencesNfrTraceabilityIssueList.length === 0
          ? 'every FR body NFR mention is declared in references_nfr'
          : referencesNfrTraceabilityIssueList.join('; '),
    },
  ]

  if (check) {
    const rt = roundTripViolations(validPages)
    checks.push({
      name: 'frontmatter-round-trip',
      ok: rt.length === 0,
      reason: rt.length === 0 ? 'emit(parse(f)) matches every committed page' : rt.join(', '),
    })
    const idempotent = derivedViewsIdempotent(graph)
    checks.push({
      name: 'derived-view-idempotent',
      ok: idempotent,
      reason: idempotent ? 'prd/rtm/backlog render identically on repeat' : 'a derived view rendered differently on repeat',
    })
  }

  return toResult(checks)
}

// ==========================================================================
// fmt — the canonical byte-stable formatter's CLI verb (Task 16). A thin
// surface over fmt.ts's `formatText`/`formatFile`, which are themselves
// nothing but parsePage-then-emitPage (no new serialization logic).
//
// `--check` NEVER writes: it independently re-derives each target's
// canonical text via `formatText` and diffs it against the bytes on disk —
// the exact same `emit(parse(f)) == f` idea `validate --check`'s own
// `frontmatter-round-trip` guardrail (above) already uses, just surfaced as
// its own verb with its own advisory exit code. Without `--check`, each
// target goes through `formatFile`, which only calls `atomicWrite` when the
// canonical bytes actually differ from what's on disk.
//
// Reuses `fs.ts`'s `walkCanonFiles` (also `validate`'s corpus walk /
// `loadGraph`'s corpus load) for the whole-repo `--repo` enumeration — the
// same canon-file discovery, not a second hardcoded directory list.
// ==========================================================================

function collectCanonFiles(repo: string): string[] {
  return walkCanonFiles(repo).sort() // deterministic order — walkCanonFiles's own order isn't guaranteed
}

function fmtCommand(repo: string, paths: readonly string[], check: boolean): CliResult {
  const targets = paths.length > 0 ? [...paths] : collectCanonFiles(repo)
  if (targets.length === 0) return ok('fmt', 'no canon files found')

  const checks: SeverityCheck[] = targets.map((path): SeverityCheck => {
    if (check) {
      const raw = readFileSync(path, 'utf8')
      const type = peekType(raw)
      if (type === undefined || !(type in schemas)) {
        throw new Error(`fmt: ${path}: missing or unrecognized frontmatter 'type'`)
      }
      const canonical = formatText(raw, type as NodeType)
      const isCanonical = canonical === raw
      return {
        name: path,
        ok: isCanonical,
        reason: isCanonical ? 'already canonical' : 'drifted from canonical form',
        severity: 'advisory',
      }
    }
    const { changed } = formatFile(repo, path)
    return { name: path, ok: true, reason: changed ? 'rewrote to canonical form' : 'already canonical' }
  })

  return toResult(checks)
}
