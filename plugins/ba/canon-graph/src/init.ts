// ---- init.ts: `praxis-ba init` — creates the canon root of a NEW project.
//
// The engine (ids.ts, writer.ts, fs.ts) assumes `.ba/` already exists: `id
// next` fails on `.ba/.lock`, `validate` has no counters ledger to read. A
// user who only has the installed plugin and an empty directory had no
// supported way to get there. `initCanon` is that way: it creates, and only
// ever CREATES, the machine files and folders the engine expects.
//
// Contract:
//   - Idempotent and non-destructive: an existing file or folder is skipped,
//     never overwritten, never "repaired". A second run creates nothing.
//   - Refuses, writing nothing, when a path it needs is of the wrong kind
//     (file where a folder belongs, a symlink, ...), when an existing
//     `.ba/config.yaml` / `.ba/counters.yaml` is invalid, or when the repo
//     itself is missing or not a directory. Validation of the whole plan
//     happens BEFORE the first write.
//   - Never touches anything outside `<repo>`: every path it creates is a
//     fixed child of the repo, and none of the path components it creates
//     (or creates under) may be a symlink.
//   - `dryRun` computes the same plan and writes nothing.
//   - The project documentation layer (`ba-scaffold`) is a separate, optional
//     step and is NOT created here. The vision is created as a DRAFT only;
//     `vision confirm` stays the one writer of `status: confirmed`.
//   - A first epic goes through the existing `addEpic` writer (one id
//     allocator), and only when the canon has no epics yet.

import { lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stringify as yamlStringify } from 'yaml'
import { readCanonConfig, DEFAULT_CANON_ROOTS } from './fs.js'
import { readCounters } from './ids.js'
import { countersSchema, configSchema } from './schema.js'
import { emitPage } from './serialize.js'
import type { FrontmatterFor } from './graph.js'
import { addEpic, slugify } from './writer.js'

export type InitOptions = {
  /** Compute and report the plan; write nothing. */
  dryRun?: boolean
  /** Product name; becomes the heading of the draft vision. */
  product?: string
  /** Title of a first epic, minted through `addEpic` (only when the canon has no epics yet). */
  epic?: string
}

export type InitResult = {
  repo: string
  dryRun: boolean
  /** Repo-relative paths created (or, in a dry run, that would be created). Folders end with `/`. */
  created: string[]
  /** Repo-relative paths that already existed and were left untouched. */
  skipped: string[]
  /** The first epic, when `epic` was given and created (in a dry run: the predicted id). */
  epic?: { id: string; path: string }
  /** Human-readable notes (e.g. why the epic was not created). */
  notes: string[]
  /** Suggested next steps. */
  next: string[]
}

/** The folders a canon root carries. The engine tolerates their absence; they are created so the layout is visible. */
export const CANON_FOLDERS: readonly string[] = ['epics', 'br', 'cr', 'wp', 'bugs', 'baselines']

const CANON_FOLDER_KEEP = '.gitkeep'

function emptyCounters() {
  return countersSchema.parse({
    product: { epic: 0, cr: 0, wp: 0, bug: 0, baselineSeq: {} },
    epics: {},
    retired: [],
  })
}

const VISION_BODY = `<!-- Draft vision. Replace this body with the product vision. Leave \`status: draft\`
in the frontmatter: only a human running \`praxis-ba vision confirm\` may set
\`status: confirmed\`. No work package can become ready while the vision is a draft. -->

State, in one or two paragraphs, what this product is for and the outcome
it exists to produce - the single sentence a stranger could use to judge
whether any future requirement belongs in scope. Plain prose; only the
frontmatter status is machine-checked.
`

function visionText(product: string | undefined): string {
  const heading = product ? `# ${product.replace(/\s+/g, ' ').trim()}\n\n` : ''
  return emitPage('vision', { type: 'vision', status: 'draft' } as FrontmatterFor<'vision'>, `\n${heading}${VISION_BODY}`)
}

type Kind = 'missing' | 'file' | 'dir'

/** lstat-based: a symlink (even to a directory or a file) is refused, never followed. */
function kindOf(abs: string, rel: string): Kind {
  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(abs)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw err
  }
  if (st.isSymbolicLink()) throw new Error(`init: ${rel} is a symbolic link; refusing to write through it`)
  if (st.isDirectory()) return 'dir'
  if (st.isFile()) return 'file'
  throw new Error(`init: ${rel} exists but is neither a regular file nor a directory`)
}

function expectFile(abs: string, rel: string): boolean {
  const k = kindOf(abs, rel)
  if (k === 'dir') throw new Error(`init: ${rel} exists but is a directory, expected a file`)
  return k === 'file'
}

function expectDir(abs: string, rel: string): boolean {
  const k = kindOf(abs, rel)
  if (k === 'file') throw new Error(`init: ${rel} exists but is a file, expected a directory`)
  return k === 'dir'
}

/** Longest product name init accepts (it becomes the vision heading). */
export const MAX_PRODUCT_LENGTH = 120

/** Paths created by the current apply, so a failure can remove exactly those again. */
let undoLog: Array<() => void> | null = null

function writeNew(abs: string, content: string): void {
  // A temporary name first, then a rename: never a half-written file. Refuses to overwrite a file that appeared since planning.
  try {
    lstatSync(abs)
    throw new Error(`init: ${abs} appeared since planning; refusing to overwrite`)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const tmp = `${abs}.praxis-tmp-${process.pid}`
  writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx' })
  try {
    renameSync(tmp, abs)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
  undoLog?.push(() => rmSync(abs, { force: true }))
}

function makeDir(abs: string): void {
  mkdirSync(abs)
  undoLog?.push(() => rmSync(abs, { recursive: true, force: true }))
}

function epicsPresent(repo: string): boolean {
  try {
    return readdirSync(join(repo, 'epics'), { withFileTypes: true }).some((e) => e.isDirectory())
  } catch {
    return false
  }
}

export async function initCanon(repoInput: string, options: InitOptions = {}): Promise<InitResult> {
  const dryRun = options.dryRun === true
  const epicTitle = options.epic?.trim()
  if (options.epic !== undefined && !epicTitle) throw new Error('init: --epic needs a non-empty title')
  const product = options.product?.trim()
  if (options.product !== undefined && !product) throw new Error('init: --product needs a non-empty name')
  if (product && product.length > MAX_PRODUCT_LENGTH) throw new Error(`init: --product is longer than ${MAX_PRODUCT_LENGTH} characters`)

  // The repo path itself may be a symlink to a project directory (the user's own choice of target): resolve it once;
  // everything below is a fixed child of the resolved directory and may not itself be a symlink.
  let repo: string
  try {
    repo = realpathSync(repoInput)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`init: ${repoInput} does not exist; create the directory first`)
    throw err
  }
  if (!lstatSync(repo).isDirectory()) throw new Error(`init: ${repoInput} is a file, not a directory`)

  const created: string[] = []
  const skipped: string[] = []
  const notes: string[] = []
  const actions: Array<() => void> = []

  // ---- .ba/ and its files -------------------------------------------------
  const baDir = join(repo, '.ba')
  const baExists = expectDir(baDir, '.ba')
  if (baExists) skipped.push('.ba/')
  else {
    created.push('.ba/')
    actions.push(() => makeDir(baDir))
  }

  const configAbs = join(baDir, 'config.yaml')
  if (baExists && expectFile(configAbs, '.ba/config.yaml')) {
    try {
      readCanonConfig(repo) // throws on an invalid config; never repaired silently
    } catch (err) {
      throw new Error(`init: ${err instanceof Error ? err.message : String(err)}; fix or remove it, init does not repair it`)
    }
    skipped.push('.ba/config.yaml')
  } else {
    const config = configSchema.parse({ canon_roots: [...DEFAULT_CANON_ROOTS] })
    created.push('.ba/config.yaml')
    actions.push(() => writeNew(configAbs, yamlStringify(config, { lineWidth: 0 })))
  }

  const countersAbs = join(baDir, 'counters.yaml')
  if (baExists && expectFile(countersAbs, '.ba/counters.yaml')) {
    try {
      readCounters(repo)
    } catch (err) {
      throw new Error(`init: ${err instanceof Error ? err.message : String(err)}; fix or remove it, init does not repair it`)
    }
    skipped.push('.ba/counters.yaml')
  } else {
    created.push('.ba/counters.yaml')
    actions.push(() => writeNew(countersAbs, yamlStringify(emptyCounters(), { lineWidth: 0 })))
  }

  // ---- folders ------------------------------------------------------------
  for (const name of CANON_FOLDERS) {
    const abs = join(repo, name)
    if (expectDir(abs, name)) skipped.push(`${name}/`)
    else {
      created.push(`${name}/`)
      actions.push(() => {
        makeDir(abs)
        writeNew(join(abs, CANON_FOLDER_KEEP), '')
      })
    }
  }

  // ---- vision draft ---------------------------------------------------------
  const visionAbs = join(repo, 'vision.md')
  if (expectFile(visionAbs, 'vision.md')) skipped.push('vision.md')
  else {
    created.push('vision.md')
    actions.push(() => writeNew(visionAbs, visionText(product)))
  }

  // ---- first epic -----------------------------------------------------------
  let epicPlan: { id: string; path: string } | undefined
  let epicCreateNeeded = false
  if (epicTitle) {
    if (epicsPresent(repo)) {
      notes.push('epic not created: this canon already has epics')
    } else {
      epicCreateNeeded = true
      const countersExist = baExists && kindOf(countersAbs, '.ba/counters.yaml') === 'file'
      const nextN = (countersExist ? readCounters(repo).product.epic : 0) + 1
      const id = `E${nextN}`
      epicPlan = { id, path: `epics/${id}-${slugify(epicTitle)}/index.md` }
      created.push(epicPlan.path)
    }
  }

  // ---- apply ----------------------------------------------------------------
  if (!dryRun) {
    // everything this run creates is undone if a later step fails: a failure leaves the project as it was
    undoLog = []
    try {
      for (const act of actions) act()
      if (epicCreateNeeded && epicTitle) {
        const { id } = await addEpic(repo, epicTitle)
        epicPlan = { id, path: `epics/${id}-${slugify(epicTitle)}/index.md` }
        // Replace the predicted entry with the real one (same id unless a race moved the counter).
        const predicted = created.findIndex((p) => p.startsWith('epics/E') && p.endsWith('/index.md'))
        if (predicted >= 0) created[predicted] = epicPlan.path
      }
    } catch (err) {
      for (const step of (undoLog ?? []).reverse()) {
        try {
          step()
        } catch {
          /* best effort */
        }
      }
      throw err
    } finally {
      undoLog = null
    }
  }

  const next = [
    'Edit vision.md, then confirm it with a human decision: skill confirm-vision (praxis-ba vision confirm)',
    'Optional: skill ba-scaffold lays out the project documentation layer (project.md, glossary, inputs/, shared/); init does not create it',
    'Then capture the first change request: skill capture-cr',
  ]
  return { repo, dryRun, created, skipped, ...(epicPlan ? { epic: epicPlan } : {}), notes, next }
}
