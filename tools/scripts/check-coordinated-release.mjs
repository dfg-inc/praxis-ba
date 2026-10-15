#!/usr/bin/env node
/**
 * Validate each present sibling checkout on its own version.
 * Missing checkouts are skipped. Differing versions are allowed.
 * --require-tags checks only this repository's local tag.
 *
 *   node tools/scripts/check-coordinated-release.mjs
 *   node tools/scripts/check-coordinated-release.mjs --require-tags
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { ECOSYSTEM_REPOS, checkEcosystemRelease, readJson, repoRootFrom } from "./release-lib.mjs";

const root = repoRootFrom(import.meta.url);
const parent = dirname(root);
const requireTags = process.argv.includes("--require-tags");
const failures = [];
const rows = [];

function tagExists(repo, tag) {
  const result = spawnSync("git", ["-C", repo, "rev-parse", "-q", "--verify", `refs/tags/${tag}`], {
    encoding: "utf8",
  });
  return (result.status ?? 1) === 0;
}

for (const name of ECOSYSTEM_REPOS) {
  const repo = join(parent, name);
  if (!existsSync(join(repo, "package.json"))) continue;
  const report = checkEcosystemRelease(repo);
  rows.push(`${name} ${report.expected}`);
  if (!report.ok) {
    for (const mismatch of report.mismatches) {
      failures.push(
        `${name}: ${mismatch.kind ?? "version"} ${mismatch.path}: found ${mismatch.found} expected ${mismatch.expected}`,
      );
    }
  }
}

if (requireTags) {
  const version = readJson(join(root, "package.json")).version;
  const tag = `v${version}`;
  if (!tagExists(root, tag)) failures.push(`${root}: missing local tag ${tag}`);
}

if (failures.length) {
  console.error("ecosystem-check: FAIL");
  for (const line of failures) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`ecosystem-check: PASS (${rows.length} present)`);
for (const row of rows) console.log(`  ${row}`);
