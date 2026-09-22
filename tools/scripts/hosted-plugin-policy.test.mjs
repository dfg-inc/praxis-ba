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
