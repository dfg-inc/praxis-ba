#!/usr/bin/env node
/**
 * External-package BA workflow acceptance (product defect regression).
 *
 * Packs the staged @praxis/ba artifact, installs the .tgz into a temp repo
 * OUTSIDE the Praxis npm workspace graph, then exercises:
 *   scaffold → CR → FR → draft→batched → WP prepare/approve → machine validate
 *
 * Asserts: no duplicate frontmatter, Scope links resolve, NFR traceability,
 * and plan-approved only after validate PASS.
 *
 * Usage (from monorepo root, after artifacts exist or with --rebuild):
 *   node tools/scripts/ba-external-workflow-acceptance.mjs [--rebuild]
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildAllPluginArtifacts } from "./package-plugins.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const mirror = join(root, "dist/release-mirror");
const rebuild = process.argv.includes("--rebuild");

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function run(cmd, cwd, opts = {}) {
  const r = spawnSync(cmd, {
    cwd,
    shell: true,
    encoding: "utf8",
    ...opts,
  });
  return {
    ok: (r.status ?? 1) === 0,
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function ba(cli, args, cwd) {
  const r = run(`node "${cli}" ${args.join(" ")}`, cwd);
  if (!r.ok) {
    fail(`praxis-ba ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  }
  return r;
}

function baJson(cli, args, cwd) {
  const r = ba(cli, [...args, "--json"], cwd);
  const line = r.stdout.trim().split("\n").filter(Boolean).at(-1);
  try {
    return JSON.parse(line);
  } catch {
    fail(`expected JSON from ${args.join(" ")}, got:\n${r.stdout}`);
  }
}

/** `id next` puts the minted id in check.reason; other verbs use json.id. */
function mintedId(json) {
  if (json.id) return json.id;
  const check = json.checks?.find((c) => c.name === "id-next" || c.name === "epic-add");
  if (check?.reason && /^[A-Z0-9-]+$/.test(check.reason.trim())) return check.reason.trim();
  // epic-add reason is "minted E1"
  const m = check?.reason?.match(/\b(E\d+|CR-\d+|WP-\d{8}-\d{3}|E\d+-(?:FR|NFR|BR)\d+|BUG-\d+)\b/);
  if (m) return m[1];
  fail(`could not extract minted id from ${JSON.stringify(json)}`);
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function assert(cond, msg) {
  if (!cond) fail(msg);
}

if (rebuild || !existsSync(join(mirror, "plugins/ba/bin/praxis-ba.cjs"))) {
  console.log("building plugin artifacts…");
  buildAllPluginArtifacts(mirror);
}

const PLUGIN_IDS = ["ba", "architect", "developer", "jira"];
for (const id of PLUGIN_IDS) {
  assert(existsSync(join(mirror, "plugins", id)), `missing staged plugin ${id}`);
}

// Strict metadata validation against staged release artifacts (not only source).
const meta = run(
  `node "${join(root, "tools/scripts/validate-plugins.mjs")}" --root "${join(mirror, "plugins")}"`,
  root,
);
assert(meta.ok, `plugins:validate on release artifacts failed:\n${meta.stdout}\n${meta.stderr}`);

const packBase = mkdtempSync(join(tmpdir(), "praxis-ba-pack-"));
const tgzPaths = [];
for (const id of PLUGIN_IDS) {
  const dest = join(packBase, id);
  cpSync(join(mirror, "plugins", id), dest, { recursive: true });
  const pack = run("npm pack", dest);
  assert(pack.ok, `npm pack ${id} failed: ${pack.stderr}`);
  const tgz = readdirSync(dest).find((f) => f.endsWith(".tgz"));
  assert(tgz, `no .tgz for ${id}`);
  tgzPaths.push(join(dest, tgz));
  console.log(`packed ${id}: ${tgz}`);
}

const consumer = mkdtempSync(join(tmpdir(), "praxis-ba-ext-"));
write(join(consumer, "package.json"), JSON.stringify({ name: "praxis-ba-ext-accept", private: true }, null, 2));
const install = run(`npm install ${tgzPaths.map((p) => `"${p}"`).join(" ")}`, consumer);
assert(install.ok, `npm install failed:\n${install.stderr}`);

const installed = join(consumer, "node_modules/@praxis/ba");
assert(existsSync(installed), `missing ${installed}`);
assert(
  existsSync(join(consumer, "node_modules/@praxis/architect")),
  "missing @praxis/architect (needed for node_modules traversal regression)",
);
const real = run(`node -e "console.log(require('fs').realpathSync(${JSON.stringify(installed)}))"`, consumer);
assert(!real.stdout.includes(join(root, "plugins")), `install resolves into monorepo plugins/: ${real.stdout.trim()}`);

const cli = join(installed, "bin/praxis-ba.cjs");
assert(existsSync(cli), "installed bin/praxis-ba.cjs missing");

const project = join(consumer, "ext-project");
const canon = join(project, "canon");
mkdirSync(canon, { recursive: true });

// --- scaffold (engine boot files + layer stubs) ---
write(
  join(canon, ".ba/counters.yaml"),
  `product:\n  epic: 0\n  cr: 0\n  wp: 0\n  bug: 0\n  baselineSeq: {}\nepics: {}\nretired: []\n`,
);
write(
  join(canon, ".ba/config.yaml"),
  `canon_roots:\n  - vision.md\n  - epics/\n  - br/\n  - cr/\n  - wp/\n  - bugs/\nlink_root: canon\n`,
);
write(
  join(canon, "vision.md"),
  `---\ntype: vision\nstatus: draft\n---\n\nExternal acceptance product for BA workflow regression.\n`,
);
write(
  join(project, "shared/nfr.md"),
  `---\ntype: nfr-catalog\n---\n\n# NFR catalogue\n\n- PXT-NFR-001: availability\n- PXT-NFR-002: auditability\n`,
);

const date = "20260831";
ba(cli, ["vision", "confirm", "--repo", canon, "--by", "acceptance", "--date", date], consumer);

const epic = baJson(cli, ["epic", "add", "--repo", canon, "--title", "foundation"], consumer);
assert(mintedId(epic) === "E1", `expected epic E1, got ${mintedId(epic)}`);

const crId = mintedId(baJson(cli, ["id", "next", "--repo", canon, "--scope", "cr"], consumer));
assert(crId === "CR-001", `expected CR-001, got ${crId}`);
write(
  join(canon, `cr/${crId}.md`),
  `---\nid: ${crId}\ntype: cr\nstatus: captured\n---\n\nNeed authenticated session handoff with audit trail.\n`,
);
ba(cli, ["fmt", join(canon, `cr/${crId}.md`), "--repo", canon], consumer);

const impactsPath = join(consumer, "impacts.json");
write(
  impactsPath,
  JSON.stringify([{ spawns: "fr", epic: "E1" }, { spawns: "fr", epic: "E1" }], null, 2),
);
ba(
  cli,
  ["cr", "confirm", "--repo", canon, "--cr", crId, "--entry", "requirement", "--impacts-file", impactsPath],
  consumer,
);

const fr1 = mintedId(baJson(cli, ["id", "next", "--repo", canon, "--scope", "fr:E1"], consumer));
const fr2 = mintedId(baJson(cli, ["id", "next", "--repo", canon, "--scope", "fr:E1"], consumer));
const epicDir = readdirSync(join(canon, "epics")).find((d) => d.startsWith("E1-"));
assert(epicDir, "epic folder missing");

function frPage(id, rationaleNfrs) {
  return `---
id: ${id}
type: fr
epic: E1
status: draft
version: 1
traces_to: [${crId}]
enforces: []
references_nfr: []
related: []
---

As a user, I want ${id}, so that the slice is delivered.

## Acceptance Criteria

- AC-1: given a starting state, when the user acts, then an observable outcome.

## Rationale

Depends on ${rationaleNfrs.join(" and ")} for the handoff guarantees.
`;
}

write(join(canon, "epics", epicDir, `${fr1}.md`), frPage(fr1, ["PXT-NFR-001"]));
write(join(canon, "epics", epicDir, `${fr2}.md`), frPage(fr2, ["PXT-NFR-002"]));

// Full-page body-file activate (the alpha.4 defect path).
const full1 = join(consumer, "fr1-full.md");
const full2 = join(consumer, "fr2-full.md");
write(full1, readFileSync(join(canon, "epics", epicDir, `${fr1}.md`), "utf8"));
write(full2, readFileSync(join(canon, "epics", epicDir, `${fr2}.md`), "utf8"));
ba(cli, ["req", "edit", "--repo", canon, "--req", fr1, "--body-file", full1, "--activate"], consumer);
ba(cli, ["req", "edit", "--repo", canon, "--req", fr2, "--body-file", full2, "--activate"], consumer);

ba(cli, ["cr", "realize", "--repo", canon, "--cr", crId, "--spawn", "E1:fr", "--id", fr1], consumer);
ba(cli, ["cr", "realize", "--repo", canon, "--cr", crId, "--spawn", "E1:fr", "--id", fr2], consumer);

const wpId = mintedId(
  baJson(cli, ["id", "next", "--repo", canon, "--scope", "wp", "--date", date], consumer),
);
const wpIndex = join(canon, "wp", wpId, "index.md");
write(
  wpIndex,
  `---
id: ${wpId}
type: wp
role: developer
status: draft
---

Deliver authenticated session handoff.

## Scope

### Change requests

- [${crId}](../../cr/${crId}.md)

### Delivers

- [${fr1}](../../epics/${epicDir}/${fr1}.md#acceptance-criteria)
- [${fr2}](../../epics/${epicDir}/${fr2}.md#acceptance-criteria)
`,
);
write(join(canon, "wp", wpId, "plan.md"), `# Plan\n\nImplement ${fr1} and ${fr2}.\n`);

ba(cli, ["fmt", wpIndex, "--repo", canon], consumer);
ba(cli, ["wp", "prepare", "--repo", canon, "--wp", wpId], consumer);

// draft/active → batched happened inside prepare; assert single FM + NFR refs.
for (const id of [fr1, fr2]) {
  const raw = readFileSync(join(canon, "epics", epicDir, `${id}.md`), "utf8");
  const fences = raw.match(/^---$/gm) ?? [];
  assert(fences.length === 2, `${id}: expected one frontmatter block, found ${fences.length / 2}`);
  assert(!/\n---\n[\s\S]*?\n---\n---/.test(raw), `${id}: duplicate frontmatter smell`);
  const nfr = id === fr1 ? "PXT-NFR-001" : "PXT-NFR-002";
  assert(raw.includes(`references_nfr:`), `${id}: missing references_nfr`);
  assert(raw.includes(nfr), `${id}: expected ${nfr} in file`);
}

const lint = baJson(cli, ["validate", "--repo", canon], consumer);
assert(lint.verdict === "VERIFY-OK", `validate failed: ${JSON.stringify(lint.checks?.filter((c) => !c.ok))}`);
const mdLinks = lint.checks.find((c) => c.name === "markdown-links-resolve");
assert(mdLinks?.ok, `markdown-links-resolve failed: ${mdLinks?.reason}`);
const dup = lint.checks.find((c) => c.name === "no-duplicate-frontmatter");
assert(dup?.ok, `no-duplicate-frontmatter failed: ${dup?.reason}`);
const nfrTrace = lint.checks.find((c) => c.name === "references-nfr-traceability");
assert(nfrTrace?.ok, `references-nfr-traceability failed: ${nfrTrace?.reason}`);
for (const name of [
  "needs-clarification-committed",
  "nfr-catalogue-refs",
  "taxonomy-tags",
  "child-status-vs-epic",
  "markdown-links-resolve-semantic",
]) {
  assert(
    lint.checks.some((c) => c.name === name),
    `validate missing semantic check ${name}`,
  );
}
assert(!existsSync(join(installed, "tools/lint.py")), "packaged BA must not ship tools/lint.py");
assert(
  !readdirSync(join(installed, "tools")).some((f) => f.endsWith(".py")),
  "packaged BA tools/ must not contain Python files",
);

ba(cli, ["wp", "approve-plan", "--repo", canon, "--wp", wpId, "--plan", `wp/${wpId}/plan.md`], consumer);
const wpRaw = readFileSync(wpIndex, "utf8");
assert(/status:\s*plan-approved/.test(wpRaw), "WP not plan-approved");
assert(!wpRaw.includes("canon/epics"), "WP Scope must not duplicate canon/ prefix");

const baHandoffPath = join(canon, "wp", wpId, "handoffs", "ba-architect.handoff.json");
assert(existsSync(baHandoffPath), `BA machine handoff missing: ${baHandoffPath}`);
const baHandoff = JSON.parse(readFileSync(baHandoffPath, "utf8"));
assert(baHandoff.contract === "ba.architect.handoff", `bad BA contract: ${baHandoff.contract}`);
assert(baHandoff.workPackageId === wpId, "BA handoff workPackageId mismatch");
assert(Array.isArray(baHandoff.requirementIds) && baHandoff.requirementIds.length >= 2, "BA handoff requirementIds");

// --- node_modules must not be traversed when validating the project root ---
// Mirror the confirmed external trigger: installed Architect ships SKILL.md
// under node_modules; `--repo .` must ignore it.
write(
  join(consumer, ".ba/counters.yaml"),
  `product:\n  epic: 0\n  cr: 0\n  wp: 0\n  bug: 0\n  baselineSeq: {}\nepics: {}\nretired: []\n`,
);
write(
  join(consumer, "vision.md"),
  `---\ntype: vision\nstatus: confirmed\nconfirmed_at: "${date}"\nconfirmed_by: acceptance\n---\n\nRoot-surface vision for --repo . traversal check.\n`,
);
const rootValidate = baJson(cli, ["validate", "--repo", consumer], consumer);
assert(
  rootValidate.verdict === "VERIFY-OK",
  `validate --repo . must ignore node_modules skills, got: ${JSON.stringify(rootValidate.checks?.filter((c) => !c.ok))}`,
);
assert(
  !(rootValidate.checks ?? []).some((c) => /node_modules|nfr-budget/i.test(c.reason ?? "")),
  "validate reason must not mention node_modules / nfr-budget",
);

console.log(
  JSON.stringify(
    {
      ok: true,
      consumer,
      installed,
      plugins: PLUGIN_IDS,
      wpId,
      frs: [fr1, fr2],
      baHandoffPath,
      baHandoffContract: baHandoff.contract,
      validate: lint.verdict,
      validateRepoDot: rootValidate.verdict,
      artifactsMetadata: "PASS",
    },
    null,
    2,
  ),
);

rmSync(packBase, { recursive: true, force: true });
rmSync(consumer, { recursive: true, force: true });
