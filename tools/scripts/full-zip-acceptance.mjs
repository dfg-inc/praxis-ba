#!/usr/bin/env node
/**
 * The full BA archive for Claude Desktop Chat (all skills) is self-consistent: every file a skill points at is in the
 * archive, the canon skills named by the owner are present, no top-level bin/, and the packaged CLI runs from the unpacked
 * archive with no node_modules. (alpha.48 shipped skills that called a CLI the archive did not contain.)
 *   node tools/scripts/full-zip-acceptance.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractZip } from "./claude-zip.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const out = join(mkdtempSync(join(tmpdir(), "praxis-fullzip-")), "praxis-ba.zip");
const packed = spawnSync(process.execPath, [join(root, "tools/scripts/pack-claude-plugins.mjs"), "--version", version, "--full", "praxis-ba", "--out", out], { cwd: root, encoding: "utf8" });
const fail = (m) => {
  console.error(`FAIL full-zip: ${m}`);
  process.exit(1);
};
if (packed.status !== 0) fail(`pack: ${packed.stderr || packed.stdout}`);
const dir = mkdtempSync(join(tmpdir(), "praxis-fullzip-x-"));
extractZip(readFileSync(out), dir);
const proven = [];
const skills = readdirSync(join(dir, "skills"));
for (const s of ["capture-cr", "grill-cr", "ba-plan-slice", "shape-requirement", "prepare-wp", "approve-plan", "accept", "ba-lint", "one-pager", "local-workflow", "requirements-review", "prototype", "story-plan", "stories-review", "change-request", "resume-work"]) if (!skills.includes(s)) fail(`skill ${s} missing from the archive`);
proven.push(`${skills.length} skills including the owner's canon list and the new review/prototype/plan/stories skills`);
if (existsSync(join(dir, "bin"))) fail("a top-level bin/ would be refused by the Desktop upload rules");
let refs = 0;
for (const s of skills) {
  const file = join(dir, "skills", s, "SKILL.md");
  if (!existsSync(file)) fail(`skills/${s}/SKILL.md missing`);
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9_./-]+)/g)) {
    const rel = m[1].replace(/[.,;:)]+$/, "");
    if (/^bin\//.test(rel)) fail(`skill ${s} still points at ${rel}`);
    if (!existsSync(join(dir, rel))) fail(`skill ${s} points at ${rel}, which is not in the archive`);
    refs += 1;
  }
}
proven.push(`${refs} \${CLAUDE_PLUGIN_ROOT} references in skills all resolve inside the archive`);
const bare = mkdtempSync(join(tmpdir(), "praxis-fullzip-run-"));
const run = spawnSync(process.execPath, [join(dir, "tools/praxis-ba.cjs"), "status", "--repo", bare], { cwd: bare, env: { PATH: process.env.PATH }, encoding: "utf8" });
if (!/VERIFY-OK/.test(run.stdout)) fail(`the packaged CLI does not run from the unpacked archive: ${(run.stderr || run.stdout).slice(0, 300)}`);
proven.push("tools/praxis-ba.cjs runs from the unpacked archive with no node_modules (VERIFY-OK)");
console.log(`PASS full-zip (${proven.length} checks)\n${proven.map((p) => `  ok ${p}`).join("\n")}`);
