#!/usr/bin/env node
/**
 * Set this repository to the shared ecosystem version.
 * Does not commit, tag, or push.
 *
 *   node tools/scripts/set-ecosystem-version.mjs 0.1.0-alpha.47
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isValidSemVer,
  readJson,
  repoRootFrom,
  syncAllVersions,
  writeEcosystem,
  writeJson,
} from "./release-lib.mjs";

const root = repoRootFrom(import.meta.url);
const version = process.argv[2];
if (!isValidSemVer(version)) {
  console.error("usage: set-ecosystem-version.mjs <semver>");
  process.exit(1);
}

writeEcosystem(root, version);
const { changed } = syncAllVersions(root, version, { dryRun: false });
const pkgPath = join(root, "package.json");
const pkg = readJson(pkgPath);
pkg.scripts = pkg.scripts ?? {};
if (pkg.scripts["check:version"] !== "node tools/scripts/check-ecosystem-version.mjs") {
  pkg.scripts["check:version"] = "node tools/scripts/check-ecosystem-version.mjs";
  writeJson(pkgPath, pkg);
  if (!changed.includes("package.json")) changed.push("package.json");
}
console.log(`ecosystem-version: set ${version}`);
console.log(changed.sort().join("\n") || "(no file changes)");
if (readFileSync(pkgPath, "utf8").includes(`"version": "${version}"`) === false) {
  console.error("root package.json version was not updated");
  process.exit(1);
}
