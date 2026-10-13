#!/usr/bin/env node
/**
 * Fail unless all six sibling checkouts share one version.
 *
 *   node tools/scripts/check-coordinated-release.mjs
 *   node tools/scripts/check-coordinated-release.mjs --require-tags
 *
 * --require-tags checks the local tag v<version> in every checkout.
 * Missing sibling directories always fail. This is the release gate, not CI.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ECOSYSTEM_REPOS,
  checkEcosystemRelease,
  readJson,
  repoRootFrom,
} from "./release-lib.mjs";

const root = repoRootFrom(import.meta.url);
const parent = dirname(root);
const requireTags = process.argv.includes("--require-tags");
const failures = [];

function tagExists(repo, tag) {
  const result = spawnSync("git", ["-C", repo, "rev-parse", "-q", "--verify", `refs/tags/${tag}`], {
    encoding: "utf8",
  });
  return (result.status ?? 1) === 0;
}

for (const name of ECOSYSTEM_REPOS) {
  const repo = join(parent, name);
  if (!existsSync(join(repo, "package.json"))) {
    failures.push(`${name}: checkout missing at ${repo}`);
    continue;
  }
  const report = checkEcosystemRelease(repo);
  if (!report.ok) {
    for (const mismatch of report.mismatches) {
      failures.push(
        `${name}: ${mismatch.kind ?? "version"} ${mismatch.path}: found ${mismatch.found} expected ${mismatch.expected}`,
      );
    }
  }
  if (requireTags) {
    const version = readJson(join(repo, "package.json")).version;
    const tag = `v${version}`;
    if (!tagExists(repo, tag)) failures.push(`${name}: missing local tag ${tag}`);
  }
}

if (failures.length) {
  console.error("coordinated-release: FAIL");
  for (const line of failures) console.error(`  ${line}`);
  process.exit(1);
}
const version = readJson(join(root, "ecosystem.json")).version;
console.log(`coordinated-release: PASS ${version} (${ECOSYSTEM_REPOS.length} repositories)`);
