#!/usr/bin/env node
/**
 * Stage self-contained plugin release artifacts under dist/release-mirror/plugins/.
 *
 * Distribution model:
 * - BA / Architect / Developer: Claude Code plugin dirs + tools; @praxis/*
 *   runtime (plugin-sdk chain, BA canon-graph CLI) is esbuild-bundled so the
 *   artifact runs without the Praxis monorepo or public @praxis registry.
 * - Jira: compiled dist/ + skills + manifests (no @praxis runtime deps).
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as esbuild from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const PLUGIN_IDS = ["ba"];

/** Paths that must exist inside each staged artifact (relative). */
export const REQUIRED_PATHS = {
  ba: [
    ".claude-plugin/plugin.json",
    "package.json",
    "LICENSE",
    "README.md",
    "bin/praxis-ba.cjs",
    "tools/session-bootstrap.cjs",
    "tools/emit-architect-handoff.mjs",
    "tools/one-pager.mjs",
    "tools/record-reject.mjs",
    "hooks/session-start.md",
    "skills",
    "templates",
    "rules",
    "prompts/jira-role.md",
  ],
  architect: [
    ".claude-plugin/plugin.json",
    "package.json",
    "LICENSE",
    "README.md",
    "tools/session-bootstrap.cjs",
    "tools/build-architecture-package.mjs",
    "tools/emit-developer-handoff.mjs",
    "tools/lib/architecture-package.mjs",
    "tools/architecture-governance.mjs",
    "tools/lib/architecture-governance.mjs",
    "hooks/session-start.md",
    "agents",
    "skills",
    "templates",
    "prompts/jira-role.md",
  ],
  developer: [
    ".claude-plugin/plugin.json",
    "package.json",
    "LICENSE",
    "README.md",
    "tools/session-bootstrap.cjs",
    "tools/final-arbiter.mjs",
    "tools/run-work-package.mjs",
    "tools/accept-work-package.mjs",
    "tools/request-architecture-deviation.mjs",
    "tools/developer-governance.mjs",
    "tools/lib/developer-governance.mjs",
    "tools/lib/apply-change-spec.mjs",
    "tools/lib/frontmatter.mjs",
    "tools/lib/acceptance-journal.mjs",
    "tools/lib/readiness.mjs",
    "hooks/session-start.md",
    "agents",
    "skills",
    "prompts/jira-role.md",
  ],
  jira: [
    ".claude-plugin/plugin.json",
    "package.json",
    "README.md",
    "dist/index.js",
    "dist/index.d.ts",
    "skills",
  ],
  quality: [
    ".claude-plugin/plugin.json",
    "package.json",
    "README.md",
    "tools/session-bootstrap.cjs",
    "tools/qa-verify.cjs",
    "hooks/session-start.md",
    "skills",
    "prompts/jira-role.md",
  ],
};

function readJson(abs) {
  return JSON.parse(readFileSync(abs, "utf8"));
}

function writeJson(abs, data) {
  writeFileSync(abs, JSON.stringify(data, null, 2) + "\n");
}

function ensureDir(abs) {
  mkdirSync(abs, { recursive: true });
}

function copyIfExists(src, dest) {
  if (!existsSync(src)) return false;
  ensureDir(dirname(dest));
  cpSync(src, dest, { recursive: true });
  return true;
}

/** Rewrite session-bootstrap.mjs → .cjs references inside a staged artifact tree. */
function rewriteBootstrapDocs(dir) {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const name of readdirSync(cur)) {
      if (name === "node_modules") continue;
      const p = join(cur, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (!/\.(md|json|mjs|cjs|txt)$/i.test(name)) continue;
      const before = readFileSync(p, "utf8");
      if (!before.includes("session-bootstrap.mjs")) continue;
      writeFileSync(
        p,
        before.replaceAll("session-bootstrap.mjs", "session-bootstrap.cjs"),
      );
    }
  }
}

function bundleSessionBootstrap(srcPluginDir, destToolsDir) {
  ensureDir(destToolsDir);
  bundleNodeEntry({
    entry: join(srcPluginDir, "tools/session-bootstrap.mjs"),
    outfile: join(destToolsDir, "session-bootstrap.cjs"),
    format: "cjs",
  });
}

function run(cmd, cwd = root) {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: "utf8" });
  return {
    ok: (r.status ?? 1) === 0,
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

/**
 * Bundle an entry to a single Node file.
 * For BA CLI (top-level await), pass `rewriteTopLevelAwait: true` to generate
 * a temporary CJS-safe wrapper next to the entry.
 */
export function bundleNodeEntry({
  entry,
  outfile,
  format = "cjs",
  rewriteTopLevelAwait = false,
}) {
  ensureDir(dirname(outfile));
  let buildEntry = entry;
  let cleanup = null;

  if (rewriteTopLevelAwait) {
    const wrap = join(dirname(entry), ".praxis-bundle-entry.mjs");
    writeFileSync(
      wrap,
      `#!/usr/bin/env node
import { runCli } from '../dist/cli.js'

const argv = process.argv.slice(2)
const wantsJson = argv.includes('--json')

runCli(argv).then(({ code, json }) => {
  if (wantsJson) {
    console.log(JSON.stringify(json))
  } else if (json.checks.length === 1 && ['prd', 'rtm', 'backlog'].includes(json.checks[0].name)) {
    console.log(json.checks[0].reason)
  } else {
    console.log(json.verdict)
    for (const c of json.checks) {
      console.log(\`  \${c.ok ? 'ok  ' : 'FAIL'}  \${c.name}: \${c.reason}\`)
    }
    if (json.id) console.log(\`id: \${json.id}\`)
    if (json.path) console.log(\`path: \${json.path}\`)
  }
  process.exitCode = code
}).catch((err) => {
  console.error(err)
  process.exitCode = 1
})
`,
    );
    buildEntry = wrap;
    cleanup = wrap;
  }

  const entryText = readFileSync(buildEntry, "utf8");
  const bannerJs = [];
  if (format === "cjs" && !entryText.startsWith("#!")) {
    bannerJs.push("#!/usr/bin/env node");
  }
  if (format === "cjs") {
    bannerJs.push(
      "var __import_meta_url = require('url').pathToFileURL(__filename).href;",
    );
  }

  try {
    esbuild.buildSync({
      entryPoints: [buildEntry],
      bundle: true,
      platform: "node",
      format,
      target: ["node20"],
      outfile,
      banner: bannerJs.length ? { js: bannerJs.join("\n") } : undefined,
      define:
        format === "cjs"
          ? { "import.meta.url": "__import_meta_url" }
          : undefined,
      logLevel: "silent",
    });
  } catch (err) {
    throw new Error(`esbuild failed for ${entry}:\n${err}`);
  } finally {
    if (cleanup && existsSync(cleanup)) {
      try {
        rmSync(cleanup, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
  if (existsSync(outfile)) {
    try {
      chmodSync(outfile, 0o755);
    } catch {
      /* ignore */
    }
  }
}

function stripWorkspaceDeps(pkg) {
  const next = structuredClone(pkg);
  for (const section of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    if (!next[section]) continue;
    for (const name of Object.keys(next[section])) {
      if (name.startsWith("@praxis/")) delete next[section][name];
    }
    if (Object.keys(next[section]).length === 0) delete next[section];
  }
  // Staged artifacts are installable packages for consumers / npm pack checks.
  delete next.private;
  return next;
}

function assertBuilt(relPath) {
  const abs = join(root, relPath);
  if (!existsSync(abs)) {
    throw new Error(`missing build output: ${relPath} — run npm run build first`);
  }
}

export function stagePlugin(id, outPluginsDir) {
  const src = join(root, "plugins", id);
  const dest = join(outPluginsDir, id);
  rmSync(dest, { recursive: true, force: true });
  ensureDir(dest);

  if (id === "ba") {
    assertBuilt("plugins/ba/canon-graph/dist/cli.js");
    const pkg = stripWorkspaceDeps(readJson(join(src, "package.json")));
    pkg.files = [
      ".claude-plugin",
      "bin",
      "hooks",
      "rules",
      "skills",
      "templates",
      "prompts",
      "tools",
      "LICENSE",
      "README.md",
    ];
    pkg.bin = { "praxis-ba": "./bin/praxis-ba.cjs" };
    pkg.scripts = {
      "session-bootstrap": "node ./tools/session-bootstrap.cjs",
    };
    writeJson(join(dest, "package.json"), pkg);

    for (const f of [
      "LICENSE",
      "README.md",
      ".claude-plugin/plugin.json",
      ".claude-plugin/marketplace.json",
    ]) {
      copyIfExists(join(src, f), join(dest, f));
    }
    for (const dir of ["skills", "templates", "hooks", "rules", "prompts"]) {
      copyIfExists(join(src, dir), join(dest, dir));
    }
    ensureDir(join(dest, "tools"));
    for (const name of readdirSync(join(src, "tools"))) {
      if (name === "session-bootstrap.mjs") continue;
      // Packaged BA is Node-only — never ship Python lint helpers.
      if (name.endsWith(".py") || name.endsWith(".pyc")) continue;
      cpSync(join(src, "tools", name), join(dest, "tools", name), {
        recursive: true,
      });
    }
    bundleSessionBootstrap(src, join(dest, "tools"));
    rewriteBootstrapDocs(dest);
    ensureDir(join(dest, "bin"));
    bundleNodeEntry({
      entry: join(src, "canon-graph/bin/praxis-ba.mjs"),
      outfile: join(dest, "bin/praxis-ba.cjs"),
      format: "cjs",
      rewriteTopLevelAwait: true,
    });
    return dest;
  }

  if (id === "quality") {
    assertBuilt("plugins/jira/dist/index.js");
    const pkg = stripWorkspaceDeps(readJson(join(src, "package.json")));
    pkg.files = [".claude-plugin", "hooks", "skills", "prompts", "tools", "README.md"];
    pkg.scripts = {
      "session-bootstrap": "node ./tools/session-bootstrap.cjs",
      "qa-verify": "node ./tools/qa-verify.cjs",
    };
    writeJson(join(dest, "package.json"), pkg);
    for (const f of [
      "README.md",
      ".claude-plugin/plugin.json",
      ".claude-plugin/marketplace.json",
    ]) {
      copyIfExists(join(src, f), join(dest, f));
    }
    for (const dir of ["hooks", "skills", "prompts"]) {
      copyIfExists(join(src, dir), join(dest, dir));
    }
    ensureDir(join(dest, "tools"));
    bundleSessionBootstrap(src, join(dest, "tools"));
    bundleNodeEntry({
      entry: join(src, "tools/qa-verify.mjs"),
      outfile: join(dest, "tools/qa-verify.cjs"),
      format: "cjs",
    });
    rewriteBootstrapDocs(dest);
    return dest;
  }

  if (id === "architect" || id === "developer") {
    const pkg = stripWorkspaceDeps(readJson(join(src, "package.json")));
    const files =
      id === "architect"
        ? [
            ".claude-plugin",
            "agents",
            "hooks",
            "skills",
            "templates",
            "prompts",
            "tools",
            "LICENSE",
            "README.md",
          ]
        : [
            ".claude-plugin",
            "agents",
            "hooks",
            "skills",
            "prompts",
            "tools",
            "LICENSE",
            "README.md",
          ];
    pkg.files = files;
    if (id === "architect") {
      pkg.scripts = {
        "build-package": "node ./tools/build-architecture-package.mjs",
        "emit-developer-handoff": "node ./tools/emit-developer-handoff.mjs",
        "session-bootstrap": "node ./tools/session-bootstrap.cjs",
      };
    } else {
      pkg.scripts = {
        "accept-work-package": "node ./tools/accept-work-package.mjs",
        "developer-governance": "node ./tools/developer-governance.mjs",
        "final-arbiter": "node ./tools/final-arbiter.mjs",
        "request-architecture-deviation": "node ./tools/request-architecture-deviation.mjs",
        "run-work-package": "node ./tools/run-work-package.mjs",
        "session-bootstrap": "node ./tools/session-bootstrap.cjs",
      };
    }
    writeJson(join(dest, "package.json"), pkg);

    for (const f of [
      "LICENSE",
      "README.md",
      ".claude-plugin/plugin.json",
      ".claude-plugin/marketplace.json",
    ]) {
      copyIfExists(join(src, f), join(dest, f));
    }
    for (const dir of id === "architect"
      ? ["agents", "hooks", "skills", "templates", "prompts"]
      : ["agents", "hooks", "skills", "prompts"]) {
      copyIfExists(join(src, dir), join(dest, dir));
    }
    ensureDir(join(dest, "tools"));
    for (const name of readdirSync(join(src, "tools"))) {
      if (name === "session-bootstrap.mjs") continue;
      cpSync(join(src, "tools", name), join(dest, "tools", name), {
        recursive: true,
      });
    }
    bundleSessionBootstrap(src, join(dest, "tools"));
    rewriteBootstrapDocs(dest);
    return dest;
  }

  if (id === "jira") {
    assertBuilt("plugins/jira/dist/index.js");
    const pkg = stripWorkspaceDeps(readJson(join(src, "package.json")));
    pkg.files = [".claude-plugin", "dist", "skills", "README.md"];
    pkg.scripts = {};
    delete pkg.devDependencies;
    writeJson(join(dest, "package.json"), pkg);

    for (const f of [
      "README.md",
      ".claude-plugin/plugin.json",
      ".claude-plugin/marketplace.json",
    ]) {
      copyIfExists(join(src, f), join(dest, f));
    }
    copyIfExists(join(src, "dist"), join(dest, "dist"));
    copyIfExists(join(src, "skills"), join(dest, "skills"));
    return dest;
  }

  throw new Error(`unknown plugin id: ${id}`);
}

export function assertRequiredPaths(pluginDir, id) {
  const missing = [];
  for (const rel of REQUIRED_PATHS[id] ?? []) {
    if (!existsSync(join(pluginDir, rel))) missing.push(rel);
  }
  return missing;
}

/**
 * Collect package.json path references that must exist on disk inside artifact.
 */
export function collectPackagePathRefs(pkg) {
  const refs = [];
  if (pkg.main) refs.push(pkg.main);
  if (pkg.types) refs.push(pkg.types);
  if (pkg.bin) {
    for (const v of Object.values(pkg.bin)) refs.push(v);
  }
  if (pkg.exports) {
    const walk = (node) => {
      if (typeof node === "string") refs.push(node);
      else if (node && typeof node === "object") {
        for (const v of Object.values(node)) walk(v);
      }
    };
    walk(pkg.exports);
  }
  if (pkg.scripts) {
    for (const cmd of Object.values(pkg.scripts)) {
      const m = String(cmd).match(/node\s+(\.\/\S+)/);
      if (m) refs.push(m[1]);
    }
  }
  return [...new Set(refs.map((r) => r.replace(/^\.\//, "")))];
}

export function buildAllPluginArtifacts(outRoot = join(root, "dist/release-mirror")) {
  // Ensure runtime builds exist
  const build = run(
  "npm run build --workspaces --if-present",
  );
  if (!build.ok) {
    throw new Error(`prerequisite build failed:\n${build.stderr || build.stdout}`);
  }

  const outPlugins = join(outRoot, "plugins");
  ensureDir(outPlugins);
  const results = {};
  for (const id of PLUGIN_IDS) {
    const dest = stagePlugin(id, outPlugins);
    const missing = assertRequiredPaths(dest, id);
    if (missing.length) {
      throw new Error(`${id}: missing required paths: ${missing.join(", ")}`);
    }
    const pkg = readJson(join(dest, "package.json"));
    const refs = collectPackagePathRefs(pkg);
    const missingRefs = refs.filter((r) => !existsSync(join(dest, r)));
    if (missingRefs.length) {
      throw new Error(
        `${id}: package.json references missing files: ${missingRefs.join(", ")}`,
      );
    }
    results[id] = { dest, refs };
  }
  return results;
}

export { root, run };
