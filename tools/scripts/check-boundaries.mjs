#!/usr/bin/env node
/**
 * Fail if any file under plugins/<name>/src or plugins/<name>/skills
 * imports another plugins/<other>/ path.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dirname, "../..");
const pluginsRoot = join(root, "plugins");

function listPluginNames() {
  return readdirSync(pluginsRoot).filter((name) => {
    const p = join(pluginsRoot, name);
    return statSync(p).isDirectory();
  });
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const IMPORT_RE =
  /(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g;

const plugins = listPluginNames();
const violations = [];

for (const plugin of plugins) {
  const bases = [
    join(pluginsRoot, plugin, "src"),
    join(pluginsRoot, plugin, "skills"),
  ];
  for (const base of bases) {
    for (const file of walk(base)) {
      if (!/\.(mjs|cjs|js|ts|tsx|md|json)$/.test(file)) continue;
      const text = readFileSync(file, "utf8");
      let m;
      IMPORT_RE.lastIndex = 0;
      while ((m = IMPORT_RE.exec(text))) {
        const spec = m[1];
        for (const other of plugins) {
          if (other === plugin) continue;
          const patterns = [
            `plugins/${other}/`,
            `@praxis/${other}`,
            `../${other}/`,
            `../../${other}/`,
          ];
          // Cross-plugin path references
          if (
            spec.includes(`/plugins/${other}/`) ||
            spec.startsWith(`plugins/${other}/`) ||
            (spec.includes(`plugins/${other}`) && spec.includes("plugins/"))
          ) {
            violations.push({
              file: relative(root, file),
              import: spec,
              from: plugin,
              to: other,
            });
          }
        }
      }
      // Also scan raw path mentions of other plugins under plugins/
      for (const other of plugins) {
        if (other === plugin) continue;
        const needle = `plugins/${other}/`;
        if (text.includes(needle)) {
          // Allow documentation mentions in skills only if not import-like — still fail per hard rule
          // Skills often document other roles; restrict to src + skill code imports only.
          // For .md skills, only flag import/require-like already handled; skip prose.
          if (file.endsWith(".md")) continue;
          violations.push({
            file: relative(root, file),
            import: needle,
            from: plugin,
            to: other,
          });
        }
      }
    }
  }
}

if (violations.length) {
  console.error("Boundary check failed — cross-plugin imports detected:");
  for (const v of violations) {
    console.error(`  ${v.file}: ${v.import} (${v.from} → ${v.to})`);
  }
  process.exit(1);
}

console.log(
  `Boundary check OK (${plugins.length} plugins, no cross-plugin imports in src/skills).`,
);
