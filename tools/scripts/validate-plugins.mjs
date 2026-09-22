#!/usr/bin/env node
/**
 * Strict plugin metadata / frontmatter validation.
 *
 * Discovers shipped Markdown with YAML frontmatter under plugin trees
 * (skills / agents / hooks) and JSON manifests under `.claude-plugin/`.
 * Parses frontmatter with a strict YAML engine — the same class of check
 * Claude Code's `plugin validate` does NOT cover for SKILL.md files.
 *
 * Usage:
 *   node tools/scripts/validate-plugins.mjs
 *   node tools/scripts/validate-plugins.mjs --root plugins
 *   node tools/scripts/validate-plugins.mjs --root dist/release-mirror/plugins
 *
 * Exit 0 on PASS; exit 1 with per-file errors on FAIL.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as yamlParse } from "yaml";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  "tmp",
  "vendor",
  "canon-graph", // BA engine source/tests — not shipped Claude skill surface
]);

const METADATA_DIR_NAMES = new Set(["skills", "agents", "hooks"]);

export function extractLeadingFrontmatter(raw) {
  if (!raw.startsWith("---")) return null;
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { error: "unclosed or malformed leading YAML frontmatter fence" };
  }
  const rest = raw.slice(match[0].length);
  if (/^\s*---\r?\n/.test(rest)) {
    return { error: "duplicate leading YAML frontmatter block" };
  }
  return { yaml: match[1], rawBlock: match[0] };
}

function walkFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      walkFiles(abs, out);
    } else if (entry.isFile()) {
      out.push(abs);
    }
  }
  return out;
}

function isShippedMarkdown(abs, root) {
  const rel = relative(root, abs).split(/[/\\]/);
  if (!abs.endsWith(".md")) return false;
  return rel.some((part) => METADATA_DIR_NAMES.has(part));
}

function isManifestJson(abs) {
  if (!abs.endsWith(".json")) return false;
  const norm = abs.replace(/\\/g, "/");
  return (
    norm.includes("/.claude-plugin/plugin.json") ||
    norm.includes("/.claude-plugin/marketplace.json")
  );
}

function validateSkillOrAgentFrontmatter(data, kind, rel) {
  const issues = [];
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    issues.push(`${rel}: frontmatter must be a YAML mapping`);
    return issues;
  }
  const name = data.name;
  const description = data.description;
  if (typeof name !== "string" || name.trim().length === 0) {
    issues.push(`${rel}: missing required string field 'name'`);
  }
  if (typeof description !== "string" || description.trim().length === 0) {
    issues.push(`${rel}: missing required string field 'description'`);
  }
  if (kind === "skill") {
    const base = rel.split(/[/\\]/).at(-2);
    if (typeof name === "string" && base && name !== base) {
      issues.push(
        `${rel}: skill frontmatter name '${name}' must match directory '${base}'`,
      );
    }
  }
  return issues;
}

/**
 * Validate one plugin root (e.g. plugins/ba or dist/release-mirror/plugins/ba).
 * @returns {{ ok: boolean, checked: number, errors: string[] }}
 */
export function validatePluginTree(pluginRoot) {
  const errors = [];
  let checked = 0;
  const files = walkFiles(pluginRoot);

  for (const abs of files) {
    const rel = relative(pluginRoot, abs);

    if (isManifestJson(abs)) {
      checked++;
      try {
        const data = JSON.parse(readFileSync(abs, "utf8"));
        if (typeof data !== "object" || data === null) {
          errors.push(`${rel}: JSON manifest must be an object`);
        }
      } catch (err) {
        errors.push(`${rel}: invalid JSON — ${err.message}`);
      }
      continue;
    }

    if (!isShippedMarkdown(abs, pluginRoot)) continue;

    const raw = readFileSync(abs, "utf8");
    if (!raw.startsWith("---")) {
      // Hooks may be prose-only; skills/agents must have frontmatter.
      if (/[/\\]skills[/\\]/.test(abs) || /[/\\]agents[/\\]/.test(abs)) {
        errors.push(`${rel}: expected leading YAML frontmatter`);
      }
      continue;
    }

    checked++;
    const extracted = extractLeadingFrontmatter(raw);
    if (extracted.error) {
      errors.push(`${rel}: ${extracted.error}`);
      continue;
    }

    let data;
    try {
      data = yamlParse(extracted.yaml, { strict: true });
    } catch (err) {
      errors.push(`${rel}: strict YAML parse failed — ${err.message}`);
      continue;
    }

    if (/[/\\]skills[/\\]/.test(abs)) {
      errors.push(...validateSkillOrAgentFrontmatter(data, "skill", rel));
    } else if (/[/\\]agents[/\\]/.test(abs)) {
      errors.push(...validateSkillOrAgentFrontmatter(data, "agent", rel));
    }
  }

  return { ok: errors.length === 0, checked, errors };
}

/**
 * Validate every plugin under `pluginsRoot` (ba/architect/developer/jira).
 */
export function validatePluginsRoot(pluginsRoot) {
  const absRoot = resolve(pluginsRoot);
  if (!existsSync(absRoot)) {
    return {
      ok: false,
      checked: 0,
      errors: [`plugins root does not exist: ${absRoot}`],
      plugins: [],
    };
  }

  const pluginIds = readdirSync(absRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !SKIP_DIR_NAMES.has(d.name))
    .map((d) => d.name)
    .sort();

  const report = { ok: true, checked: 0, errors: [], plugins: [] };
  for (const id of pluginIds) {
    const result = validatePluginTree(join(absRoot, id));
    report.checked += result.checked;
    report.plugins.push({ id, ...result });
    if (!result.ok) {
      report.ok = false;
      for (const err of result.errors) {
        report.errors.push(`${id}: ${err}`);
      }
    }
  }
  return report;
}

function parseArgs(argv) {
  const rootIdx = argv.indexOf("--root");
  const root =
    rootIdx >= 0 && argv[rootIdx + 1]
      ? resolve(argv[rootIdx + 1])
      : join(repoRoot, "plugins");
  return { root };
}

function main() {
  const { root } = parseArgs(process.argv.slice(2));
  const report = validatePluginsRoot(root);
  if (!report.ok) {
    console.error(`plugins:validate FAIL — ${report.errors.length} issue(s)`);
    for (const err of report.errors) console.error(`  ${err}`);
    process.exit(1);
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        root,
        checked: report.checked,
        plugins: report.plugins.map((p) => ({
          id: p.id,
          checked: p.checked,
          ok: p.ok,
        })),
      },
      null,
      2,
    ),
  );
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) main();
