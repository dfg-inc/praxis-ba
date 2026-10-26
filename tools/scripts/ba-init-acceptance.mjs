#!/usr/bin/env node
/**
 * A user with an empty project directory and ONLY the installed plugin can start the BA canon (no source checkout, no
 * node_modules). The flow is run twice, against each packaged CLI:
 *   - the Marketplace-style plugin tree (bin/praxis-ba.cjs), staged by the same mechanism the release uses;
 *   - the full Desktop ZIP, packed and unpacked (tools/praxis-ba.cjs).
 * From an empty temp dir: init --dry-run (writes nothing), init, init again (creates nothing), status, id next --scope cr,
 * epic add, validate, and a directory without a canon gives the actionable error.
 *   node tools/scripts/ba-init-acceptance.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractZip } from "./claude-zip.mjs";
import { buildAllPluginArtifacts } from "./package-plugins.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const fail = (m) => {
  console.error(`FAIL ba-init: ${m}`);
  process.exit(1);
};
const scratch = mkdtempSync(join(tmpdir(), "praxis-ba-init-"));
const proven = [];

// ---- stage the two packaged artifacts ----
const mirror = join(scratch, "mirror");
buildAllPluginArtifacts(mirror);
const pluginTree = join(mirror, "plugins/ba");
const zip = join(scratch, "praxis-ba.zip");
const packed = spawnSync(process.execPath, [join(root, "tools/scripts/pack-claude-plugins.mjs"), "--version", version, "--full", "praxis-ba", "--out", zip], { cwd: root, encoding: "utf8" });
if (packed.status !== 0) fail(`pack full zip: ${packed.stderr || packed.stdout}`);
const unpacked = join(scratch, "full-zip");
extractZip(readFileSync(zip), unpacked);

const targets = [
  { label: "Marketplace plugin tree", cli: join(pluginTree, "bin/praxis-ba.cjs"), skillsDir: join(pluginTree, "skills"), cliRef: "${CLAUDE_PLUGIN_ROOT}/bin/praxis-ba.cjs" },
  { label: "full Desktop ZIP", cli: join(unpacked, "tools/praxis-ba.cjs"), skillsDir: join(unpacked, "skills"), cliRef: "${CLAUDE_PLUGIN_ROOT}/tools/praxis-ba.cjs" },
];

function ba(cli, args, cwd) {
  // A minimal environment: no NODE_PATH, no checkout on the path; cwd is the user's empty directory.
  const r = spawnSync(process.execPath, [cli, ...args, "--json"], { cwd, env: { PATH: process.env.PATH }, encoding: "utf8" });
  let json;
  try {
    json = JSON.parse(r.stdout.trim().split("\n").filter(Boolean).at(-1));
  } catch {
    fail(`${args.join(" ")}: no JSON output\n${r.stdout}\n${r.stderr}`);
  }
  return { code: r.status, json, stderr: r.stderr };
}
const listTree = (dir, rel = "") =>
  readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? [`${r}/`, ...listTree(dir, r)] : [r];
  });

for (const t of targets) {
  const at = (m) => `${t.label}: ${m}`;
  if (!existsSync(t.cli)) fail(at(`${t.cli} is missing`));
  // the skill ships and points at the CLI that this artifact really has
  const skillFile = join(t.skillsDir, "ba-init/SKILL.md");
  if (!existsSync(skillFile)) fail(at("skills/ba-init/SKILL.md is missing"));
  const skill = readFileSync(skillFile, "utf8");
  if (!skill.includes("If `praxis_doctor` is not available: stop with `PRAXIS_RUNTIME_UNAVAILABLE`.")) fail(at("ba-init lacks the hosted runtime line"));
  if (!skill.includes(t.cliRef)) fail(at(`ba-init does not reference ${t.cliRef}`));
  if (!/init --repo \. --dry-run/.test(skill)) fail(at("ba-init does not start with a dry run"));

  const repo = mkdtempSync(join(scratch, "project-"));

  const none = ba(t.cli, ["status", "--repo", repo], repo);
  if (none.code !== 1 || !/^no canon here: run praxis-ba init --repo /.test(none.json.checks[0].reason) || /ENOENT|at \w+ \(/.test(none.stderr + none.json.checks[0].reason)) fail(at(`a directory without a canon gives no actionable error: ${JSON.stringify(none.json)}`));
  if (listTree(repo).length) fail(at("a failing status wrote files"));

  const dry = ba(t.cli, ["init", "--repo", repo, "--dry-run", "--epic", "First epic"], repo);
  if (dry.code !== 0 || dry.json.dryRun !== true || !dry.json.created.includes(".ba/counters.yaml")) fail(at(`dry-run: ${JSON.stringify(dry.json)}`));
  if (listTree(repo).length) fail(at("dry-run wrote files"));
  proven.push(`${t.label}: init --dry-run lists ${dry.json.created.length} paths and writes nothing`);

  const init = ba(t.cli, ["init", "--repo", repo, "--epic", "First epic"], repo);
  if (init.code !== 0 || init.json.verdict !== "VERIFY-OK") fail(at(`init: ${JSON.stringify(init.json)}`));
  if (JSON.stringify(init.json.created) !== JSON.stringify(dry.json.created)) fail(at("init did not create exactly what the dry run listed"));
  for (const p of [".ba/config.yaml", ".ba/counters.yaml", "vision.md"]) if (!existsSync(join(repo, p))) fail(at(`${p} was not created`));
  if (!/status: draft/.test(readFileSync(join(repo, "vision.md"), "utf8"))) fail(at("vision.md is not a draft"));
  if (!init.json.next.some((n) => /ba-scaffold/.test(n))) fail(at("init does not mention ba-scaffold as the next optional step"));
  proven.push(`${t.label}: init creates the canon, a draft vision and the first epic`);

  const before = listTree(repo).join("\n");
  const again = ba(t.cli, ["init", "--repo", repo, "--epic", "First epic"], repo);
  if (again.code !== 0 || again.json.created.length !== 0 || listTree(repo).join("\n") !== before) fail(at(`second init is not idempotent: ${JSON.stringify(again.json)}`));
  proven.push(`${t.label}: second init creates nothing`);

  const status = ba(t.cli, ["status", "--repo", repo], repo);
  if (status.json.verdict !== "VERIFY-OK") fail(at(`status: ${JSON.stringify(status.json)}`));
  const cr = ba(t.cli, ["id", "next", "--scope", "cr", "--repo", repo], repo);
  if (cr.code !== 0 || cr.json.checks[0].reason !== "CR-001") fail(at(`id next --scope cr: ${JSON.stringify(cr.json)}`));
  const epic = ba(t.cli, ["epic", "add", "--title", "Second epic", "--repo", repo], repo);
  if (epic.code !== 0 || epic.json.id !== "E2") fail(at(`epic add (E1 came from init): ${JSON.stringify(epic.json)}`));
  const valid = ba(t.cli, ["validate", "--check", "--repo", repo], repo);
  if (valid.json.verdict !== "VERIFY-OK") fail(at(`validate: ${JSON.stringify(valid.json)}`));
  proven.push(`${t.label}: status, id next (CR-001), epic add (E2) and validate all work from the empty directory`);
}

rmSync(scratch, { recursive: true, force: true });
console.log(`PASS ba-init (${proven.length} checks)\n${proven.map((p) => `  ok ${p}`).join("\n")}`);
