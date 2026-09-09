#!/usr/bin/env node
/**
 * one-pager builder (WBS 1.14).
 * Usage: node plugins/ba/tools/one-pager.mjs --repo <canon-dir> --id <FR-id> [--out <path>]
 *
 * Thin wrapper: live-FR resolution lives in canon-graph (`praxis-ba one-pager`).
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const repo = flag("--repo");
const id = flag("--id");
const out = flag("--out");
if (!repo || !id) {
  console.error(
    "usage: one-pager.mjs --repo <canon-dir> --id <FR-id> [--out path]",
  );
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const packedCli = join(here, "../bin/praxis-ba.cjs");
const workspaceCli = join(here, "../canon-graph/bin/praxis-ba.mjs");
const cli = existsSync(packedCli) ? packedCli : workspaceCli;
if (!existsSync(cli)) {
  console.error(`FAIL: praxis-ba CLI not found at ${packedCli} or ${workspaceCli}`);
  process.exit(1);
}

const argv = ["one-pager", "--repo", repo, "--id", id, "--json"];
if (out) argv.push("--out", out);

const result = spawnSync(process.execPath, [cli, ...argv], {
  encoding: "utf8",
});
const stdout = result.stdout ?? "";
const stderr = result.stderr ?? "";
let json;
try {
  const line = stdout.trim().split("\n").filter(Boolean).at(-1);
  json = JSON.parse(line);
} catch {
  console.error(stderr || stdout || "FAIL: one-pager CLI produced no JSON");
  process.exit(result.status === 0 ? 1 : (result.status ?? 1));
}

if (json.verdict !== "VERIFY-OK" || (result.status ?? 1) !== 0) {
  const reason = json.checks?.[0]?.reason ?? "one-pager failed";
  console.error(reason);
  process.exit(result.status ?? 1);
}

const path = json.path ?? (out ? out : `${repo}/one-pagers/${id}.md`);
console.log(`OK wrote ${path}`);
process.exit(0);
