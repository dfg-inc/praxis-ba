import { describe, expect, it } from "vitest";
import { writeZip } from "./claude-zip.mjs";
import {
  HOSTED_BIN_FORBIDDEN,
  inspectHostedZipBuffer,
  parsePluginMcpConfig,
  validateStandalonePluginJson,
} from "./hosted-plugin-policy.mjs";

describe("hosted plugin policy", () => {
  it("rejects plugin-with-bin/bin/praxis", () => {
    const buf = writeZip([
      { name: ".claude-plugin/plugin.json", data: Buffer.from('{"name":"fixture"}\n') },
      { name: "bin/praxis", data: Buffer.from("#!/bin/sh\n"), mode: 0o755 },
    ]);
    const { issues } = inspectHostedZipBuffer(buf);
    expect(issues.some((i) => i.includes(HOSTED_BIN_FORBIDDEN))).toBe(true);
  });

  it("accepts skills-only hosted layout", () => {
    const buf = writeZip([
      {
        name: ".claude-plugin/plugin.json",
        data: Buffer.from(
          JSON.stringify({
            name: "praxis-architect",
            version: "0.1.0-alpha.31",
            description: "Architect",
            author: { name: "dfuture-co" },
            license: "Apache-2.0",
            keywords: ["praxis"],
          }),
        ),
      },
      { name: "skills/architecture-status/SKILL.md", data: Buffer.from("# Architecture Status\n") },
      { name: "README.md", data: Buffer.from("# Praxis Architect\n") },
      { name: "VERSION", data: Buffer.from("0.1.0-alpha.31\n") },
    ]);
    const { issues } = inspectHostedZipBuffer(buf);
    expect(issues.filter((i) => i.includes(HOSTED_BIN_FORBIDDEN))).toEqual([]);
    expect(issues.filter((i) => i.includes("ROLE_MCP_FORBIDDEN"))).toEqual([]);
    expect(
      validateStandalonePluginJson(
        {
          name: "praxis-architect",
          version: "0.1.0-alpha.31",
          description: "Architect",
          license: "Apache-2.0",
        },
        "0.1.0-alpha.31",
        "praxis-architect",
      ),
    ).toEqual([]);
  });

  it("rejects bundled role MCP runtime", () => {
    const buf = writeZip([
      { name: ".claude-plugin/plugin.json", data: Buffer.from("{}") },
      { name: ".mcp.json", data: Buffer.from("{}") },
      { name: "runtime/praxis-mcp.cjs", data: Buffer.from("module.exports={}\n") },
    ]);
    const { issues } = inspectHostedZipBuffer(buf);
    expect(issues.some((i) => i.includes("ROLE_MCP_FORBIDDEN"))).toBe(true);
    expect(
      parsePluginMcpConfig({
        mcpServers: {
          praxis: {
            command: "node",
            args: ["${CLAUDE_PLUGIN_ROOT}/runtime/praxis-mcp.cjs", "--role", "architect"],
          },
        },
      }),
    ).toMatchObject({ command: "node" });
  });

  it("rejects marketplace.json in standalone zip", () => {
    const buf = writeZip([
      { name: ".claude-plugin/plugin.json", data: Buffer.from("{}") },
      { name: ".claude-plugin/marketplace.json", data: Buffer.from("{}") },
    ]);
    expect(
      inspectHostedZipBuffer(buf).issues.some((i) => i.includes("MARKETPLACE")),
    ).toBe(true);
  });
});

import { duplicateSkillNames, validateSkillForUpload } from "./hosted-plugin-policy.mjs";

describe("skill upload rules", () => {
  const skill = (fm) => `---\n${fm}\n---\n\n# Body with <tags> is fine\n`;

  it("accepts a plain skill", () => {
    expect(validateSkillForUpload(skill("name: demo\ndescription: Does a thing."), "demo")).toEqual([]);
  });

  it("rejects XML-like tags in the description (the praxis-ba failure)", () => {
    const issues = validateSkillForUpload(skill("name: demo\ndescription: Plan at `wp/<id>/plan.md`."), "demo");
    expect(issues.join()).toContain("<id>");
  });

  it("does not flag comparisons", () => {
    expect(validateSkillForUpload(skill("name: demo\ndescription: Use when a < b and c > d."), "demo")).toEqual([]);
  });

  it("rejects bad names, missing fields, long descriptions and broken YAML", () => {
    expect(validateSkillForUpload(skill("name: Demo_Skill\ndescription: x"), "Demo_Skill").length).toBeGreaterThan(0);
    expect(validateSkillForUpload(skill("name: demo"), "demo").join()).toContain("description");
    expect(validateSkillForUpload(skill(`name: demo\ndescription: ${"a".repeat(1025)}`), "demo").join()).toContain("1025");
    expect(validateSkillForUpload(skill("name: demo\ndescription: a: b: c"), "demo").join()).toContain("YAML");
    expect(validateSkillForUpload("no frontmatter", "demo").length).toBe(1);
  });

  it("rejects a name that differs from its directory and duplicate names", () => {
    expect(validateSkillForUpload(skill("name: one\ndescription: x"), "two").join()).toContain("directory");
    expect(
      duplicateSkillNames([
        { dirName: "a", raw: skill("name: same\ndescription: x") },
        { dirName: "b", raw: skill("name: same\ndescription: x") },
      ]).length,
    ).toBe(1);
  });

  it("flags tags in a zipped skill and nested zips", () => {
    const buf = writeZip([
      { name: ".claude-plugin/plugin.json", data: Buffer.from("{}") },
      { name: "skills/demo/SKILL.md", data: Buffer.from(skill("name: demo\ndescription: see <id>")) },
      { name: "inner.zip", data: Buffer.from("PK") },
    ]);
    const { issues, skillCount } = inspectHostedZipBuffer(buf);
    expect(skillCount).toBe(1);
    expect(issues.join("\n")).toContain("<id>");
    expect(issues.join("\n")).toContain("NESTED_ZIP");
  });
});

import { inspectUploadZipBuffer } from "./hosted-plugin-policy.mjs";

describe("upload zip inspection", () => {
  const ok = (name) => ({ name, data: Buffer.from(`---\nname: ${name.split("/")[1]}\ndescription: fine\n---\n\nbody\n`) });
  const plugin = { name: ".claude-plugin/plugin.json", data: Buffer.from("{}") };

  it("accepts many skills and does not apply the hosted bin/MCP policy", () => {
    const buf = writeZip([plugin, ok("skills/a/SKILL.md"), ok("skills/b/SKILL.md")]);
    const r = inspectUploadZipBuffer(buf);
    expect(r.issues).toEqual([]);
    expect(r.skillCount).toBe(2);
  });

  it("requires plugin.json at the root and rejects junk files", () => {
    const buf = writeZip([ok("skills/a/SKILL.md"), { name: "skills/a/.DS_Store", data: Buffer.from("x") }], { enforcePolicy: false });
    const text = inspectUploadZipBuffer(buf).issues.join("\n");
    expect(text).toContain("plugin.json");
    expect(text).toContain("JUNK");
  });
});
