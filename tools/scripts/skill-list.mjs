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
const short = (s) => {
  const first = s.split(/(?<=[.!?])\s/)[0] ?? s;
  return (first.length > 170 ? `${first.slice(0, 167)}...` : first).replace(/\|/g, "/");
};
const rows = names.map((n) => {
  const { description } = frontmatter(join(skillsDir, n, "SKILL.md"));
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
