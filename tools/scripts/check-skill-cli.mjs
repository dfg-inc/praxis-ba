#!/usr/bin/env node
/**
 * Product role Skills for Claude UI must use MCP tools, not the Praxis CLI.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ROLES = ["ba"];
const FORBIDDEN_PRIVATE = [
  /plugins\/jira\/tools\//,
  /jira-workflow\.mjs/,
  /tools\/praxis\.mjs/,
];

const UI_SKILLS = {
  ba: [
    "jira-epic-analysis",
    "resume-ba-work",
    "ba-jira-status",
    "jira-analyze-epic",
  ],
  architect: [
    "plan-jira-epic",
    "resume-architecture",
    "materialize-work-package",
    "architecture-status",
    "jira-plan-epic",
  ],
  developer: [
    "implement-work-package",
    "resume-work-package",
    "developer-status",
    "claim-work-package",
    "git-status",
    "connect-git",
    "prepare-git-delivery",
    "commit-approved-changes",
    "publish-branch",
    "create-merge-request",
    "check-delivery-status",
  ],
  quality: ["review-work-package", "resume-qa", "quality-status", "verify-work-package"],
};

const FORBIDDEN_CLI = [
  /\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/praxis/,
  /\bbin\/praxis\b/,
  /praxis ba preview/,
  /praxis ba apply/,
  /praxis architect preview/,
  /praxis architect apply/,
  /praxis developer claim/,
  /praxis quality review/,
  /praxis doctor --json/,
  /launchctl setenv/,
  /source \.env/,
];

const ROLE_FORBIDDEN_TOOLS = {
  ba: [
    "praxis_architect_preview",
    "praxis_architect_apply",
    "praxis_developer_claim",
    "praxis_developer_complete",
    "praxis_quality_review",
    "praxis_quality_apply_preview",
    "praxis_quality_apply",
    "praxis_quality_apply_status",
    "praxis_quality_review_show",
    "praxis_quality_ensure",
    "praxis_work_package_list",
    "praxis_work_package_show",
  ],
  architect: [
    "praxis_ba_preview",
    "praxis_ba_apply",
    "praxis_developer_claim",
    "praxis_developer_complete",
    "praxis_quality_review",
    "praxis_quality_apply_preview",
    "praxis_quality_apply",
    "praxis_quality_apply_status",
    "praxis_quality_review_show",
    "praxis_quality_ensure",
  ],
  developer: [
    "praxis_ba_preview",
    "praxis_ba_apply",
    "praxis_architect_preview",
    "praxis_architect_apply",
    "praxis_quality_review",
    "praxis_quality_apply_preview",
    "praxis_quality_apply",
    "praxis_quality_apply_status",
    "praxis_quality_review_show",
    "praxis_quality_ensure",
  ],
  quality: [
    "praxis_ba_preview",
    "praxis_ba_apply",
    "praxis_architect_preview",
    "praxis_architect_apply",
    "praxis_developer_claim",
    "praxis_developer_complete",
  ],
};

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (name === "SKILL.md") out.push(abs);
  }
  return out;
}

const violations = [];
for (const role of ROLES) {
  for (const file of walk(join(root, "plugins", role, "skills"))) {
    const text = readFileSync(file, "utf8");
    for (const re of FORBIDDEN_PRIVATE) {
      if (re.test(text)) {
        violations.push(`${relative(root, file)} matches ${re}`);
      }
    }
  }
  for (const skill of UI_SKILLS[role]) {
    const file = join(root, "plugins", role, "skills", skill, "SKILL.md");
    if (!existsSync(file)) {
      violations.push(`missing UI skill ${relative(root, file)}`);
      continue;
    }
    const text = readFileSync(file, "utf8");
    for (const re of FORBIDDEN_CLI) {
      if (re.test(text)) {
        violations.push(`${relative(root, file)} teaches CLI (${re})`);
      }
    }
    if (!/praxis_[a-z_]+/.test(text)) {
      violations.push(`${relative(root, file)} does not invoke MCP tools`);
    }
    if (!text.includes("PRAXIS_RUNTIME_UNAVAILABLE")) {
      violations.push(`${relative(root, file)} missing PRAXIS_RUNTIME_UNAVAILABLE`);
    }
    if (!text.includes("JIRA_CONFIG_UNAVAILABLE")) {
      violations.push(`${relative(root, file)} missing JIRA_CONFIG_UNAVAILABLE`);
    }
    if (!/Praxis Runtime/.test(text)) {
      violations.push(`${relative(root, file)} does not mention Praxis Runtime`);
    }
    for (const tool of ROLE_FORBIDDEN_TOOLS[role]) {
      if (text.includes(tool)) {
        violations.push(`${relative(root, file)} uses other-role tool ${tool}`);
      }
    }
    if (/preview/.test(skill) || /apply|materialize|analysis|implement|review|claim|plan-jira|jira-analyze|jira-plan|resume/.test(skill)) {
      if (!/approval|confirm|wait|STOP|do not (immediately )?apply|human/i.test(text) && /apply/.test(text)) {
        violations.push(`${relative(root, file)} missing human approval gate`);
      }
    }
    if (/(praxis_ba_apply|praxis_architect_apply|praxis_developer_claim|praxis_quality_apply|praxis_developer_git_commit|praxis_developer_git_publish|praxis_developer_git_connect_apply|praxis_developer_git_merge_request)/.test(text)) {
      if (!/approval|confirm|wait|STOP|Do not .*apply/i.test(text)) {
        violations.push(`${relative(root, file)} write tool without human gate language`);
      }
    }
    if (role === "architect" && text.includes("praxis_architect_preview")) {
      if (!/workPackageId/.test(text)) {
        violations.push(`${relative(root, file)} calls praxis_architect_preview without workPackageId scope`);
      }
      if (!/scope|explicit|not a hint/i.test(text)) {
        violations.push(`${relative(root, file)} does not treat workPackageId as explicit scope`);
      }
    }
  }
}

if (violations.length) {
  console.error("Skill CLI/MCP contract failed:");
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(`Skill MCP contract OK (${ROLES.join(", ")}).`);
