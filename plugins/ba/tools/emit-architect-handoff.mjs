#!/usr/bin/env node
/**
 * Emit ba.architect.handoff from a plan-approved (or ready) WP folder.
 *
 * Usage:
 *   node plugins/ba/tools/emit-architect-handoff.mjs \
 *     --repo <canon-root> --wp <WP-ID> [--out <path>]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const repo = resolve(flag("--repo") ?? process.cwd());
const wpId = flag("--wp");
if (!wpId) {
  console.error("missing --wp <id>");
  process.exit(1);
}

const wpIndex = join(repo, "wp", wpId, "index.md");
if (!existsSync(wpIndex)) {
  console.error(`WP index not found: ${wpIndex}`);
  process.exit(1);
}

const body = readFileSync(wpIndex, "utf8");
const fmMatch = body.match(/^---\n([\s\S]*?)\n---/);
if (!fmMatch) {
  console.error("WP missing frontmatter");
  process.exit(1);
}
const fm = fmMatch[1];
const status = (fm.match(/^status:\s*(.+)$/m) ?? [])[1]?.trim();
if (!status || !["ready", "plan-approved", "accepted"].includes(status)) {
  console.error(`WP status not handoff-ready: ${status}`);
  process.exit(1);
}

const reqIds = [
  ...body.matchAll(/\[([A-Z0-9]+-FR\d+)(?:\s+v\d+)?\]/g),
].map((m) => m[1]);
const uniqueReqs = [...new Set(reqIds)];
if (uniqueReqs.length === 0) {
  console.error("no requirement ids found in Scope Delivers");
  process.exit(1);
}

const visionPath = join(repo, "vision.md");
const visionConfirmed =
  existsSync(visionPath) &&
  /status:\s*confirmed/.test(readFileSync(visionPath, "utf8"));

const handoff = {
  contract: "ba.architect.handoff",
  version: "0.1.0",
  workPackageId: wpId,
  workPackagePath: relative(repo, wpIndex).split("\\").join("/"),
  requirementIds: uniqueReqs,
  visionConfirmed,
  readinessChecks: [
    { id: "wp-status", passed: true, detail: status },
    { id: "vision", passed: visionConfirmed },
    {
      id: "requirements-present",
      passed: uniqueReqs.length > 0,
      detail: uniqueReqs.join(","),
    },
  ],
};

const out =
  flag("--out") ??
  join(repo, "wp", wpId, "handoffs", "ba-architect.handoff.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(handoff, null, 2) + "\n");
console.log(JSON.stringify({ ok: true, path: out, handoff }, null, 2));
