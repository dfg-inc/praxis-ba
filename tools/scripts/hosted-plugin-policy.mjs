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
import { inspectZipEntries, parseZip, readLocalFile } from "./claude-zip.mjs";

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


function extractZipFiles(buf) {
  return parseZip(buf)
    .entries.filter((e) => e.fileType === "file")
    .map((e) => ({ name: e.name, data: readLocalFile(buf, e) }));
}

/** Claude Desktop's upload validator limits (name format, description length) for skills. */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 1024;
/** Anything shaped like an XML/HTML tag, e.g. <id>, </tag>, <br/>. Comparisons such as "a < b" do not match. */
export const XML_LIKE_TAG = /<\/?[A-Za-z][^<>]*>/;

/**
 * Checks one SKILL.md the way the hosted upload validator is known or likely to: strict YAML frontmatter, required
 * string name/description, name format and length, description length, and no XML-like tags in the description.
 * The server does not publish its rules; XML-like tags in descriptions are the violation confirmed by Anthropic's
 * skill authoring documentation and by the praxis-ba incident (two descriptions containing `<id>`).
 * @returns {string[]} issues, each prefixed with the skill directory name
 */
export function validateSkillForUpload(raw, dirName) {
  const issues = [];
  const at = (msg) => `skill ${dirName}: ${msg}`;
  const fm = extractLeadingFrontmatter(raw);
  if (!fm || fm.error) return [at(`frontmatter ${fm?.error ?? "missing"}`)];
  let data;
  try {
    data = yamlParse(fm.yaml);
  } catch (e) {
    return [at(`frontmatter is not valid YAML: ${String(e.message).split("\n")[0]}`)];
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return [at("frontmatter must be a YAML mapping")];
  const { name, description } = data;
  if (typeof name !== "string" || !name.trim()) issues.push(at("missing required string 'name'"));
  else {
    if (name.length > SKILL_NAME_MAX) issues.push(at(`name is ${name.length} chars (max ${SKILL_NAME_MAX})`));
    if (!SKILL_NAME_PATTERN.test(name)) issues.push(at(`name '${name}' must be lowercase letters, digits and hyphens`));
    if (name !== dirName) issues.push(at(`name '${name}' does not match directory '${dirName}'`));
    if (/anthropic|claude/.test(name)) issues.push(at(`name '${name}' contains a reserved word`));
  }
  if (typeof description !== "string" || !description.trim()) issues.push(at("missing required string 'description'"));
  else {
    if (description.length > SKILL_DESCRIPTION_MAX) {
      issues.push(at(`description is ${description.length} chars (max ${SKILL_DESCRIPTION_MAX})`));
    }
    const tag = description.match(XML_LIKE_TAG);
    if (tag) issues.push(at(`description contains an XML-like tag ${tag[0]}; use {id} or plain words`));
  }
  return issues;
}

/** Skill names must be unique across the plugin. */
export function duplicateSkillNames(skills) {
  const seen = new Map();
  const issues = [];
  for (const { dirName, raw } of skills) {
    let name;
    try {
      name = yamlParse(extractLeadingFrontmatter(raw)?.yaml ?? "")?.name;
    } catch {
      continue;
    }
    if (typeof name !== "string") continue;
    if (seen.has(name)) issues.push(`duplicate skill name '${name}' in ${seen.get(name)} and ${dirName}`);
    else seen.set(name, dirName);
  }
  return issues;
}

/**
 * ZIP-level checks every Claude Desktop plugin upload must pass, whatever skills it carries: safe paths, no symlinks,
 * no nested archives, no node_modules/tgz, plugin.json at .claude-plugin/plugin.json, valid and unique skills.
 * Unlike inspectHostedZipBuffer it does not apply the skills-only hosted-runtime policy (no role MCP, no bin/).
 */
export function inspectUploadZipBuffer(buf) {
  const inspected = inspectZipEntries(buf);
  const issues = [...inspected.issues];
  let hasPluginJson = false;
  for (const e of inspected.entries) {
    const name = e.name.replace(/\/+$/, "");
    if (name === ".claude-plugin/plugin.json") hasPluginJson = true;
    if (name === ".claude-plugin/marketplace.json") issues.push(`CLAUDE_HOSTED_PLUGIN_MARKETPLACE_IN_STANDALONE_ZIP: ${e.name}`);
    if (name.includes("node_modules")) issues.push(`CLAUDE_PLUGIN_NODE_MODULES: ${e.name}`);
    if (/\.tgz$/i.test(name)) issues.push(`CLAUDE_PLUGIN_TGZ: ${e.name}`);
    if (/\.zip$/i.test(name)) issues.push(`CLAUDE_PLUGIN_NESTED_ZIP: ${e.name}`);
    if (/(^|\/)(\.DS_Store|__MACOSX|Thumbs\.db)$|(^|\/)\._/.test(name)) issues.push(`CLAUDE_PLUGIN_JUNK: ${e.name}`);
    if (/(^|\/)\.env(\.|$)/.test(name)) issues.push(`secret-like file ${e.name}`);
  }
  if (!hasPluginJson) issues.push("missing .claude-plugin/plugin.json at the archive root");
  const skills = [];
  for (const file of extractZipFiles(buf)) {
    const m = file.name.match(/^skills\/([^/]+)\/SKILL\.md$/);
    if (!m) continue;
    const raw = file.data.toString("utf8");
    skills.push({ dirName: m[1], raw });
    issues.push(...validateSkillForUpload(raw, m[1]));
  }
  issues.push(...duplicateSkillNames(skills));
  return { ...inspected, issues, skillCount: skills.length };
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
    if (/\.zip$/i.test(name)) issues.push(`CLAUDE_PLUGIN_NESTED_ZIP: ${e.name}`);
  }
  const skills = [];
  for (const file of extractZipFiles(buf)) {
    const m = file.name.match(/^skills\/([^/]+)\/SKILL\.md$/);
    if (!m) continue;
    const raw = file.data.toString("utf8");
    skills.push({ dirName: m[1], raw });
    issues.push(...validateSkillForUpload(raw, m[1]));
  }
  issues.push(...duplicateSkillNames(skills));
  return { ...inspected, issues, skillCount: skills.length };
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
    issues.push(...validateSkillForUpload(raw, skill));
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
