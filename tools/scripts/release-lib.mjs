/**
 * Shared SemVer helpers for one Praxis repository.
 * ecosystem.json records this repository's version. The six repositories
 * release independently; sibling versions are not required to match.
 * Root package.json in this checkout must match ecosystem.json in this checkout.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

/** SemVer 2.0.0 including prerelease / build metadata. */
export const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * Internal monorepo deps must use a range that always matches the local
 * workspace package. npm does not support the `workspace:` protocol
 * (EUNSUPPORTEDPROTOCOL); `"*"` is the npm-workspaces convention so
 * `npm ci` links local `@praxis/*` packages and never hits the public registry.
 */
export const INTERNAL_WORKSPACE_RANGE = "*";

/** Known Praxis repositories. Not a monorepo, and not one shared version. */
export const ECOSYSTEM_REPOS = [
  "praxis-core",
  "praxis-runtime",
  "praxis-ba",
  "praxis-architect",
  "praxis-developer",
  "praxis-quality",
];

const ALPHA_VERSION_RE = /0\.1\.0-alpha\.\d+/;

/** Declarations of other products, or of vendored Core. Not this repo's version. */
const SKIP_PRODUCT_VERSION = new Set([
  "vendor/manifest.json",
  "packages/catalog/catalog.json",
]);

const DEP_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

export function isValidSemVer(version) {
  return typeof version === "string" && SEMVER_RE.test(version);
}

export function repoRootFrom(importMetaUrl = import.meta.url) {
  return join(dirname(fileURLToPath(importMetaUrl)), "../..");
}

function listDirs(root, rel) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(rel, d.name));
}

/**
 * Tracked version-bearing paths relative to repo root (excludes fixtures/samples/docs history).
 */
export function discoverVersionFiles(root) {
  const files = new Set(["package.json"]);

  for (const dir of [
    ...listDirs(root, "packages"),
    ...listDirs(root, "plugins"),
    ...listDirs(root, "apps"),
  ]) {
    const pkg = join(dir, "package.json");
    if (existsSync(join(root, pkg))) files.add(pkg.replace(/\\/g, "/"));
    const pluginJson = join(dir, ".claude-plugin/plugin.json");
    if (existsSync(join(root, pluginJson))) {
      files.add(pluginJson.replace(/\\/g, "/"));
    }
    const marketJson = join(dir, ".claude-plugin/marketplace.json");
    if (existsSync(join(root, marketJson))) {
      files.add(marketJson.replace(/\\/g, "/"));
    }
  }

  for (const extra of [
    "plugins/ba/canon-graph/package.json",
    "tools/e2e/package.json",
    "tools/scripts/package.json",
    "packages/catalog/catalog.json",
    "vendor/manifest.json",
    "claude-extensions/manifest.json",
    "ecosystem.json",
  ]) {
    if (existsSync(join(root, extra))) files.add(extra);
  }

  return [...files].sort();
}

export function readJson(abs) {
  return JSON.parse(readFileSync(abs, "utf8"));
}

export function writeJson(abs, data) {
  writeFileSync(abs, JSON.stringify(data, null, 2) + "\n");
}

/**
 * Extract comparable version string(s) from a version-bearing file.
 * Returns { kind, versions: string[] }.
 */
export function extractVersions(relPath, data) {
  const base = relPath.split("/").pop();
  if (base === "catalog.json") {
    return {
      kind: "catalog",
      versions: (data.plugins ?? []).map((p) => p.version).filter(Boolean),
    };
  }
  if (base === "marketplace.json") {
    return {
      kind: "marketplace",
      versions: (data.plugins ?? []).map((p) => p.version).filter(Boolean),
    };
  }
  if (base === "plugin.json" || base === "package.json") {
    return { kind: "package", versions: data.version ? [data.version] : [] };
  }
  if (
    relPath === "vendor/manifest.json" ||
    relPath === "claude-extensions/manifest.json" ||
    relPath === "ecosystem.json"
  ) {
    return { kind: relPath, versions: data.version ? [data.version] : [] };
  }
  return { kind: "unknown", versions: [] };
}

/**
 * Apply monorepo release version to one file. Returns true if content changed.
 */
export function applyVersionToData(relPath, data, version) {
  const base = relPath.split("/").pop();
  let changed = false;

  if (base === "catalog.json" || relPath === "vendor/manifest.json") {
    return false;
  }

  if (base === "marketplace.json") {
    for (const p of data.plugins ?? []) {
      if (p.version !== version) {
        p.version = version;
        changed = true;
      }
    }
    return changed;
  }

  if (base === "plugin.json" || base === "package.json") {
    if (data.version !== version) {
      data.version = version;
      changed = true;
    }
    if (base === "package.json" && rewriteScriptVersions(data, version)) {
      changed = true;
    }
    return changed;
  }

  if (relPath === "claude-extensions/manifest.json" || relPath === "ecosystem.json") {
    if (data.version !== version) {
      data.version = version;
      changed = true;
    }
    return changed;
  }

  return false;
}

function alphaVersionsIn(value) {
  return typeof value === "string" ? (value.match(/0\.1\.0-alpha\.\d+/g) ?? []) : [];
}

/** Replace this repository's version inside npm scripts. Leaves file: pins alone. */
export function rewriteScriptVersions(data, version) {
  let changed = false;
  if (!data.scripts || typeof data.scripts !== "object") return false;
  for (const [key, value] of Object.entries(data.scripts)) {
    if (typeof value !== "string" || !ALPHA_VERSION_RE.test(value)) continue;
    const next = value.replace(/0\.1\.0-alpha\.\d+/g, version);
    if (next !== value) {
      data.scripts[key] = next;
      changed = true;
    }
  }
  return changed;
}

/** Replace vendored Core versions inside file: pins. Does not change product version. */
export function rewriteVendorPinVersions(data, vendorVersion) {
  let changed = false;
  for (const section of DEP_SECTIONS) {
    const deps = data[section];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, range] of Object.entries(deps)) {
      if (typeof range !== "string" || !range.startsWith("file:")) continue;
      if (!name.startsWith("@praxis/")) continue;
      if (!ALPHA_VERSION_RE.test(range)) continue;
      const next = range.replace(/0\.1\.0-alpha\.\d+/g, vendorVersion);
      if (next !== range) {
        deps[name] = next;
        changed = true;
      }
    }
  }
  return changed;
}

export function applyVersionToFile(root, relPath, version) {
  const abs = join(root, relPath);
  const data = readJson(abs);
  const before = JSON.stringify(data);
  applyVersionToData(relPath, data, version);
  const after = JSON.stringify(data);
  if (before === after) return false;
  writeJson(abs, data);
  return true;
}

/**
 * Map of local workspace package names → { path, version }.
 * Only `@praxis/*` packages are treated as internal workspace packages.
 */
export function discoverWorkspacePackages(root) {
  const packages = new Map();
  for (const rel of discoverVersionFiles(root)) {
    if (!rel.endsWith("package.json")) continue;
    const data = readJson(join(root, rel));
    if (typeof data.name === "string" && data.name.startsWith("@praxis/")) {
      packages.set(data.name, { path: rel, version: data.version ?? null });
    }
  }
  return packages;
}

export function listInternalDependencyRefs(root) {
  const workspace = discoverWorkspacePackages(root);
  const refs = [];
  for (const rel of discoverVersionFiles(root)) {
    if (!rel.endsWith("package.json")) continue;
    const data = readJson(join(root, rel));
    for (const section of DEP_SECTIONS) {
      const deps = data[section];
      if (!deps || typeof deps !== "object") continue;
      for (const [name, range] of Object.entries(deps)) {
        if (!workspace.has(name)) continue;
        refs.push({
          path: rel,
          section,
          name,
          range: String(range),
          packageVersion: workspace.get(name).version,
        });
      }
    }
  }
  return refs;
}

export function applyInternalWorkspaceDeps(
  data,
  workspaceNames,
  range = INTERNAL_WORKSPACE_RANGE,
) {
  let changed = false;
  for (const section of DEP_SECTIONS) {
    const deps = data[section];
    if (!deps || typeof deps !== "object") continue;
    for (const name of Object.keys(deps)) {
      if (!workspaceNames.has(name)) continue;
      if (deps[name] !== range) {
        deps[name] = range;
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Rewrite every dependency on a local `@praxis/*` workspace package to
 * {@link INTERNAL_WORKSPACE_RANGE} (`*`).
 */
export function syncInternalWorkspaceDeps(
  root,
  { dryRun = false, range = INTERNAL_WORKSPACE_RANGE } = {},
) {
  const workspace = discoverWorkspacePackages(root);
  const names = new Set(workspace.keys());
  const changed = [];
  for (const rel of discoverVersionFiles(root)) {
    if (!rel.endsWith("package.json")) continue;
    const abs = join(root, rel);
    const data = readJson(abs);
    const clone = structuredClone(data);
    if (!applyInternalWorkspaceDeps(clone, names, range)) continue;
    changed.push(rel);
    if (!dryRun) writeJson(abs, clone);
  }
  return { changed, range, refs: listInternalDependencyRefs(root) };
}

export function checkInternalWorkspaceDeps(
  root,
  range = INTERNAL_WORKSPACE_RANGE,
) {
  const refs = listInternalDependencyRefs(root);
  const mismatches = refs
    .filter((r) => r.range !== range)
    .map((r) => ({
      path: r.path,
      section: r.section,
      name: r.name,
      found: r.range,
      expected: range,
      packageVersion: r.packageVersion,
    }));
  return { ok: mismatches.length === 0, range, mismatches, refs };
}

export function syncAllVersions(root, version, { dryRun = false } = {}) {
  const files = discoverVersionFiles(root);
  const changed = [];
  for (const rel of files) {
    const abs = join(root, rel);
    const data = readJson(abs);
    const clone = structuredClone(data);
    const willChange = applyVersionToData(rel, clone, version);
    if (!willChange) continue;
    changed.push(rel);
    if (!dryRun) writeJson(abs, clone);
  }
  const depSync = syncInternalWorkspaceDeps(root, { dryRun });
  for (const rel of depSync.changed) {
    if (!changed.includes(rel)) changed.push(rel);
  }
  return { files, changed, depChanged: depSync.changed };
}

/**
 * Consistency report: every version-bearing field must equal expected (root by default),
 * and every internal `@praxis/*` dependency must use the workspace protocol.
 */
export function checkVersionConsistency(root, expectedVersion) {
  const rootPkg = readJson(join(root, "package.json"));
  const expected = expectedVersion ?? rootPkg.version;
  const mismatches = [];
  for (const rel of discoverVersionFiles(root)) {
    if (SKIP_PRODUCT_VERSION.has(rel)) continue;
    const data = readJson(join(root, rel));
    const { versions } = extractVersions(rel, data);
    for (const v of versions) {
      if (v !== expected) {
        mismatches.push({ path: rel, found: v, expected });
      }
    }
  }
  const deps = checkInternalWorkspaceDeps(root);
  for (const m of deps.mismatches) {
    mismatches.push({
      path: m.path,
      found: `${m.name}@${m.found}`,
      expected: `${m.name}@${m.expected}`,
      kind: "internal-dependency",
      section: m.section,
      packageVersion: m.packageVersion,
    });
  }
  return {
    ok: mismatches.length === 0,
    expected,
    mismatches,
    files: discoverVersionFiles(root),
    internalDeps: deps,
  };
}

export function writeEcosystem(root, version) {
  writeJson(join(root, "ecosystem.json"), {
    schemaVersion: 1,
    policy: "independent",
    version,
    repositories: ECOSYSTEM_REPOS,
  });
}

/**
 * Point this checkout's file: pins and vendor/manifest.json at one Core version.
 * Does not change this repository's version and does not touch sibling checkouts.
 * The caller replaces vendor/*.tgz and refreshes the lockfile.
 */
export function syncVendorPins(root, vendorVersion, { dryRun = false } = {}) {
  const changed = [];
  for (const rel of discoverVersionFiles(root)) {
    if (!rel.endsWith("package.json")) continue;
    const abs = join(root, rel);
    const data = readJson(abs);
    const clone = structuredClone(data);
    if (!rewriteVendorPinVersions(clone, vendorVersion)) continue;
    changed.push(rel);
    if (!dryRun) writeJson(abs, clone);
  }
  const manifestRel = "vendor/manifest.json";
  const manifestPath = join(root, manifestRel);
  if (existsSync(manifestPath)) {
    const manifest = readJson(manifestPath);
    if (manifest.version !== vendorVersion) {
      manifest.version = vendorVersion;
      changed.push(manifestRel);
      if (!dryRun) writeJson(manifestPath, manifest);
    }
  }
  return { changed, vendorVersion };
}

function pushMismatch(mismatches, path, found, expected, kind) {
  mismatches.push({ path, found, expected, kind });
}

export function checkVendorAndPins(root, productVersion) {
  const mismatches = [];
  const pinVersions = new Set();
  for (const rel of discoverVersionFiles(root)) {
    if (!rel.endsWith("package.json")) continue;
    const data = readJson(join(root, rel));
    if (data.scripts) {
      for (const [key, value] of Object.entries(data.scripts)) {
        if (typeof value !== "string") continue;
        for (const v of alphaVersionsIn(value)) {
          if (v !== productVersion) {
            pushMismatch(mismatches, rel, `${key}=${v}`, productVersion, "script-version");
          }
        }
      }
    }
    for (const section of DEP_SECTIONS) {
      const deps = data[section];
      if (!deps) continue;
      for (const [name, range] of Object.entries(deps)) {
        if (typeof range !== "string" || !range.startsWith("file:")) continue;
        if (!name.startsWith("@praxis/")) continue;
        const found = alphaVersionsIn(range);
        if (found.length !== 1) {
          pushMismatch(mismatches, rel, `${name}@${range}`, "one file: version", "vendor-pin");
          continue;
        }
        pinVersions.add(found[0]);
      }
    }
  }

  const vendorDir = join(root, "vendor");
  const manifestPath = join(vendorDir, "manifest.json");
  const manifest = existsSync(manifestPath) ? readJson(manifestPath) : null;
  const manifestVersion = manifest?.version ?? null;
  if (pinVersions.size > 1) {
    pushMismatch(
      mismatches,
      "package.json",
      [...pinVersions].join(","),
      "one vendored Core version",
      "vendor-pin",
    );
  }
  const pinVersion = pinVersions.size === 1 ? [...pinVersions][0] : null;
  if (manifestVersion && pinVersion && manifestVersion !== pinVersion) {
    pushMismatch(
      mismatches,
      "vendor/manifest.json",
      manifestVersion,
      pinVersion,
      "vendor-pin",
    );
  }
  const vendorVersion = manifestVersion || pinVersion;

  if (existsSync(vendorDir)) {
    const tarballs = readdirSync(vendorDir).filter((name) => name.endsWith(".tgz"));
    for (const name of tarballs) {
      if (!vendorVersion || !name.endsWith(`-${vendorVersion}.tgz`)) {
        pushMismatch(
          mismatches,
          `vendor/${name}`,
          name,
          vendorVersion ? `*-${vendorVersion}.tgz` : "declared vendor version",
          "stale-vendor-tarball",
        );
      }
    }
    for (const pkgName of manifest?.packages ?? []) {
      if (typeof pkgName !== "string" || !vendorVersion) continue;
      const file = `praxis-${pkgName.replace(/^@praxis\//, "")}-${vendorVersion}.tgz`;
      if (!tarballs.includes(file)) {
        pushMismatch(mismatches, "vendor/manifest.json", pkgName, file, "missing-vendor-tarball");
      }
    }
  } else if (pinVersions.size > 0) {
    pushMismatch(mismatches, "vendor", "missing", "vendor/*.tgz", "missing-vendor-tarball");
  }

  const lockPath = join(root, "package-lock.json");
  if (existsSync(lockPath)) {
    const allowed = new Set([productVersion]);
    if (vendorVersion) allowed.add(vendorVersion);
    const text = readFileSync(lockPath, "utf8");
    for (const v of new Set(alphaVersionsIn(text))) {
      if (!allowed.has(v)) {
        pushMismatch(
          mismatches,
          "package-lock.json",
          v,
          [...allowed].join(" or "),
          "lockfile-version",
        );
      }
    }
  }

  return mismatches;
}

function readZipEntry(buf, wanted) {
  let offset = 0;
  while (offset + 30 <= buf.length) {
    if (buf.readUInt32LE(offset) !== 0x04034b50) break;
    const flags = buf.readUInt16LE(offset + 6);
    const method = buf.readUInt16LE(offset + 8);
    const compSize = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const name = buf.subarray(offset + 30, offset + 30 + nameLen).toString("utf8");
    const dataStart = offset + 30 + nameLen + extraLen;
    if (flags & 0x8) break;
    const data = buf.subarray(dataStart, dataStart + compSize);
    if (name === wanted) {
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      throw new Error(`unsupported zip method ${method} for ${wanted}`);
    }
    offset = dataStart + compSize;
  }
  return null;
}

export function checkCommittedArtifacts(root, expected) {
  const mismatches = [];
  const mcpb = join(root, "claude-extensions", "praxis-runtime.mcpb");
  const mcpbMeta = join(root, "claude-extensions", "manifest.json");
  if (existsSync(mcpb) && existsSync(mcpbMeta)) {
    const buf = readFileSync(mcpb);
    const meta = readJson(mcpbMeta);
    const sha = createHash("sha256").update(buf).digest("hex");
    if (meta.version !== expected) {
      pushMismatch(mismatches, "claude-extensions/manifest.json", meta.version, expected, "artifact-version");
    }
    if (meta.sha256 !== sha) {
      pushMismatch(mismatches, "claude-extensions/manifest.json", meta.sha256, sha, "artifact-sha");
    }
    const inner = readZipEntry(buf, "manifest.json");
    if (!inner) {
      pushMismatch(mismatches, "claude-extensions/praxis-runtime.mcpb", "missing manifest.json", expected, "artifact");
    } else {
      const version = JSON.parse(inner.toString("utf8")).version;
      if (version !== expected) {
        pushMismatch(mismatches, "claude-extensions/praxis-runtime.mcpb", version, expected, "artifact-version");
      }
    }
  }
  const pluginDir = join(root, "claude-plugins");
  if (existsSync(pluginDir)) {
    for (const name of readdirSync(pluginDir)) {
      if (!name.endsWith(".zip")) continue;
      const buf = readFileSync(join(pluginDir, name));
      const inner = readZipEntry(buf, ".claude-plugin/plugin.json");
      if (!inner) {
        pushMismatch(mismatches, `claude-plugins/${name}`, "missing plugin.json", expected, "artifact");
        continue;
      }
      const version = JSON.parse(inner.toString("utf8")).version;
      if (version !== expected) {
        pushMismatch(mismatches, `claude-plugins/${name}`, version, expected, "artifact-version");
      }
    }
  }
  return mismatches;
}

export function releaseTagFromEnv() {
  if (process.env.CI_COMMIT_TAG) return process.env.CI_COMMIT_TAG;
  if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME) {
    return process.env.GITHUB_REF_NAME;
  }
  return "";
}

/**
 * Invariants for this checkout only.
 * A release tag is required only when CI is already building a tag.
 * Sibling repositories are not compared.
 */
export function checkEcosystemRelease(root, expectedVersion) {
  const rootPkg = readJson(join(root, "package.json"));
  const ecosystem = existsSync(join(root, "ecosystem.json"))
    ? readJson(join(root, "ecosystem.json"))
    : null;
  const expected = expectedVersion ?? rootPkg.version;
  const mismatches = [];
  if (!ecosystem) {
    pushMismatch(mismatches, "ecosystem.json", "missing", expected, "ecosystem");
  } else {
    if (ecosystem.policy !== "independent") {
      pushMismatch(mismatches, "ecosystem.json", ecosystem.policy ?? "missing", "independent", "ecosystem");
    }
    if (ecosystem.version !== expected) {
      pushMismatch(mismatches, "ecosystem.json", ecosystem.version, expected, "ecosystem");
    }
    if (JSON.stringify(ecosystem.repositories) !== JSON.stringify(ECOSYSTEM_REPOS)) {
      pushMismatch(
        mismatches,
        "ecosystem.json",
        JSON.stringify(ecosystem.repositories),
        JSON.stringify(ECOSYSTEM_REPOS),
        "ecosystem",
      );
    }
  }
  const versions = checkVersionConsistency(root, expected);
  mismatches.push(...versions.mismatches);
  mismatches.push(...checkVendorAndPins(root, expected));
  mismatches.push(...checkCommittedArtifacts(root, expected));
  const tag = releaseTagFromEnv();
  if (tag && tag !== `v${expected}` && tag !== expected) {
    pushMismatch(mismatches, "release-tag", tag, `v${expected}`, "release-tag");
  }
  return { ok: mismatches.length === 0, expected, mismatches };
}

export function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export { relative, join };
