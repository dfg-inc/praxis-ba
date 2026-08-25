#!/usr/bin/env node
/**
 * BA session bootstrap (WBS 1.4 / 1.5) — role ba, stage research.
 * Usage: node tools/session-bootstrap.mjs [repo-root]
 * Requires @praxis/plugin-sdk (and deps) built in the workspace.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootstrapSession, formatSessionBootstrap } from '@praxis/plugin-sdk'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const pluginJson = JSON.parse(
  readFileSync(join(pluginRoot, '.claude-plugin/plugin.json'), 'utf8')
)
const repoRoot = process.argv[2] ? join(process.cwd(), process.argv[2]) : process.cwd()

const boot = bootstrapSession({
  repoRoot,
  role: 'ba',
  stage: 'research',
  pluginName: String(pluginJson.name ?? 'praxis-ba'),
  pluginVersion: String(pluginJson.version ?? '0.0.0'),
})

process.stdout.write(`${formatSessionBootstrap(boot)}\n`)
