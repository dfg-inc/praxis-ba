#!/usr/bin/env node
/**
 * The BA plugin's skill list, read from the skill files themselves (name, description) and from the built archives
 * (is the skill in the Marketplace plugin tree, in the light Desktop Chat ZIP, in the full ZIP).
 *   node tools/scripts/skill-list.mjs --markdown    table for the README / website
 *   node tools/scripts/skill-list.mjs --check       fails when the README table is not what the files say
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractZip } from "./claude-zip.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const skillsDir = join(root, "plugins/ba/skills");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

function frontmatter(file) {
  const text = readFileSync(file, "utf8");
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const get = (key) => {
    const line = m?.[1].split("\n").find((l) => l.startsWith(`${key}:`));
    return line ? line.slice(key.length + 1).trim().replace(/^"(.*)"$/, "$1") : "";
  };
  return { name: get("name"), description: get("description") };
}
const names = readdirSync(skillsDir).filter((n) => existsSync(join(skillsDir, n, "SKILL.md"))).sort();
const zipSkills = (path) => {
  if (!existsSync(path)) return null;
  const dir = join(root, "dist", ".skill-list-tmp", String(Math.abs(path.length)) + names.length);
  extractZip(readFileSync(path), dir);
  const d = join(dir, "skills");
  return existsSync(d) ? new Set(readdirSync(d)) : new Set();
};
const light = zipSkills(join(root, "claude-plugins/praxis-ba.zip"));
const full = zipSkills(join(root, "dist/claude-plugins-full/praxis-ba.zip"));
/** English purposes for skills whose own description is not in English (the public docs are English only). */
const EN = {
  "ba-code-surface-scan": "Internal sub-skill of ba-onboard: lists every backend route and frontend UI action of one code area deterministically, without interpreting meaning.",
  "ba-onboard": "Brings an existing codebase onto the BA canon: reverses project context (data model, integrations, RBAC, NFRs, glossary, AS-IS map) from the code, then picks the first slice for capture-cr.",
  "ba-plan-slice": "The slicing gate inside grill-cr: splits a change request into separate user stories (one per requirement), separates rules and NFRs, and shows the plan to a human before confirmation.",
  "ba-scaffold": "Once per project: lays out the BA documentation layer around the canon (project.md, glossary, inputs, shared, diagrams, meetings, tasks, archive) from templates.",
  "one-pager": "Builds a client one-pager from a live canonical requirement; fails if its purpose or acceptance criteria are missing.",
};
const short = (s) => {
  const first = s.split(/(?<=[.!?])\s/)[0] ?? s;
  return (first.length > 170 ? `${first.slice(0, 167)}...` : first).replace(/\|/g, "/");
};
const rows = names.map((n) => {
  let { description } = frontmatter(join(skillsDir, n, "SKILL.md"));
  if (EN[n]) description = EN[n];
  if (/[\u0400-\u04FF]/.test(description)) throw new Error(`skill ${n} has a non-English description and no English purpose in skill-list.mjs`);
  return `| \`${n}\` | ${short(description)} | yes | ${full ? (full.has(n) ? "yes" : "no") : "?"} | ${light ? (light.has(n) ? "yes" : "no") : "?"} |`;
});
const table = [`${names.length} skills in version ${version}, read from \`plugins/ba/skills\` and from the built archives.`, "", "| Skill | What it is for | Marketplace plugin | Desktop Chat full ZIP | Desktop Chat light ZIP |", "| --- | --- | --- | --- | --- |", ...rows].join("\n");
const START = "<!-- skills:start -->";
const END = "<!-- skills:end -->";
if (process.argv.includes("--markdown")) console.log(table);
if (process.argv.includes("--check")) {
  const readme = readFileSync(join(root, "plugins/ba/README.md"), "utf8");
  const block = readme.slice(readme.indexOf(START) + START.length, readme.indexOf(END)).trim();
  if (block !== table) {
    console.error("FAIL skill-list: plugins/ba/README.md skill table differs from the skill files and built archives; run with --markdown and update it");
    process.exit(1);
  }
  console.log(`PASS skill-list (${names.length} skills: README matches the files and the built archives)`);
}
