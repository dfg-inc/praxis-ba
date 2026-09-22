#!/usr/bin/env node
/**
 * Packed-BA acceptance for WBS 1.11 / 1.14 / 1.16 / 1.17 (no network, no LLM).
 *
 *   node tools/scripts/ba-outcomes-acceptance.mjs [--rebuild]
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
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parse as yamlParse } from "yaml";
import { buildAllPluginArtifacts } from "./package-plugins.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const mirror = join(root, "dist/release-mirror");
const rebuild = process.argv.includes("--rebuild");

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

function walkFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) walkFiles(p, acc);
    else acc.push(p);
  }
  return acc;
}

function snapshotCanon(canon) {
  const map = {};
  for (const f of walkFiles(canon).sort()) {
    map[relative(canon, f)] = readFileSync(f, "utf8");
  }
  return map;
}

function seedCounters(canon, extra = "") {
  write(
    join(canon, ".ba/counters.yaml"),
    `product:\n  epic: 1\n  cr: 1\n  wp: 1\n  bug: 0\n  baselineSeq: {}\nepics:\n  E1:\n    fr: 3\n    nfr: 1\n    br: 1\nretired: []\n${extra}`,
  );
}

function seedGoal(canon, id, status, title) {
  write(
    join(canon, `goals/${id}.md`),
    `---
id: ${id}
type: goal
title: ${title}
status: ${status}
---

Outcome for ${id}.
`,
  );
}

function seedFr(canon, id, opts = {}) {
  const {
    status = "active",
    body = "Story.\n",
    tracesTo = "[]",
    enforces = "[]",
    referencesNfr = "[]",
    goalIds,
    baseline,
  } = opts;
  const extra = [];
  if (goalIds) extra.push(`goal_ids: ${goalIds}`);
  if (baseline) extra.push(`baseline: ${baseline}`);
  write(
    join(canon, `epics/E1-x/${id}.md`),
    `---
id: ${id}
type: fr
epic: E1
status: ${status}
version: 1
traces_to: ${tracesTo}
enforces: ${enforces}
references_nfr: ${referencesNfr}
related: []
${extra.join("\n")}${extra.length ? "\n" : ""}---

${body}
`,
  );
}

function seedNfr(canon, id, opts = {}) {
  const { status = "active", tracesTo = "[]", goalIds } = opts;
  const extra = goalIds ? `goal_ids: ${goalIds}\n` : "";
  write(
    join(canon, `epics/E1-x/${id}.md`),
    `---
id: ${id}
type: nfr
epic: E1
status: ${status}
version: 1
traces_to: ${tracesTo}
verified_by: []
related: []
${extra}---

A Planguage constraint.
`,
  );
}

function seedBr(canon, id, status = "active") {
  write(
    join(canon, `br/${id}.md`),
    `---
id: ${id}
type: br
epic: E1
kind: operative
enforcement: advisory
status: ${status}
version: 1
---

A rule sentence.
`,
  );
}

function seedVision(canon) {
  write(join(canon, "vision.md"), "---\ntype: vision\nstatus: confirmed\n---\n\nConfirmed vision.\n");
}

function seedCr(canon) {
  write(
    join(canon, "cr/CR-001.md"),
    `---
id: CR-001
type: cr
status: confirmed
entry_point: requirement
entry_point_confirmed: true
impacts:
  - spawns: fr
    epic: E1
    realized: E1-FR1
  - spawns: nfr
    epic: E1
    realized: E1-NFR1
---

Captured idea.
`,
  );
}

function seedWp(canon, status) {
  write(
    join(canon, "wp/WP-20260101-001/index.md"),
    `---
id: WP-20260101-001
type: wp
role: developer
status: ${status}
---

A work package.

## Scope

### Delivers

- [E1-FR1](epics/x/E1-FR1.md)
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

const packBase = mkdtempSync(join(tmpdir(), "praxis-ba-outcomes-pack-"));
const dest = join(packBase, "ba");
cpSync(join(mirror, "plugins/ba"), dest, { recursive: true });
const pack = run("npm pack", dest);
if (!pack.ok) fail(`npm pack ba: ${pack.stderr}`);
const tgz = readdirSync(dest).find((f) => f.endsWith(".tgz"));
if (!tgz) fail("no ba tgz");

const consumer = mkdtempSync(join(tmpdir(), "praxis-ba-outcomes-"));
write(join(consumer, "package.json"), JSON.stringify({ name: "praxis-ba-outcomes", private: true }));
const install = run(`npm install "${join(dest, tgz)}"`, consumer);
if (!install.ok) fail(`npm install failed:\n${install.stderr}`);

const cli = join(consumer, "node_modules/@praxis/ba/bin/praxis-ba.cjs");
const onePager = join(consumer, "node_modules/@praxis/ba/tools/one-pager.mjs");
if (!existsSync(cli)) fail("installed praxis-ba.cjs missing");
if (!existsSync(onePager)) fail("packed tools/one-pager.mjs missing");

const proven = [];

// --- 1.11 goals (packed) ---
{
  const canon = join(consumer, "goals-canon");
  seedCounters(canon);
  seedGoal(canon, "G1", "active", "Linked outcome");
  seedGoal(canon, "G2", "active", "Orphan outcome");
  seedGoal(canon, "G3", "retired", "Retired unused");
  seedFr(canon, "E1-FR1", {
    goalIds: "[G1]",
    body: "Linked.\n\n## Acceptance Criteria\n- AC-1: given a, when b, then c\n",
  });
  seedFr(canon, "E1-FR2", {
    body: "Unlinked.\n\n## Acceptance Criteria\n- AC-1: given a, when b, then c\n",
  });
  seedFr(canon, "E1-FR3", {
    status: "retired",
    body: "Retired without goal.\n\n## Acceptance Criteria\n- AC-1: given a, when b, then c\n",
  });

  const gs = baJson(cli, ["goals", "status", "--repo", canon], consumer);
  if (gs.json.verdict !== "VERIFY-OK") fail(`goals status verdict ${gs.json.verdict}`);
  if (gs.status !== 2) fail(`gappy goals status exit ${gs.status}, expected advisory 2`);
  const withoutGoals = gs.json.checks.find((c) => c.name === "requirements-without-goals");
  const withoutReqs = gs.json.checks.find((c) => c.name === "goals-without-requirements");
  if (!withoutGoals || withoutGoals.ok) fail("expected requirements-without-goals");
  if (!withoutGoals.reason.includes("E1-FR2")) fail(`unlinked FR not reported: ${withoutGoals.reason}`);
  if (withoutGoals.reason.includes("E1-FR1")) fail(`linked FR reported as unlinked: ${withoutGoals.reason}`);
  if (withoutGoals.reason.includes("E1-FR3")) fail(`retired FR created a false gap: ${withoutGoals.reason}`);
  if (!withoutReqs || withoutReqs.ok) fail("expected goals-without-requirements");
  if (!withoutReqs.reason.includes("G2")) fail(`orphan goal not reported: ${withoutReqs.reason}`);
  if (withoutReqs.reason.includes("G1")) fail(`linked G1 reported as orphan: ${withoutReqs.reason}`);
  if (withoutReqs.reason.includes("G3")) fail(`retired goal created a false gap: ${withoutReqs.reason}`);

  seedFr(canon, "E1-FR2", {
    goalIds: "[G1]",
    body: "Now linked.\n\n## Acceptance Criteria\n- AC-1: given a, when b, then c\n",
  });
  seedGoal(canon, "G2", "retired", "Orphan outcome");
  const clean = baJson(cli, ["goals", "status", "--repo", canon], consumer);
  if (clean.status !== 0) fail(`completed links should be clean, exit ${clean.status}`);
  const wg = clean.json.checks.find((c) => c.name === "requirements-without-goals");
  const wr = clean.json.checks.find((c) => c.name === "goals-without-requirements");
  if (!wg?.ok || !wr?.ok) fail(`expected clean goals status: ${JSON.stringify(clean.json.checks)}`);
  proven.push("1.11 goals reverse-link + status");
}

// --- 1.16 requirement without goal (packed diagnostic, no mutation) ---
{
  const canon = join(consumer, "goals-diag-canon");
  seedCounters(canon);
  seedGoal(canon, "G1", "active", "Linked outcome");
  seedFr(canon, "E1-FR1", {
    goalIds: "[G1]",
    body: "Linked.\n\n## Acceptance Criteria\n- AC-1: given a, when b, then c\n",
  });
  seedFr(canon, "E1-FR2", {
    body: "Unlinked.\n\n## Acceptance Criteria\n- AC-1: given a, when b, then c\n",
  });
  const before = snapshotCanon(canon);
  const st = baJson(cli, ["status", "--repo", canon], consumer);
  const gs = baJson(cli, ["check-goals", "--repo", canon], consumer);
  if (st.json.verdict !== "VERIFY-OK" || gs.json.verdict !== "VERIFY-OK") {
    fail("diagnostic must stay VERIFY-OK (advisory)");
  }
  const missing = st.json.checks.find((c) => c.name === "missing:requirement-without-goal");
  if (!missing || missing.ok) fail("status must report requirement-without-goal");
  if (!missing.reason.includes("E1-FR2")) fail(`status finding missing E1-FR2: ${missing.reason}`);
  if (missing.reason.includes("E1-FR1")) fail(`linked FR reported without goal: ${missing.reason}`);
  const reqs = gs.json.checks.find((c) => c.name === "requirements-without-goals");
  if (!reqs || reqs.ok || !reqs.reason.includes("E1-FR2")) {
    fail(`check-goals must name E1-FR2: ${reqs?.reason}`);
  }
  if (reqs.reason.includes("E1-FR1")) fail("linked FR must not appear in check-goals");
  const after = snapshotCanon(canon);
  if (JSON.stringify(before) !== JSON.stringify(after)) fail("goals diagnostic mutated canon");
  proven.push("1.16 requirement-without-goal diagnostic");
}

// --- 1.14 one-pager (packed tool) ---
{
  const canon = join(consumer, "one-pager-canon");
  seedCounters(canon);
  const liveBody = `Story.

## Назначение

LIVE PURPOSE UNIQUE.

## Acceptance Criteria
- AC-1: given live, when acting, then live outcome.
`;
  seedFr(canon, "E1-FR1", { body: liveBody });
  write(
    join(canon, "baselines/BL-20200101/E1-FR1.md"),
    `---
id: E1-FR1
type: fr
epic: E1
status: baselined
version: 1
traces_to: []
enforces: []
references_nfr: []
related: []
---

## Назначение

FROZEN PURPOSE MUST NOT APPEAR.

## Acceptance Criteria
- AC-1: given frozen, when frozen, then frozen.
`,
  );
  seedGoal(canon, "G1", "active", "Not an FR");
  const src = join(canon, "epics/E1-x/E1-FR1.md");
  const before = readFileSync(src);

  const okRun = run(`node "${onePager}" --repo "${canon}" --id E1-FR1`, consumer);
  if (!okRun.ok) fail(`one-pager happy path failed:\n${okRun.stdout}\n${okRun.stderr}`);
  const page = join(canon, "one-pagers/E1-FR1.md");
  if (!existsSync(page)) fail("one-pager did not write output");
  const doc = readFileSync(page, "utf8");
  if (!doc.includes("LIVE PURPOSE UNIQUE.")) fail("one-pager missing live purpose");
  if (doc.includes("FROZEN PURPOSE MUST NOT APPEAR")) fail("one-pager used frozen copy");
  if (!doc.includes("given live, when acting, then live outcome.")) fail("one-pager did not preserve AC");
  if (Buffer.compare(before, readFileSync(src)) !== 0) fail("one-pager mutated source FR");

  const noPurpose = join(consumer, "op-no-purpose");
  seedCounters(noPurpose);
  seedFr(noPurpose, "E1-FR1", {
    body: "Story.\n\n## Acceptance Criteria\n- AC-1: given a, when b, then c\n",
  });
  const missP = run(`node "${onePager}" --repo "${noPurpose}" --id E1-FR1`, consumer);
  if (missP.ok) fail("missing purpose must fail");
  if (existsSync(join(noPurpose, "one-pagers/E1-FR1.md"))) fail("missing purpose wrote output");

  const noAc = join(consumer, "op-no-ac");
  seedCounters(noAc);
  seedFr(noAc, "E1-FR1", { body: "## Назначение\n\nHas purpose.\n" });
  const missAc = run(`node "${onePager}" --repo "${noAc}" --id E1-FR1`, consumer);
  if (missAc.ok) fail("missing AC must fail");
  if (existsSync(join(noAc, "one-pagers/E1-FR1.md"))) fail("missing AC wrote output");

  const unknown = run(`node "${onePager}" --repo "${canon}" --id E1-FR9`, consumer);
  if (unknown.ok) fail("unknown id must fail");

  const nonFr = run(`node "${onePager}" --repo "${canon}" --id G1`, consumer);
  if (nonFr.ok) fail("non-FR id must fail");
  proven.push("1.14 one-pager live FR");
}

// --- 1.17 accept / baseline (packed explicit accept) ---
{
  const neg = join(consumer, "accept-neg");
  seedCounters(neg);
  seedVision(neg);
  seedCr(neg);
  seedGoal(neg, "G1", "active", "Ship capability");
  seedBr(neg, "E1-BR1");
  seedNfr(neg, "E1-NFR1", { status: "batched", tracesTo: "[CR-001]" });
  seedFr(neg, "E1-FR1", {
    status: "batched",
    tracesTo: "[CR-001]",
    enforces: "[E1-BR1]",
    referencesNfr: "[E1-NFR1]",
    goalIds: "[G1]",
    body: `Story.

## Назначение

Accept fixture.

## Acceptance Criteria
- AC-1: given a starting state, when the user acts, then an observable outcome.
`,
  });
  seedWp(neg, "plan-approved");
  const badEv = join(consumer, "bad-evidence.json");
  write(
    badEv,
    JSON.stringify({
      wpId: "WP-20260101-001",
      commit: "abc123def",
      testRunHashes: ["hash1"],
      suites: ["unit"],
      producedAt: "2026-01-01T00:00:00Z",
      producedBy: "alex",
      toolVersion: "0.0.1",
    }),
  );
  const bad = baJson(
    cli,
    [
      "accept",
      "--repo",
      neg,
      "--wp",
      "WP-20260101-001",
      "--evidence",
      badEv,
      "--date",
      "20260101",
      "--head-commit",
      "WRONGCOMMIT",
    ],
    consumer,
  );
  if (bad.json.verdict !== "VERIFY-FAIL") fail(`negative accept expected VERIFY-FAIL, got ${bad.json.verdict}`);
  if (existsSync(join(neg, "baselines"))) fail("negative accept created baselines/");
  const wpNeg = readFileSync(join(neg, "wp/WP-20260101-001/index.md"), "utf8");
  if (/status:\s*accepted/.test(wpNeg)) fail("negative accept accepted the WP");
  if (/status:\s*baselined/.test(readFileSync(join(neg, "epics/E1-x/E1-FR1.md"), "utf8"))) {
    fail("negative accept baselined a requirement");
  }
  proven.push("1.17 accept negative gate");

  const okCanon = join(consumer, "accept-ok");
  seedCounters(okCanon);
  seedVision(okCanon);
  seedCr(okCanon);
  seedGoal(okCanon, "G1", "active", "Ship capability");
  seedBr(okCanon, "E1-BR1");
  seedNfr(okCanon, "E1-NFR1", { status: "batched", tracesTo: "[CR-001]" });
  seedFr(okCanon, "E1-FR1", {
    status: "batched",
    tracesTo: "[CR-001]",
    enforces: "[E1-BR1]",
    referencesNfr: "[E1-NFR1]",
    goalIds: "[G1]",
    body: `Story.

## Назначение

Accept fixture.

## Acceptance Criteria
- AC-1: given a starting state, when the user acts, then an observable outcome.
`,
  });
  seedWp(okCanon, "plan-approved");
  const ev = join(consumer, "ok-evidence.json");
  write(
    ev,
    JSON.stringify({
      wpId: "WP-20260101-001",
      commit: "abc123def",
      testRunHashes: ["hash1"],
      suites: ["unit"],
      producedAt: "2026-01-01T00:00:00Z",
      producedBy: "alex",
      toolVersion: "0.0.1",
    }),
  );
  const first = baJson(
    cli,
    [
      "accept",
      "--repo",
      okCanon,
      "--wp",
      "WP-20260101-001",
      "--evidence",
      ev,
      "--date",
      "20260101",
      "--head-commit",
      "abc123def",
    ],
    consumer,
  );
  if (first.json.verdict !== "VERIFY-OK") {
    fail(`happy accept VERIFY-FAIL: ${JSON.stringify(first.json)}\n${first.stderr}`);
  }
  const frRaw = readFileSync(join(okCanon, "epics/E1-x/E1-FR1.md"), "utf8");
  const nfrRaw = readFileSync(join(okCanon, "epics/E1-x/E1-NFR1.md"), "utf8");
  const wpRaw = readFileSync(join(okCanon, "wp/WP-20260101-001/index.md"), "utf8");
  if (!/status:\s*baselined/.test(frRaw) || !/status:\s*baselined/.test(nfrRaw)) {
    fail("delivered requirements were not baselined");
  }
  if (!/status:\s*accepted/.test(wpRaw)) fail("WP was not accepted");
  const blMatch = /baseline:\s*(BL-20260101(?:-\d+)?)/.exec(frRaw);
  if (!blMatch) fail("no baseline id on FR");
  const blId = blMatch[1];
  const blDir = join(okCanon, "baselines", blId);
  const manifestPath = join(blDir, "manifest.yaml");
  if (!existsSync(manifestPath)) fail("missing baselines/<BL-id>/manifest.yaml");
  if (!existsSync(join(blDir, "E1-FR1.md")) || !existsSync(join(blDir, "E1-NFR1.md"))) {
    fail("frozen copies missing");
  }
  const manifest = yamlParse(readFileSync(manifestPath, "utf8"));
  if (manifest.id !== blId) fail(`manifest id ${manifest.id} != ${blId}`);
  if (manifest.triggered_by !== "WP-20260101-001") fail("manifest triggered_by");
  if (!manifest.wp_ids?.includes("WP-20260101-001")) fail("manifest wp_ids");
  const itemIds = (manifest.items ?? []).map((i) => i.id).sort();
  if (JSON.stringify(itemIds) !== JSON.stringify(["E1-FR1", "E1-NFR1"])) {
    fail(`manifest items ${itemIds.join(",")}`);
  }
  if (manifest.accepted_by !== "alex") fail("manifest accepted_by");
  if (manifest.verify_evidence_ref !== ".ba/cache/verify-WP-20260101-001.json") {
    fail(`manifest verify_evidence_ref ${manifest.verify_evidence_ref}`);
  }
  const blNames = readdirSync(join(okCanon, "baselines")).filter((n) => n.startsWith("BL-"));
  if (blNames.length !== 1) fail(`expected one baseline dir, got ${blNames.join(",")}`);
  const afterFirst = {
    fr: frRaw,
    nfr: nfrRaw,
    wp: wpRaw,
    manifest: readFileSync(manifestPath, "utf8"),
    frozen: readdirSync(blDir).sort().join(","),
  };

  const second = baJson(
    cli,
    [
      "accept",
      "--repo",
      okCanon,
      "--wp",
      "WP-20260101-001",
      "--evidence",
      ev,
      "--date",
      "20260101",
      "--head-commit",
      "abc123def",
    ],
    consumer,
  );
  if (second.json.verdict !== "VERIFY-OK") fail(`idempotent accept not VERIFY-OK: ${JSON.stringify(second.json)}`);
  const already = (second.json.checks ?? []).some((c) => c.name === "already-accepted" && c.ok);
  if (!already) fail(`idempotent accept missing already-accepted: ${JSON.stringify(second.json.checks)}`);
  const blNames2 = readdirSync(join(okCanon, "baselines")).filter((n) => n.startsWith("BL-"));
  if (blNames2.length !== 1) fail("second accept created another baseline");
  if (readFileSync(join(okCanon, "epics/E1-x/E1-FR1.md"), "utf8") !== afterFirst.fr) {
    fail("idempotent accept rewrote the FR");
  }
  if (readFileSync(join(okCanon, "epics/E1-x/E1-NFR1.md"), "utf8") !== afterFirst.nfr) {
    fail("idempotent accept rewrote the NFR");
  }
  if (readFileSync(join(okCanon, "wp/WP-20260101-001/index.md"), "utf8") !== afterFirst.wp) {
    fail("idempotent accept rewrote the WP");
  }
  if (readFileSync(manifestPath, "utf8") !== afterFirst.manifest) fail("idempotent accept rewrote the manifest");
  if (readdirSync(blDir).sort().join(",") !== afterFirst.frozen) fail("idempotent accept changed frozen copies");
  proven.push("1.17 accept happy path + idempotency");
}

rmSync(packBase, { recursive: true, force: true });

console.log(JSON.stringify({ ok: true, source: "external-tgz", proven }, null, 2));
