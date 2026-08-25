#!/usr/bin/env node
/**
 * Persist BA confirm reject reason (WBS 1.9).
 * Usage: node plugins/ba/tools/record-reject.mjs --repo <canon> --id <CR-id> --reason "…"
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const repo = resolve(flag("--repo") ?? "");
const id = flag("--id");
const reason = flag("--reason");
if (!repo || !id || !reason) {
  console.error("usage: record-reject --repo <canon> --id <id> --reason <text>");
  process.exit(1);
}

const dir = join(repo, ".ba", "rejects");
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const path = join(dir, `${id}-${stamp}.json`);
const row = {
  id,
  reason,
  rejectedAt: new Date().toISOString(),
};
writeFileSync(path, JSON.stringify(row, null, 2) + "\n");
console.log(JSON.stringify({ ok: true, path, row }, null, 2));
