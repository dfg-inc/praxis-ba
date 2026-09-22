#!/usr/bin/env node
/**
 * Tag-only publisher: Generic Package Registry + GitLab Release asset links.
 *
 * Env (CI):
 *   CI_COMMIT_TAG, CI_COMMIT_SHA, CI_API_V4_URL, CI_PROJECT_ID, CI_JOB_TOKEN,
 *   CI_SERVER_URL, CI_PROJECT_PATH
 *   PRAXIS_RELEASE_ARTIFACT_NAME  e.g. praxis-runtime.mcpb
 *   PRAXIS_RELEASE_SEARCH_ROOT    e.g. dist/claude-extensions
 *   PRAXIS_RELEASE_PACKAGE_NAME   generic package name (default: CI_PROJECT_NAME)
 *   PRAXIS_RELEASE_KIND           mcpb | zip
 */
import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { basename, join } from "node:path";

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

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
        "Shared Runtime for all role ZIPs. Role plugins are installed separately from their own GitLab Releases.",
    };
  }
  return {
    ...base,
    installModel: "Claude Desktop / Cowork role plugin ZIP",
    requires: ["praxis-runtime (MCPB from praxis-runtime Releases)"],
    notes:
      "Skills-only ZIP. Does not embed Runtime. Version independently of other Skills.",
  };
}

async function api(method, path, body, { okStatuses = null } = {}) {
  const base = required("CI_API_V4_URL").replace(/\/$/, "");
  const url = `${base}${path}`;
  const headers = {
    "JOB-TOKEN": required("CI_JOB_TOKEN"),
  };
  let payload;
  if (body !== undefined) {
    if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
      payload = body;
      headers["Content-Type"] = "application/octet-stream";
    } else {
      payload = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }
  }
  const res = await fetch(url, { method, headers, body: payload });
  const text = await res.text();
  if (okStatuses && okStatuses.includes(res.status)) return null;
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 800)}`);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function releaseDescription(meta, downloadUrl, metaUrl) {
  return [
    `## ${meta.product} ${meta.version}`,
    "",
    `| Field | Value |`,
    `|---|---|`,
    `| Version | \`${meta.version}\` |`,
    `| Tag | \`${meta.tag}\` |`,
    `| Source SHA | \`${meta.sourceSha}\` |`,
    `| Artifact | \`${meta.artifact.file}\` |`,
    `| SHA-256 | \`${meta.artifact.sha256}\` |`,
    `| Size | ${meta.artifact.bytes} bytes |`,
    "",
    "### Compatibility",
    "",
    "```json",
    JSON.stringify(meta.compatibility, null, 2),
    "```",
    "",
    "### Downloads (persistent Generic Package Registry)",
    "",
    `- Artifact: ${downloadUrl}`,
    `- Metadata: ${metaUrl}`,
    "",
    "Repositories are private: open Releases while signed into GitLab,",
    "or download via the API with a personal/project access token.",
    "Do **not** use ephemeral CI job artifacts for ordinary installation.",
    "",
  ].join("\n");
}

async function main() {
  const root = process.cwd();
  const tag = required("CI_COMMIT_TAG");
  const sha = required("CI_COMMIT_SHA");
  const projectId = required("CI_PROJECT_ID");
  const projectPath = required("CI_PROJECT_PATH");
  const serverUrl = (process.env.CI_SERVER_URL || "").replace(/\/$/, "");
  const artifactName = required("PRAXIS_RELEASE_ARTIFACT_NAME");
  const searchRoot = required("PRAXIS_RELEASE_SEARCH_ROOT");
  const packageName =
    process.env.PRAXIS_RELEASE_PACKAGE_NAME ||
    process.env.CI_PROJECT_NAME ||
    "praxis-product";
  const kind = process.env.PRAXIS_RELEASE_KIND || "zip";

  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const version = pkg.version;
  const expectedTags = new Set([`v${version}`, version]);
  if (!expectedTags.has(tag)) {
    throw new Error(
      `tag ${tag} does not match package.json version ${version} (expected v${version} or ${version})`,
    );
  }

  const artifactPath = findArtifact(searchRoot, artifactName);
  const bytes = readFileSync(artifactPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const meta = {
    schemaVersion: 1,
    product: packageName,
    version,
    tag,
    sourceSha: sha,
    projectPath,
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
  writeFileSync(join(root, "dist", "release-meta.json"), JSON.stringify(meta, null, 2) + "\n");

  const encodedPkg = encodeURIComponent(packageName);
  const encodedVer = encodeURIComponent(version);
  const encodedFile = encodeURIComponent(artifactName);
  const encodedMeta = encodeURIComponent("release-meta.json");
  const genericBase = `/projects/${projectId}/packages/generic/${encodedPkg}/${encodedVer}`;
  const apiBase = required("CI_API_V4_URL").replace(/\/$/, "");

  console.log(`Uploading ${artifactName} → generic ${packageName}/${version}`);
  await api("PUT", `${genericBase}/${encodedFile}`, bytes);
  console.log("Uploading release-meta.json");
  await api(
    "PUT",
    `${genericBase}/${encodedMeta}`,
    Buffer.from(JSON.stringify(meta, null, 2) + "\n"),
  );

  const downloadUrl = `${apiBase}${genericBase}/${encodedFile}`;
  const metaUrl = `${apiBase}${genericBase}/${encodedMeta}`;
  const releaseUrl = `${serverUrl}/${projectPath}/-/releases/${encodeURIComponent(tag)}`;

  await api("DELETE", `/projects/${projectId}/releases/${encodeURIComponent(tag)}`, undefined, {
    okStatuses: [404, 403],
  });

  const release = await api("POST", `/projects/${projectId}/releases`, {
    name: `${packageName} ${version}`,
    tag_name: tag,
    description: releaseDescription(meta, downloadUrl, metaUrl),
    assets: {
      links: [
        {
          name: artifactName,
          url: downloadUrl,
          link_type: "package",
          filepath: `/${artifactName}`,
        },
        {
          name: "release-meta.json",
          url: metaUrl,
          link_type: "other",
          filepath: "/release-meta.json",
        },
      ],
    },
  });

  console.log(
    JSON.stringify(
      {
        releaseUrl,
        downloadUrl,
        metaUrl,
        release: { tag: release.tag_name, name: release.name },
        sha256,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
