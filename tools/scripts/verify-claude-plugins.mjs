#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import {
  MANIFEST_CONTRACT,
  PLUGINS,
  distClaudePluginsDir,
} from "./claude-plugins-shared.mjs";
import { extractZip } from "./claude-zip.mjs";
import {
  inspectHostedZipBuffer,
  validateExtractedHostedPlugin,
} from "./hosted-plugin-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function fail(msg) {
  console.error(`verify-claude-plugins: ${msg}`);
  process.exit(1);
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function findClaudeBin() {
  const r = spawnSync("command -v claude", {
    shell: true,
    encoding: "utf8",
    env: process.env,
  });
  const p = (r.stdout || "").trim();
  return p && r.status === 0 ? p : "";
}

function runClaudeValidate(unpack) {
  const bin = findClaudeBin();
  if (!bin) return { status: "not-installed" };
  const r = spawnSync(bin, ["plugin", "validate", unpack, "--strict"], {
    encoding: "utf8",
    env: process.env,
  });
  const out = `${r.stdout || ""}\n${r.stderr || ""}`;
  if ((r.status ?? 1) !== 0) {
    return { status: "FAIL", output: out.trim() };
  }
  return { status: "PASS", output: out.trim() };
}

export async function verifyClaudePluginZip(zipPath, plugin, version, tmp) {
  if (!existsSync(zipPath)) fail(`missing ${zipPath}`);
  const buf = readFileSync(zipPath);
  const inspected = inspectHostedZipBuffer(buf);
  if (inspected.issues.length) {
    fail(`${plugin.id}\n${inspected.issues.join("\n")}`);
  }
  const unpack = join(tmp, plugin.id);
  mkdirSync(unpack, { recursive: true });
  extractZip(buf, unpack);

  const issues = validateExtractedHostedPlugin(unpack, plugin, version);
  if (issues.length) fail(`${plugin.id}\n${issues.join("\n")}`);

  const names = inspected.entries.map((e) => e.name.replace(/\/+$/, ""));
  if (names.includes(".mcp.json") || names.some((n) => n.startsWith("runtime/"))) {
    fail(`${plugin.id} still bundles MCP runtime`);
  }
  if (names.includes("bin") || names.some((n) => n.startsWith("bin/"))) {
    fail(`${plugin.id} has top-level bin`);
  }
  const combined = buf.toString("utf8");
  if (/PRAXIS_JIRA_TOKEN=\S+/.test(combined) && !combined.includes("<redacted>")) {
    fail(`${plugin.id} looks like it contains a Jira token`);
  }

  const claudeCli = runClaudeValidate(unpack);
  if (claudeCli.status === "FAIL") {
    fail(`${plugin.id} Claude CLI structural validation FAIL\n${claudeCli.output}`);
  }
  return {
    file: `${plugin.id}.zip`,
    sha256: sha256File(zipPath),
    bytes: buf.length,
    claudeCli: claudeCli.status,
    skills: plugin.requiredSkills,
  };
}

export async function verifyClaudePlugins(
  version,
  dir = distClaudePluginsDir(root, version),
) {
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) fail(`missing ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.version !== version) {
    fail(`manifest version ${manifest.version} != ${version}`);
  }
  if (manifest.contract && manifest.contract !== MANIFEST_CONTRACT) {
    fail(`unexpected manifest contract ${manifest.contract}`);
  }
  const tmpRoot = join(tmpdir(), "praxis-plugin-verify");
  mkdirSync(tmpRoot, { recursive: true });
  const tmp = mkdtempSync(join(tmpRoot, "praxis-plugin-"));
  const pluginReports = [];
  try {
    for (const plugin of PLUGINS) {
      const zip = join(dir, `${plugin.id}.zip`);
      const info = await verifyClaudePluginZip(zip, plugin, version, tmp);
      pluginReports.push(info);
      const listed = (manifest.plugins || []).find(
        (p) => p.file === `${plugin.id}.zip` || p.id === plugin.id,
      );
      if (!listed) fail(`manifest missing ${plugin.id}`);
      if (listed.sha256 && listed.sha256 !== info.sha256) {
        fail(`${plugin.id} manifest sha256 mismatch`);
      }
      if (listed.version && listed.version !== version) {
        fail(`${plugin.id} manifest version mismatch`);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const repoDir = join(root, "claude-plugins");
  const fromRepo = resolve(dir) === resolve(repoDir);
  return {
    ok: true,
    source: fromRepo ? "repository" : "release-bundles",
    version,
    plugins: PLUGINS.map((p) => p.title),
    claudeCli: pluginReports.map((p) => ({ file: p.file, status: p.claudeCli })),
    proven: [
      "no top-level bin directory",
      "standalone plugin manifest valid",
      "skills-only role plugin",
      "no bundled MCP runtime",
      "no runtime node_modules",
      "no symlink entries",
      "safe archive paths",
      "deterministic archive structure",
      "valid Claude plugin manifest",
      "skills packaged",
      "no secrets",
      "no absolute paths",
      "role contract valid",
    ],
    pending: [
      "manual Claude UI upload",
      "manual Cowork local-workspace E2E",
    ],
  };
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--version");
  const version =
    (i >= 0 ? argv[i + 1] : undefined) ||
    process.env.VERSION ||
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  verifyClaudePlugins(version)
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
