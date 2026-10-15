#!/usr/bin/env node
/**
 * Fail when this repository disagrees with its own version or vendor pins.
 * Sibling repositories are not required to use the same version.
 *
 *   node tools/scripts/check-ecosystem-version.mjs
 */
import { checkEcosystemRelease, repoRootFrom } from "./release-lib.mjs";

const root = repoRootFrom(import.meta.url);
const report = checkEcosystemRelease(root);
if (!report.ok) {
  console.error(`ecosystem-version: FAIL ${report.expected}`);
  for (const mismatch of report.mismatches) {
    console.error(
      `  ${mismatch.kind ?? "version"} ${mismatch.path}: found ${mismatch.found} expected ${mismatch.expected}`,
    );
  }
  process.exit(1);
}
console.log(`ecosystem-version: PASS ${report.expected}`);
