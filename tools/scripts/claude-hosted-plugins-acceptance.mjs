#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { packClaudePlugins } from "./pack-claude-plugins.mjs";
import { verifyClaudePlugins } from "./verify-claude-plugins.mjs";
import { writeZip } from "./claude-zip.mjs";
import { inspectHostedZipBuffer, HOSTED_BIN_FORBIDDEN } from "./hosted-plugin-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const check = spawnSync("node tools/scripts/check-skill-cli.mjs", {
  cwd: root,
  shell: true,
  encoding: "utf8",
});
if ((check.status ?? 1) !== 0) fail(check.stderr || check.stdout);

const binFixture = writeZip(
  [
    { name: ".claude-plugin/plugin.json", data: Buffer.from('{"name":"bad"}\n') },
    { name: "bin/praxis", data: Buffer.from("#!/bin/sh\n"), mode: 0o755 },
  ],
  { enforcePolicy: true },
);
const binIssues = inspectHostedZipBuffer(binFixture).issues;
if (!binIssues.some((i) => i.includes(HOSTED_BIN_FORBIDDEN))) {
  fail("plugin-with-bin fixture did not fail hosted policy");
}

await packClaudePlugins(version);
const report = await verifyClaudePlugins(version);
if (!report.ok) fail("verify-claude-plugins failed");
const hosted = {
  ok: true,
  version,
  surface: "claude-ai-hosted-plugin",
  plugins: report.plugins,
  proven: [
    "no top-level bin directory",
    "standalone plugin manifest valid",
    "MCP declaration absent (skills-only)",
    "no bundled MCP runtime",
    "role contract valid",
    "safe archive paths",
    "no node_modules",
    "no tgz",
    "no symlinks",
    "no secrets",
  ],
  pending: [
    "manual Claude UI upload",
    "manual Cowork local-workspace E2E",
  ],
  claudeCliStructuralValidation: report.claudeCli,
  claudeUiUpload: "MANUAL UI ACCEPTANCE PENDING",
};
console.log(JSON.stringify(hosted, null, 2));
