import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkSafeArchivePath,
  extractZip,
  inspectZipEntries,
  parseZip,
  writeZip,
} from "./claude-zip.mjs";

describe("checkSafeArchivePath", () => {
  it("accepts conservative ASCII plugin paths", () => {
    for (const name of [
      ".claude-plugin/plugin.json",
      "bin/praxis",
      "runtime/praxis-runtime.mjs",
      "skills/plan-jira-epic/SKILL.md",
      "README.md",
      "VERSION",
    ]) {
      expect(checkSafeArchivePath(name)).toEqual({ ok: true });
    }
  });

  it("rejects @, spaces, traversal, absolute, apple metadata, and control chars", () => {
    const bad = {
      "runtime/node_modules/@praxis/cli/index.js": "unsupported chars",
      "foo bar/x": "unsupported chars",
      "../evil": "empty or traversal segment",
      "/absolute": "absolute path",
      "foo\\bar": "backslash",
      "__MACOSX/foo": "Apple __MACOSX",
      ".DS_Store": "Apple .DS_Store",
      "dir/._hidden": "Apple AppleDouble",
      "foo/\u0001bar": "control character",
    };
    for (const [name, hint] of Object.entries(bad)) {
      const r = checkSafeArchivePath(name);
      expect(r.ok).toBe(false);
      expect(r.reason).toContain(hint.split(" ")[0] === "unsupported" ? "unsupported" : hint.split(" ")[0]);
    }
  });
});

describe("writeZip / inspectZipEntries", () => {
  it("writes a deterministic safe fixture plugin zip", () => {
    const first = writeZip([
      { name: ".claude-plugin/", isDir: true, mode: 0o755 },
      {
        name: ".claude-plugin/plugin.json",
        data: Buffer.from('{"name":"fixture"}\n'),
        mode: 0o644,
      },
      { name: "bin/", isDir: true, mode: 0o755 },
      { name: "bin/praxis", data: Buffer.from("#!/bin/sh\n"), mode: 0o755 },
    ]);
    const second = writeZip([
      { name: "bin/praxis", data: Buffer.from("#!/bin/sh\n"), mode: 0o755 },
      { name: ".claude-plugin/plugin.json", data: Buffer.from('{"name":"fixture"}\n'), mode: 0o644 },
      { name: "bin/", isDir: true, mode: 0o755 },
      { name: ".claude-plugin/", isDir: true, mode: 0o755 },
    ]);
    expect(first.equals(second)).toBe(true);
    const { entries, issues } = inspectZipEntries(first);
    expect(issues).toEqual([]);
    expect(entries.map((e) => e.name)).toEqual([
      ".claude-plugin/",
      ".claude-plugin/plugin.json",
      "bin/",
      "bin/praxis",
    ]);
    const praxis = entries.find((e) => e.name === "bin/praxis");
    expect(praxis.mode).toBe(0o755);
    const json = entries.find((e) => e.name === ".claude-plugin/plugin.json");
    expect(json.mode).toBe(0o644);
    expect(json.fileType).toBe("file");
    expect(entries.every((e) => !e.isSymlink)).toBe(true);
  });

  it("rejects all intentionally bad fixtures", () => {
    const cases = [
      { name: "foo@bar/x", data: Buffer.from("x") },
      { name: "foo bar/x", data: Buffer.from("x") },
      { name: "../evil", data: Buffer.from("x") },
      { name: "/absolute", data: Buffer.from("x") },
      { name: "foo\\bar", data: Buffer.from("x") },
      { name: "__MACOSX/foo", data: Buffer.from("x") },
      { name: ".DS_Store", data: Buffer.from("x") },
      { name: "dir/._hidden", data: Buffer.from("x") },
      { name: "foo/\u0001bar", data: Buffer.from("x") },
    ];
    for (const entry of cases) {
      const buf = writeZip([entry], { enforcePolicy: false });
      const { issues } = inspectZipEntries(buf);
      expect(issues.length, entry.name).toBeGreaterThan(0);
      expect(issues.some((i) => i.includes("CLAUDE_PLUGIN_INVALID_PATH")), entry.name).toBe(
        true,
      );
    }
  });

  it("rejects symlink entries", () => {
    const buf = writeZip(
      [{ name: "link", data: Buffer.from("target"), fileType: "symlink", mode: 0o777 }],
      { enforcePolicy: false },
    );
    const { issues } = inspectZipEntries(buf);
    expect(issues.some((i) => i.startsWith("CLAUDE_PLUGIN_SYMLINK"))).toBe(true);
  });

  it("rejects duplicate normalized paths", () => {
    expect(() =>
      writeZip(
        [
          { name: "dup.txt", data: Buffer.from("a") },
          { name: "dup.txt", data: Buffer.from("b") },
        ],
        { enforcePolicy: false },
      ),
    ).toThrow(/CLAUDE_PLUGIN_DUPLICATE_PATH/);
  });

  it("rejects case collisions", () => {
    expect(() =>
      writeZip(
        [
          { name: "Foo.txt", data: Buffer.from("a") },
          { name: "foo.txt", data: Buffer.from("b") },
        ],
        { enforcePolicy: false },
      ),
    ).toThrow(/CLAUDE_PLUGIN_CASE_COLLISION/);
  });

  it("rejects node_modules and tgz layout", () => {
    const nm = writeZip(
      [{ name: "runtime/node_modules/leftpad/index.js", data: Buffer.from("x") }],
      { enforcePolicy: true },
    );
    expect(inspectZipEntries(nm).issues.some((i) => i.includes("NODE_MODULES"))).toBe(true);
    const tgz = writeZip(
      [{ name: "runtime/praxis-cli-0.1.0-alpha.27.tgz", data: Buffer.from("x") }],
      { enforcePolicy: true },
    );
    expect(inspectZipEntries(tgz).issues.some((i) => i.includes("TGZ"))).toBe(true);
  });

  it("extracts files with executable bin/praxis", () => {
    const buf = writeZip([
      { name: "bin/praxis", data: Buffer.from("#!/bin/sh\necho ok\n"), mode: 0o755 },
      { name: "VERSION", data: Buffer.from("0.1.0-alpha.28\n"), mode: 0o644 },
    ]);
    const dir = mkdtempSync(join(tmpdir(), "praxis-zip-"));
    extractZip(buf, dir);
    expect(readFileSync(join(dir, "VERSION"), "utf8")).toBe("0.1.0-alpha.28\n");
    const parsed = parseZip(buf);
    expect(parsed.entries.find((e) => e.name === "bin/praxis").mode).toBe(0o755);
  });
});
