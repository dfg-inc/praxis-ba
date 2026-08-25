#!/usr/bin/env node
/**
 * one-pager builder (WBS 1.14).
 * Usage: node plugins/ba/tools/one-pager.mjs --repo <canon-dir> --id <FR-id> [--out <path>]
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

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

function parseFm(raw) {
  if (!raw.startsWith("---")) return { data: {}, content: raw };
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return { data: {}, content: raw };
  const fmBlock = raw.slice(3, end).trim();
  const content = raw.slice(end + 4);
  const data = {};
  for (const line of fmBlock.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    data[m[1]] = v;
  }
  return { data, content };
}

function findPage(root, wantId) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        stack.push(p);
      } else if (e.name.endsWith(".md")) {
        const raw = readFileSync(p, "utf8");
        const parsed = parseFm(raw);
        if (parsed.data.id === wantId) {
          return { path: p, fm: parsed.data, body: parsed.content };
        }
      }
    }
  }
  return null;
}

function section(body, names) {
  const map = {};
  let current = "";
  for (const line of body.split(/\r?\n/)) {
    const m = /^##\s+(.+)\s*$/.exec(line);
    if (m) {
      current = m[1].trim().toLowerCase();
      map[current] = "";
      continue;
    }
    if (current) map[current] += line + "\n";
  }
  for (const n of names) {
    const v = (map[n.toLowerCase()] ?? "").trim();
    if (v) return v;
  }
  return "";
}

const page = findPage(repo, id);
if (!page) {
  console.error(`FAIL: requirement ${id} not found under ${repo}`);
  process.exit(1);
}

const purpose =
  section(page.body, ["назначение", "purpose", "summary", "intent"]) ||
  (typeof page.fm.purpose === "string" ? page.fm.purpose.trim() : "");
const value = section(page.body, [
  "пользовательская ценность",
  "user value",
  "value",
]);
const ready = section(page.body, [
  "условия готовности",
  "acceptance criteria",
  "готовность",
]);

if (!purpose) {
  console.error("FAIL: one-pager not emitted; missing: назначение/purpose");
  process.exit(1);
}

const doc = [
  `# One-pager: ${id}`,
  "",
  "## Назначение",
  "",
  purpose,
  "",
  "## Что сможет пользователь",
  "",
  value || "_не заполнено в источнике_",
  "",
  "## Условия готовности",
  "",
  ready || "_не заполнено в источнике_",
  "",
  `Source: ${page.path}`,
  "",
].join("\n");

const outPath = out ?? join(repo, "one-pagers", `${id}.md`);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, doc);
console.log(`OK wrote ${outPath}`);
