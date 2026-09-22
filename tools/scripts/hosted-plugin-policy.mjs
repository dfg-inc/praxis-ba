#!/usr/bin/env node
/**
 * Hosted Claude.ai plugin policy (distinct from `claude plugin validate --strict`).
 */
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { extractLeadingFrontmatter } from "./validate-plugins.mjs";
import { parse as yamlParse } from "yaml";
import { inspectZipEntries, parseZip } from "./claude-zip.mjs";

export const HOSTED_BIN_FORBIDDEN = "CLAUDE_HOSTED_PLUGIN_TOP_LEVEL_BIN_FORBIDDEN";

export function parsePluginMcpConfig(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const servers =
    json.mcpServers && typeof json.mcpServers === "object" && !Array.isArray(json.mcpServers)
      ? json.mcpServers
      : json;
  const praxis = servers.praxis;
  if (!praxis || typeof praxis !== "object") return null;
  if (typeof praxis.command !== "string") return null;
  if (!Array.isArray(praxis.args) || !praxis.args.every((a) => typeof a === "string")) return null;
  return { command: praxis.command, args: praxis.args, env: praxis.env };
}

export function resolvePluginPath(raw, pluginRoot) {
  return String(raw).replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginRoot);
}

function walkFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      out.push({ abs, rel: abs, symlink: true });
      continue;
    }
    if (st.isDirectory()) walkFiles(abs, out);
    else out.push({ abs, rel: abs, symlink: false });
  }
  return out;
}

export function inspectHostedZipBuffer(buf) {
  parseZip(buf);
  const inspected = inspectZipEntries(buf);
  const issues = [...inspected.issues];
  for (const e of inspected.entries) {
    const name = e.name.replace(/\/+$/, "");
    if (name === "bin" || name.startsWith("bin/")) {
      issues.push(`${HOSTED_BIN_FORBIDDEN}: ${e.name}`);
    }
    if (name === ".mcp.json" || name.startsWith(".mcp.json")) {
      issues.push(`CLAUDE_HOSTED_PLUGIN_ROLE_MCP_FORBIDDEN: ${e.name}`);
    }
    if (name === "runtime/praxis-mcp.cjs" || name.startsWith("runtime/")) {
      issues.push(`CLAUDE_HOSTED_PLUGIN_ROLE_MCP_FORBIDDEN: ${e.name}`);
    }
    if (name === ".claude-plugin/marketplace.json") {
      issues.push(`CLAUDE_HOSTED_PLUGIN_MARKETPLACE_IN_STANDALONE_ZIP: ${e.name}`);
    }
    if (name.includes("node_modules")) {
      issues.push(`CLAUDE_PLUGIN_NODE_MODULES: ${e.name}`);
    }
    if (/\.tgz$/i.test(name)) issues.push(`CLAUDE_PLUGIN_TGZ: ${e.name}`);
  }
  return { ...inspected, issues };
}

export function validateStandalonePluginJson(pluginJson, version, expectedName) {
  const issues = [];
  if (!pluginJson || typeof pluginJson !== "object") {
    return ["plugin.json is not an object"];
  }
  for (const key of ["name", "version", "description", "license"]) {
    if (!pluginJson[key]) issues.push(`plugin.json missing ${key}`);
  }
  if (expectedName && pluginJson.name !== expectedName) {
    issues.push(`plugin.json name ${pluginJson.name} != ${expectedName}`);
  }
  if (version && pluginJson.version !== version) {
    issues.push(`plugin.json version ${pluginJson.version} != ${version}`);
  }
  if (pluginJson.author && typeof pluginJson.author !== "object" && typeof pluginJson.author !== "string") {
    issues.push("plugin.json author must be string or object");
  }
  if (pluginJson.keywords && !Array.isArray(pluginJson.keywords)) {
    issues.push("plugin.json keywords must be an array");
  }
  if (pluginJson.mcpServers) {
    issues.push("plugin.json must not inline mcpServers; role plugins are skills-only");
  }
  return issues;
}

export function validateExtractedHostedPlugin(unpack, plugin, version) {
  const issues = [];
  const pluginRoot = resolve(unpack);
  if (existsSync(join(pluginRoot, "bin"))) {
    issues.push(`${HOSTED_BIN_FORBIDDEN}: bin/`);
  }
  const pluginJsonPath = join(pluginRoot, ".claude-plugin", "plugin.json");
  if (!existsSync(pluginJsonPath)) {
    issues.push("missing .claude-plugin/plugin.json");
    return issues;
  }
  if (existsSync(join(pluginRoot, ".claude-plugin", "marketplace.json"))) {
    issues.push("standalone ZIP must not include .claude-plugin/marketplace.json");
  }
  let pluginJson;
  try {
    pluginJson = JSON.parse(readFileSync(pluginJsonPath, "utf8"));
  } catch (e) {
    issues.push(`plugin.json parse failed: ${e}`);
    return issues;
  }
  issues.push(...validateStandalonePluginJson(pluginJson, version, plugin.id));
  if (!existsSync(join(pluginRoot, "VERSION"))) issues.push("missing VERSION");
  if (!existsSync(join(pluginRoot, "README.md"))) issues.push("missing README.md");
  if (existsSync(join(pluginRoot, ".mcp.json"))) {
    issues.push("CLAUDE_HOSTED_PLUGIN_ROLE_MCP_FORBIDDEN: .mcp.json (use Praxis Runtime MCPB)");
  }
  if (existsSync(join(pluginRoot, "runtime"))) {
    issues.push("CLAUDE_HOSTED_PLUGIN_ROLE_MCP_FORBIDDEN: runtime/ (use Praxis Runtime MCPB)");
  }
  if (existsSync(join(pluginRoot, "runtime", "node_modules"))) {
    issues.push("runtime/node_modules present");
  }
  if (existsSync(join(pluginRoot, "runtime", "praxis-runtime.cjs"))) {
    issues.push("hosted ZIP should not ship unused CLI runtime praxis-runtime.cjs");
  }
  for (const skill of plugin.requiredSkills) {
    const skillMd = join(pluginRoot, "skills", skill, "SKILL.md");
    if (!existsSync(skillMd)) {
      issues.push(`missing skill ${skill}`);
      continue;
    }
    const raw = readFileSync(skillMd, "utf8");
    const fm = extractLeadingFrontmatter(raw);
    if (!fm || fm.error) issues.push(`SKILL.md parse failed ${skill}: ${fm?.error}`);
    else yamlParse(fm.yaml);
    if (/\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/praxis|\bbin\/praxis\b/.test(raw)) {
      issues.push(`skill ${skill} still instructs bin/praxis`);
    }
    if (/launchctl setenv|source \.env/.test(raw)) {
      issues.push(`skill ${skill} still instructs shell env / launchctl`);
    }
    if (!raw.includes("praxis_doctor") && !raw.includes("praxis_")) {
      issues.push(`skill ${skill} does not mention MCP tools`);
    }
    if (!raw.includes("PRAXIS_RUNTIME_UNAVAILABLE")) {
      issues.push(`skill ${skill} missing PRAXIS_RUNTIME_UNAVAILABLE`);
    }
  }
  const prompts = join(pluginRoot, "prompts");
  if (!existsSync(prompts) || readdirSync(prompts).length === 0) {
    issues.push("missing prompts");
  }
  for (const file of walkFiles(pluginRoot)) {
    const rel = file.abs.slice(pluginRoot.length).replace(/\\/g, "/");
    if (file.symlink) issues.push(`CLAUDE_PLUGIN_SYMLINK: ${rel}`);
    if (rel.includes("/.env") || /(^|\/)\.env(\.|$)/.test(rel)) {
      issues.push(`secret-like file ${rel}`);
    }
    if (!file.symlink && existsSync(file.abs) && lstatSync(file.abs).isFile()) {
      const text = readFileSync(file.abs, "utf8");
      if (text.includes("PRAXIS_JIRA_TOKEN=") && /PRAXIS_JIRA_TOKEN=\S+/.test(text) && !text.includes("<redacted>")) {
        issues.push(`token-like content in ${rel}`);
      }
      if (text.includes("/Users/")) issues.push(`absolute /Users path in ${rel}`);
    }
  }
  return issues;
}

export function hostedBinFixtureIssues() {
  return [`${HOSTED_BIN_FORBIDDEN}: bin/praxis`];
}
