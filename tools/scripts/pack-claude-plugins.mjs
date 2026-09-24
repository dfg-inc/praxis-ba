#!/usr/bin/env node
/**
 * Build Claude UI hosted plugin ZIPs (skills-only; shared MCP lives in Praxis Runtime .mcpb).
 *
 *   node tools/scripts/pack-claude-plugins.mjs --version 0.1.0-alpha.31
 *
 * Layout (archive root):
 *   .claude-plugin/plugin.json
 *   skills/  prompts/
 *   README.md
 *   VERSION
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  PLUGINS,
  MANIFEST_CONTRACT,
  distClaudePluginsDir,
  repoClaudePluginsDir as repoDirFor,
} from "./claude-plugins-shared.mjs";
import {
  checkSafeArchivePath,
  directoryEntriesFor,
  invalidPathError,
  writeZip,
} from "./claude-zip.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function fail(msg) {
  console.error(`claude-plugins: ${msg}`);
  process.exit(1);
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

export function claudePluginsDir(version) {
  return distClaudePluginsDir(root, version);
}

export function repoClaudePluginsDir() {
  return repoDirFor(root);
}

function isJunkName(name) {
  return (
    name === ".DS_Store" ||
    name === "__MACOSX" ||
    name === "Thumbs.db" ||
    name.startsWith("._")
  );
}

function copyTreeFiltered(from, to) {
  if (!existsSync(from)) return;
  const st = lstatSync(from);
  if (st.isSymbolicLink()) {
    fail(`CLAUDE_PLUGIN_SYMLINK: ${from}`);
  }
  if (st.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from).sort()) {
      if (isJunkName(name)) continue;
      if (name === "node_modules") continue;
      if (name === "marketplace.json") continue;
      if (name === "bin") continue;
      copyTreeFiltered(join(from, name), join(to, name));
    }
    return;
  }
  if (!st.isFile()) fail(`CLAUDE_PLUGIN_SPECIAL_FILE: ${from}`);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
}

function collectZipEntries(dest) {
  const files = [];
  function walk(rel) {
    const abs = rel ? join(dest, rel) : dest;
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) fail(`CLAUDE_PLUGIN_SYMLINK: ${rel || "."}`);
    if (st.isDirectory()) {
      for (const name of readdirSync(abs).sort()) {
        if (isJunkName(name)) continue;
        const child = rel ? `${rel}/${name}` : name;
        walk(child.replace(/\\/g, "/"));
      }
      return;
    }
    if (!st.isFile()) fail(`CLAUDE_PLUGIN_SPECIAL_FILE: ${rel}`);
    const name = rel.replace(/\\/g, "/");
    const check = checkSafeArchivePath(name);
    if (!check.ok) fail(invalidPathError(name, check.reason));
    if (name === "bin" || name.startsWith("bin/")) {
      fail(`CLAUDE_HOSTED_PLUGIN_TOP_LEVEL_BIN_FORBIDDEN: ${name}`);
    }
    if (name.includes("node_modules")) {
      fail(`CLAUDE_PLUGIN_NODE_MODULES: ${name}`);
    }
    if (/\.tgz$/i.test(name)) fail(`CLAUDE_PLUGIN_TGZ: ${name}`);
    if (name === ".claude-plugin/marketplace.json") {
      fail(`CLAUDE_HOSTED_PLUGIN_MARKETPLACE_IN_STANDALONE_ZIP: ${name}`);
    }
    files.push({
      name,
      abs,
      mode: 0o644,
    });
  }
  walk("");
  files.sort((a, b) =>
    Buffer.compare(Buffer.from(a.name, "utf8"), Buffer.from(b.name, "utf8")),
  );
  const dirs = directoryEntriesFor(files.map((f) => f.name));
  const entries = [
    ...dirs.map((name) => ({ name, isDir: true, mode: 0o755 })),
    ...files.map((f) => ({
      name: f.name,
      data: readFileSync(f.abs),
      mode: f.mode,
    })),
  ];
  return entries;
}

function pluginReadme(plugin, version) {
  return `# ${plugin.title}

Claude UI / Cowork plugin for Praxis ${version}.

${plugin.title} requires:
- the Praxis Runtime Desktop Extension (\`claude-extensions/praxis-runtime.mcpb\`) installed and enabled
- Jira fields completed in Praxis Runtime settings (token is sensitive; never paste it into chat)
- a supported Claude workspace / Cowork execution surface with project access
- access to the product repository

Do not paste Jira tokens into chat. Do not run \`praxis\`, \`make\`, \`launchctl\`, or edit config files for normal use.

Primary workflow: invoke a role Skill and speak naturally. Tools come from the shared Praxis Runtime MCP, not a per-plugin server.

Claude Chat may show Skills, but local edit/test flow needs workspace/runtime capabilities. If the repository or local runtime is unavailable the tools return \`REPOSITORY_UNAVAILABLE\` or \`LOCAL_RUNTIME_UNAVAILABLE\` instead of pretending work ran.
`;
}

function stagePlugin(plugin, version, stagingRoot) {
  const dest = join(stagingRoot, plugin.id);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const src = join(root, plugin.src);
  copyTreeFiltered(join(src, ".claude-plugin"), join(dest, ".claude-plugin"));
  const market = join(dest, ".claude-plugin", "marketplace.json");
  if (existsSync(market)) rmSync(market);
  for (const skill of plugin.requiredSkills) {
    copyTreeFiltered(join(src, "skills", skill), join(dest, "skills", skill));
  }
  copyTreeFiltered(join(src, "prompts"), join(dest, "prompts"));
  const pluginJsonPath = join(dest, ".claude-plugin", "plugin.json");
  if (!existsSync(pluginJsonPath)) fail(`missing ${pluginJsonPath}`);
  const pluginJson = JSON.parse(readFileSync(pluginJsonPath, "utf8"));
  pluginJson.version = version;
  if (pluginJson.mcpServers) delete pluginJson.mcpServers;
  writeFileSync(pluginJsonPath, `${JSON.stringify(pluginJson, null, 2)}\n`);
  writeFileSync(join(dest, "VERSION"), `${version}\n`);
  writeFileSync(join(dest, "README.md"), pluginReadme(plugin, version));
  // Ship applicable OSS license texts with the distributable ZIP (Apache-2.0 requires NOTICE/LICENSE with redistributions).
  for (const name of ["LICENSE", "LICENSE.txt", "NOTICE", "NOTICE.txt"]) {
    const lic = join(src, name);
    if (existsSync(lic)) cpSync(lic, join(dest, name));
  }
  if (existsSync(join(dest, ".mcp.json"))) rmSync(join(dest, ".mcp.json"));
  if (existsSync(join(dest, "runtime"))) rmSync(join(dest, "runtime"), { recursive: true, force: true });
  return dest;
}

function buildManifest(version, zips) {
  return {
    contract: MANIFEST_CONTRACT,
    version,
    plugins: zips.map((z) => ({
      name: z.title,
      file: z.file,
      sha256: z.sha256,
      version,
    })),
  };
}

export async function packClaudePlugins(version) {
  if (!version) fail("version required");
  const pkgVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  if (version !== pkgVersion) {
    fail(`VERSION ${version} must match package.json ${pkgVersion}`);
  }
  const outDir = claudePluginsDir(version);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const staging = join(root, "dist", "claude-plugins-staging", version);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const zips = [];
  for (const plugin of PLUGINS) {
    const dest = stagePlugin(plugin, version, staging);
    const entries = collectZipEntries(dest);
    const zipBuf = writeZip(entries, { enforcePolicy: true });
    const zipPath = join(outDir, `${plugin.id}.zip`);
    writeFileSync(zipPath, zipBuf);
    zips.push({
      id: plugin.id,
      title: plugin.title,
      file: `${plugin.id}.zip`,
      sha256: sha256(zipBuf),
      bytes: zipBuf.length,
      requiredSkills: plugin.requiredSkills,
    });
  }
  const manifest = buildManifest(version, zips);
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`claude-plugins packed -> ${outDir}`);
  return { outDir, manifest };
}

export { PLUGINS, buildManifest };

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--version");
  const version =
    (i >= 0 ? argv[i + 1] : undefined) ||
    process.env.VERSION ||
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  packClaudePlugins(version).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
