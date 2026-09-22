#!/usr/bin/env node
/**
 * Packed-BA acceptance for WBS 1.2 / 1.3 / 1.6 (no network, no LLM).
 *
 *   node tools/scripts/ba-diagnostics-acceptance.mjs [--rebuild]
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildAllPluginArtifacts } from "./package-plugins.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const mirror = join(root, "dist/release-mirror");
const rebuild = process.argv.includes("--rebuild");
const surfaceFixture = join(
  root,
  "plugins/ba/canon-graph/test/fixtures/code-surface",
);

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function run(cmd, cwd) {
  const r = spawnSync(cmd, {
    cwd,
    shell: true,
    encoding: "utf8",
  });
  return {
    ok: (r.status ?? 1) === 0,
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function write(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function ba(cli, args, cwd) {
  return run(`node "${cli}" ${args.map((a) => `"${a}"`).join(" ")}`, cwd);
}

function baJson(cli, args, cwd) {
  const r = ba(cli, [...args, "--json"], cwd);
  const line = r.stdout.trim().split("\n").filter(Boolean).at(-1);
  let json;
  try {
    json = JSON.parse(line);
  } catch {
    fail(`expected JSON from ${args.join(" ")}:\n${r.stdout}\n${r.stderr}`);
  }
  return { ...r, json };
}

function seedCounters(canon) {
  write(
    join(canon, ".ba/counters.yaml"),
    `product:\n  epic: 1\n  cr: 0\n  wp: 0\n  bug: 0\n  baselineSeq: {}\nepics:\n  E1:\n    fr: 3\n    nfr: 0\n    br: 0\nretired: []\n`,
  );
}

function seedFr(canon, id, body = "Story.\n") {
  write(
    join(canon, `epics/E1-x/${id}.md`),
    `---
id: ${id}
type: fr
epic: E1
status: active
version: 1
traces_to: []
enforces: []
references_nfr: []
related: []
---

${body}
`,
  );
}

if (rebuild || !existsSync(join(mirror, "plugins/ba/bin/praxis-ba.cjs"))) {
  console.log("building plugin artifacts…");
  buildAllPluginArtifacts(mirror);
}
if (!existsSync(join(mirror, "plugins/ba/bin/praxis-ba.cjs"))) {
  fail("packed BA missing bin/praxis-ba.cjs");
}

const packBase = mkdtempSync(join(tmpdir(), "praxis-ba-diag-pack-"));
const dest = join(packBase, "ba");
cpSync(join(mirror, "plugins/ba"), dest, { recursive: true });
const pack = run("npm pack", dest);
if (!pack.ok) fail(`npm pack ba: ${pack.stderr}`);
const tgz = readdirSync(dest).find((f) => f.endsWith(".tgz"));
if (!tgz) fail("no ba tgz");

const consumer = mkdtempSync(join(tmpdir(), "praxis-ba-diag-"));
write(join(consumer, "package.json"), JSON.stringify({ name: "praxis-ba-diag", private: true }));
const install = run(`npm install "${join(dest, tgz)}"`, consumer);
if (!install.ok) fail(`npm install failed:\n${install.stderr}`);

const cli = join(consumer, "node_modules/@praxis/ba/bin/praxis-ba.cjs");
const templates = join(consumer, "node_modules/@praxis/ba/templates/layer");
if (!existsSync(cli)) fail("installed praxis-ba.cjs missing");
if (!existsSync(templates)) fail("packed templates/layer missing");

const proven = [];

// --- 1.2 capture-bug ---
{
  const canon = join(consumer, "bug-canon");
  seedCounters(canon);
  seedFr(
    canon,
    "E1-FR1",
    "Story.\n\n## Acceptance Criteria\n- AC-1: given a, when b, then c\n",
  );
  const body = join(consumer, "bug-body.md");
  write(
    body,
    ["**Repro:**", "1. Open released page", "2. Click Save", "", "**Expected:** Record persists.", "", "**Actual:** API returns 500.", ""].join(
      "\n",
    ),
  );
  const cap = baJson(
    cli,
    ["bug", "capture", "--repo", canon, "--affects", "E1-FR1", "--severity", "high", "--body-file", body],
    consumer,
  );
  if (!cap.ok) fail(`bug capture failed:\n${cap.stdout}\n${cap.stderr}`);
  const id = cap.json.id;
  const raw = readFileSync(join(canon, `bugs/${id}.md`), "utf8");
  if (!/\*\*Repro:\*\*/.test(raw) || !/\*\*Expected:\*\*/.test(raw) || !/\*\*Actual:\*\*/.test(raw)) {
    fail("BUG missing distinct Repro/Expected/Actual");
  }
  if (existsSync(join(canon, "cr"))) fail("capture-bug must not create a CR");
  const val = baJson(cli, ["validate", "--repo", canon, "--check"], consumer);
  const affects = val.json.checks.find((c) => c.name === "bug-affects-resolves");
  if (!affects?.ok) fail(`bug-affects-resolves failed: ${affects?.reason}`);

  const unknown = baJson(
    cli,
    ["bug", "capture", "--repo", canon, "--affects", "E9-FR9", "--severity", "high", "--body-file", body],
    consumer,
  );
  if (unknown.ok) fail("unknown requirement must be rejected");
  if (!/unknown requirement/.test(unknown.json.checks?.[0]?.reason ?? "")) {
    fail(`unknown requirement message missing:\n${unknown.stdout}`);
  }

  const badBody = join(consumer, "bad-bug.md");
  write(badBody, "It crashes.\n");
  const missing = baJson(
    cli,
    ["bug", "capture", "--repo", canon, "--affects", "E1-FR1", "--severity", "high", "--body-file", badBody],
    consumer,
  );
  if (missing.ok) fail("missing Repro/Expected/Actual must be rejected");
  proven.push("1.2 capture-bug");
}

// --- 1.3.1 onboard context ---
{
  const project = join(consumer, "onboard-project");
  const init = baJson(
    cli,
    ["onboard-context", "--repo", project, "--init", "--templates", templates, "--project", project],
    consumer,
  );
  if (!init.ok) fail(`onboard-context --init failed:\n${init.stdout}\n${init.stderr}`);
  const check = baJson(cli, ["onboard-context", "--repo", project, "--project", project], consumer);
  if (!check.ok) fail(`onboard-context check failed:\n${check.stdout}`);
  for (const f of [
    "shared/data-model.md",
    "shared/integrations.md",
    "shared/rbac.md",
    "shared/nfr.md",
    "glossary.md",
    "as-is.md",
    "project.md",
  ]) {
    if (!existsSync(join(project, f))) fail(`missing context file ${f}`);
  }
  if (!/NEEDS CLARIFICATION|\[❓\]/.test(readFileSync(join(project, "as-is.md"), "utf8"))) {
    fail("AS-IS must preserve [NEEDS CLARIFICATION] semantics");
  }
  if (existsSync(join(project, "canon/vision.md"))) fail("onboard-context must not invent canon");

  const canon = join(consumer, "protected-canon");
  seedCounters(canon);
  write(join(canon, "vision.md"), "---\ntype: vision\nstatus: confirmed\n---\n\nConfirmed vision.\n");
  const before = readFileSync(join(canon, "vision.md"), "utf8");
  baJson(
    cli,
    ["onboard-context", "--repo", project, "--init", "--templates", templates, "--project", project, "--canon", canon],
    consumer,
  );
  if (readFileSync(join(canon, "vision.md"), "utf8") !== before) {
    fail("confirmed vision was overwritten");
  }
  proven.push("1.3.1 onboard context");
}

// --- 1.3.2 / 1.3.3 surface scan ---
{
  const code = join(consumer, "code-surface");
  cpSync(surfaceFixture, code, { recursive: true });
  const scan = baJson(cli, ["code-surface-scan", "--repo", code, "--root", code], consumer);
  if (!scan.ok) fail(`code-surface-scan failed:\n${scan.stdout}\n${scan.stderr}`);
  const ops = scan.json.surface ?? [];
  const keys = ops.map((o) => `${o.label} -> ${o.file}:${o.line}`).sort();
  const expected = [
    "GET /health -> server/app.js:3",
    "GET /orders/:id -> server/app.js:11",
    "POST /orders -> server/app.js:7",
    "POST /orders/from-history -> server/hidden/history.js:4",
    "onClick addToCart -> web/app.js:6",
    "onClick addFromHistory -> web/app.js:10",
    "onSubmit checkout -> web/app.js:7",
  ].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    fail(`surface mismatch:\n${keys.join("\n")}\nvs\n${expected.join("\n")}`);
  }
  const miss = baJson(
    cli,
    ["code-surface-scan", "--repo", code, "--root", code, "--anchors", "server/app.js,missing.js"],
    consumer,
  );
  const warnings = miss.json.warnings ?? [];
  if (!warnings.some((w) => /missing\.js/.test(w.message))) {
    fail(`missing anchor not warned:\n${JSON.stringify(warnings)}`);
  }

  const accept = baJson(
    cli,
    ["code-surface-scan", "--repo", code, "--root", code, "--accept-scan"],
    consumer,
  );
  if (!accept.ok) fail("accept-scan failed");
  const again = baJson(
    cli,
    ["code-surface-scan", "--repo", code, "--root", code, "--incremental"],
    consumer,
  );
  if ((again.json.surface ?? []).length !== 0) {
    fail(`incremental after accept must be empty: ${JSON.stringify(again.json.surface)}`);
  }
  write(join(code, "server/app.js"), `${readFileSync(join(code, "server/app.js"), "utf8")}\napp.post('/returns', () => {})\n`);
  const delta = baJson(
    cli,
    ["code-surface-scan", "--repo", code, "--root", code, "--incremental"],
    consumer,
  );
  const deltaLabels = (delta.json.surface ?? []).map((o) => o.label);
  if (JSON.stringify(deltaLabels) !== JSON.stringify(["POST /returns"])) {
    fail(`incremental delta expected POST /returns, got ${deltaLabels.join(", ")}`);
  }

  const canon = join(consumer, "dedupe-canon");
  seedCounters(canon);
  write(
    join(canon, "cr/CR-001.md"),
    "---\nid: CR-001\ntype: cr\nstatus: captured\n---\n\nShip GET /health from the existing surface.\n",
  );
  const dedupe = baJson(
    cli,
    ["code-surface-scan", "--repo", code, "--root", surfaceFixture, "--canon", canon, "--incremental"],
    consumer,
  );
  const dedupeLabels = (dedupe.json.surface ?? []).map((o) => o.label);
  if (dedupeLabels.includes("GET /health")) fail("dedupe re-emitted GET /health");
  proven.push("1.3.2/1.3.3 surface scan + incremental");
}

// --- 1.6 status missing detector ---
{
  const empty = join(consumer, "status-empty");
  seedCounters(empty);
  const clean = baJson(cli, ["status", "--repo", empty], consumer);
  if (clean.status !== 0) fail(`clean canon status exit ${clean.status}, expected 0`);
  const missingFails = (clean.json.checks ?? []).filter((c) => c.name.startsWith("missing:") && !c.ok);
  if (missingFails.length) fail(`clean canon reported missing: ${JSON.stringify(missingFails)}`);

  const gaps = join(consumer, "status-gaps");
  seedCounters(gaps);
  seedFr(gaps, "E1-FR1", "No AC 1.\n");
  seedFr(gaps, "E1-FR2", "No AC 2.\n");
  seedFr(gaps, "E1-FR3", "No AC 3.\n");
  write(
    join(gaps, "wp/WP-20260101-001/index.md"),
    `---
id: WP-20260101-001
type: wp
role: developer
status: draft
---

Intent.

## Scope

### Change requests

### Delivers
- [E1-FR1](../../epics/E1-x/E1-FR1.md)
- [E1-FR2](../../epics/E1-x/E1-FR2.md)

### Constraints
`,
  );
  const before = readFileSync(join(gaps, "epics/E1-x/E1-FR1.md"), "utf8");
  const st = baJson(cli, ["status", "--repo", gaps], consumer);
  if (st.status !== 2) fail(`gappy status exit ${st.status}, expected advisory 2`);
  if (st.json.verdict !== "VERIFY-OK") fail("status advisory must stay VERIFY-OK");
  const noAc = st.json.checks.find((c) => c.name === "missing:requirement-without-ac");
  if (!noAc || noAc.ok) fail("expected requirement-without-ac");
  for (const id of ["E1-FR1", "E1-FR2", "E1-FR3"]) {
    if (!noAc.reason.includes(id)) fail(`missing AC did not report ${id}: ${noAc.reason}`);
  }
  const noWp = st.json.checks.find((c) => c.name === "missing:requirement-not-linked-to-wp");
  if (!noWp || noWp.ok) fail("expected requirement-not-linked-to-wp");
  if (!noWp.reason.includes("E1-FR3")) fail(`not-linked must include E1-FR3: ${noWp.reason}`);
  if (noWp.reason.includes("E1-FR1") || noWp.reason.includes("E1-FR2")) {
    fail(`WP-linked FRs must not be not-linked: ${noWp.reason}`);
  }
  if (readFileSync(join(gaps, "epics/E1-x/E1-FR1.md"), "utf8") !== before) {
    fail("status must remain read-only");
  }
  proven.push("1.6 status missing detector");
}

console.log(JSON.stringify({ ok: true, source: "external-tgz", proven }, null, 2));
rmSync(packBase, { recursive: true, force: true });
rmSync(consumer, { recursive: true, force: true });
