import { join } from "node:path";

export const PLUGINS = [
{
    id: "praxis-ba",
    title: "Praxis BA",
    src: "plugins/ba",
    role: "ba",
    requiredSkills: [
      "jira-epic-analysis",
      "resume-ba-work",
      "ba-jira-status",
    ],
    helpCommands: [["ba", "--help"], ["ba", "preview", "--help"]],
  }
]

export const PLUGIN_ZIP_FILES = PLUGINS.map((p) => `${p.id}.zip`);
export const MANIFEST_CONTRACT = "praxis.claude-plugins.manifest";

export function distClaudePluginsDir(root, version) {
  return join(root, "dist", "claude-plugins", version);
}

export function repoClaudePluginsDir(root) {
  return join(root, "claude-plugins");
}
