import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractLeadingFrontmatter,
  validatePluginTree,
  validatePluginsRoot,
} from "./validate-plugins.mjs";

const tempDirs = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makePlugin(files) {
  const dir = mkdtempSync(join(tmpdir(), "praxis-plugin-validate-"));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return dir;
}

describe("extractLeadingFrontmatter", () => {
  it("extracts a single leading block", () => {
    const r = extractLeadingFrontmatter(
      "---\nname: x\ndescription: y\n---\n\n# Body\n",
    );
    expect(r.yaml).toContain("name: x");
  });

  it("rejects duplicate frontmatter", () => {
    const r = extractLeadingFrontmatter(
      "---\nname: a\n---\n\n---\nname: b\n---\n\nBody\n",
    );
    expect(r.error).toMatch(/duplicate/);
  });
});

describe("validatePluginTree", () => {
  it("PASS on quoted description with colons", () => {
    const dir = makePlugin({
      "skills/nfr-budget/SKILL.md":
        '---\nname: nfr-budget\ndescription: "Define an NFR budget: metric, limit."\n---\n\n# Ok\n',
      ".claude-plugin/plugin.json": '{"name":"x","version":"0.0.1"}\n',
    });
    const r = validatePluginTree(dir);
    expect(r.ok, r.errors.join("; ")).toBe(true);
  });

  it("FAIL on unquoted description containing ': '", () => {
    const dir = makePlugin({
      "skills/nfr-budget/SKILL.md":
        "---\nname: nfr-budget\ndescription: Define an NFR budget: metric, limit.\n---\n\n# Bad\n",
    });
    const r = validatePluginTree(dir);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/strict YAML parse failed/);
  });

  it("FAIL when skill name mismatches directory", () => {
    const dir = makePlugin({
      "skills/nfr-budget/SKILL.md":
        '---\nname: wrong\ndescription: "ok"\n---\n\n# Body\n',
    });
    const r = validatePluginTree(dir);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/must match directory/);
  });

  it("FAIL on invalid marketplace JSON", () => {
    const dir = makePlugin({
      ".claude-plugin/marketplace.json": "{not-json",
    });
    const r = validatePluginTree(dir);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/invalid JSON/);
  });
});

describe("validatePluginsRoot against monorepo plugins/", () => {
  it("current plugins/ tree PASSes", () => {
    const root = join(process.cwd(), "..", "..", "plugins");
    // vitest cwd is tools/scripts
    const r = validatePluginsRoot(root);
    expect(r.ok, r.errors.join("\n")).toBe(true);
    expect(r.checked).toBeGreaterThan(10);
  });
});
