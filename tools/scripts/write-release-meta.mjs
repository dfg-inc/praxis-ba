#!/usr/bin/env node
/**
 * Write dist/release-meta.json for GitHub Releases (no publish).
 *
 * Env:
 *   GITHUB_SHA or CI_COMMIT_SHA
 *   GITHUB_REF_NAME or CI_COMMIT_TAG (optional; defaults to v$version)
 *   PRAXIS_RELEASE_ARTIFACT_NAME
 *   PRAXIS_RELEASE_SEARCH_ROOT
 *   PRAXIS_RELEASE_PACKAGE_NAME (optional)
 *   PRAXIS_RELEASE_KIND  mcpb | zip
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

function walkFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}

function findArtifact(searchRoot, exactName) {
  const matches = walkFiles(searchRoot).filter((p) => basename(p) === exactName);
  if (!matches.length) {
    throw new Error(`artifact ${exactName} not found under ${searchRoot}`);
  }
  return matches.sort()[0];
}

function loadCompatibility(root, kind, version) {
  const manifestPath = join(root, "vendor/manifest.json");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const core = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8"))
    : null;
  const base = {
    productVersion: version,
    packageJsonVersion: pkg.version,
    engines: pkg.engines || {},
    coreVendor: core
      ? {
          vendorManifestVersion: core.version,
          coreBaselineSha: core.baseline || null,
          packages: core.packages || [],
        }
      : null,
  };
  if (kind === "mcpb") {
    return {
      ...base,
      installModel: "Claude Desktop extension (MCPB)",
      requires: [],
      notes:
        "Shared Runtime for all role ZIPs. Install role plugins from their own GitHub Releases.",
    };
  }
  return {
    ...base,
    installModel: "Claude Desktop / Cowork role plugin ZIP",
    requires: ["praxis-runtime (MCPB from dfg-inc/praxis-runtime Releases)"],
    notes:
      "Skills ZIP only. Requires shared Runtime MCPB. Version independently of other products.",
  };
}

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
const sha =
  process.env.GITHUB_SHA ||
  process.env.CI_COMMIT_SHA ||
  "unknown";
const tag =
  process.env.GITHUB_REF_NAME ||
  process.env.CI_COMMIT_TAG ||
  `v${version}`;
const artifactName = required("PRAXIS_RELEASE_ARTIFACT_NAME");
const searchRoot = required("PRAXIS_RELEASE_SEARCH_ROOT");
const packageName =
  process.env.PRAXIS_RELEASE_PACKAGE_NAME || pkg.name || "praxis-product";
const kind = process.env.PRAXIS_RELEASE_KIND || "zip";

const artifactPath = findArtifact(searchRoot, artifactName);
const bytes = readFileSync(artifactPath);
const sha256 = createHash("sha256").update(bytes).digest("hex");

const meta = {
  schemaVersion: 1,
  product: packageName,
  version,
  tag,
  sourceSha: sha,
  repository: `https://github.com/dfg-inc/${packageName}`,
  artifact: {
    file: artifactName,
    path: artifactPath,
    sha256,
    bytes: bytes.length,
    kind,
  },
  compatibility: loadCompatibility(root, kind, version),
  publishedAt: new Date().toISOString(),
};

mkdirSync(join(root, "dist"), { recursive: true });
const out = join(root, "dist", "release-meta.json");
writeFileSync(out, JSON.stringify(meta, null, 2) + "\n");
console.log(`wrote ${out}`);
console.log(`sha256 ${sha256} ${artifactPath}`);
