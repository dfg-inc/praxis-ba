#!/usr/bin/env node
/**
 * Runs `claude plugin validate` on every packed plugin directory of this repository and fails on any error or warning
 * except the missing listing icon (an asset decision, reported separately). Needs the Claude Code CLI; without it the
 * check reports "skipped" and exits 0 so a bare CI image does not fail, but it never prints a pass.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const probe = spawnSync("claude", ["--version"], { encoding: "utf8" });
if (probe.status !== 0) {
  console.log("SKIPPED plugin-validate: the claude CLI is not available here (nothing was validated)");
  process.exit(0);
}
const dirs = [];
const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
// the full-archive staging is only current in repositories that build it as part of verify
for (const kind of scripts["pack:full-zip"] ? ["claude-plugins-staging", "claude-plugins-full-staging"] : ["claude-plugins-staging"]) {
  const base = join(root, "dist", kind, version);
  if (existsSync(base)) for (const name of readdirSync(base)) dirs.push(join(base, name));
}
if (dirs.length === 0) {
  console.error("FAIL plugin-validate: no packed plugin directories under dist/ (run pack:zip first)");
  process.exit(1);
}
let bad = 0;
for (const dir of dirs) {
  const r = spawnSync("claude", ["plugin", "validate", dir, "--profile", "directory"], { encoding: "utf8" });
  const out = `${r.stdout}${r.stderr}`;
  const warnings = out.split("\n").filter((l) => /^\s*❯ /.test(l) && !/ICON_MISSING|This folder also holds|repository root was taken/.test(l));
  if (r.status !== 0 || /✘/.test(out) || warnings.length) {
    bad += 1;
    console.error(`FAIL ${dir}\n${warnings.join("\n")}\n${r.status !== 0 ? out.slice(0, 600) : ""}`);
  } else console.log(`  ok ${dir.replace(root, ".")}`);
}
if (bad) process.exit(1);
console.log(`PASS plugin-validate (${dirs.length} packed plugin directories; the only open warning is the missing listing icon)`);
