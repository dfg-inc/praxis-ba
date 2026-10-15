#!/usr/bin/env node
/**
 * Set this repository's version, or retarget only its vendored Core pins.
 * Does not commit, tag, push, or modify sibling repositories.
 *
 *   node tools/scripts/set-ecosystem-version.mjs 0.1.0-alpha.48
 *   node tools/scripts/set-ecosystem-version.mjs --vendor 0.1.0-alpha.48
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isValidSemVer,
  readJson,
  repoRootFrom,
  syncAllVersions,
  syncVendorPins,
  writeEcosystem,
  writeJson,
} from "./release-lib.mjs";

const root = repoRootFrom(import.meta.url);
const args = process.argv.slice(2);
let vendorVersion = null;
const positional = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--vendor") {
    vendorVersion = args[i + 1] ?? "";
    i += 1;
    continue;
  }
  positional.push(args[i]);
}
const version = positional[0];
if ((!version && !vendorVersion) || positional.length > 1) {
  console.error("usage: set-ecosystem-version.mjs <semver> [--vendor <core-semver>]");
  console.error("       set-ecosystem-version.mjs --vendor <core-semver>");
  process.exit(1);
}
if (version && !isValidSemVer(version)) {
  console.error(`invalid SemVer: ${version}`);
  process.exit(1);
}
if (vendorVersion && !isValidSemVer(vendorVersion)) {
  console.error(`invalid vendor SemVer: ${vendorVersion}`);
  process.exit(1);
}

const changed = [];
if (version) {
  writeEcosystem(root, version);
  changed.push("ecosystem.json");
  const synced = syncAllVersions(root, version, { dryRun: false });
  for (const rel of synced.changed) {
    if (!changed.includes(rel)) changed.push(rel);
  }
  const pkgPath = join(root, "package.json");
  const pkg = readJson(pkgPath);
  pkg.scripts = pkg.scripts ?? {};
  if (pkg.scripts["check:version"] !== "node tools/scripts/check-ecosystem-version.mjs") {
    pkg.scripts["check:version"] = "node tools/scripts/check-ecosystem-version.mjs";
    writeJson(pkgPath, pkg);
    if (!changed.includes("package.json")) changed.push("package.json");
  }
  if (readFileSync(pkgPath, "utf8").includes(`"version": "${version}"`) === false) {
    console.error("root package.json version was not updated");
    process.exit(1);
  }
  console.log(`product-version: set ${version}`);
}
if (vendorVersion) {
  const pins = syncVendorPins(root, vendorVersion, { dryRun: false });
  for (const rel of pins.changed) {
    if (!changed.includes(rel)) changed.push(rel);
  }
  console.log(`vendor-pins: set ${vendorVersion}`);
  console.log("replace vendor/*.tgz and refresh package-lock.json before committing");
}
console.log(changed.sort().join("\n") || "(no file changes)");
