/** Tripwire: a test run must never resolve a real user directory, only the per-run isolated root. */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pinnedPopulation } from './population.js'
import { normalizePath } from '../../src/paths.js'
import { claudeConfigDir, claudeGlobalJsonPath } from '../../src/claude_config_dir.js'
import { configPath, dataDir, globalDbPath, tokenGoatHome } from '../../src/constants.js'
import { skillOutputsDir } from '../../src/skill_cache.js'
import { copilotCliCacheRoot, copilotCliMcpToolsDir, copilotCliUserRoot } from '../../src/copilot_home.js'
import { codexConfigPath, codexHomeDir, grokConfigPath, grokHooksDir, kimiConfigPath, kimiHome } from '../../src/purge.js'
import { antigravityHooksPath, antigravityPluginsDir } from '../../src/bridges/antigravity_install.js'
import { aiderUserConventionsPath } from '../../src/bridges/aider_install.js'
import { codexAgentsPath, codexHookScriptPath } from '../../src/bridges/codex_install.js'
import { copilotCliConfigPath, copilotCliInstructionsPath, copilotCliUserHooksDir } from '../../src/bridges/copilot_cli_install.js'
import { copilotMcpConfigPath } from '../../src/bridges/copilot_mcp_install.js'
import { cursorMcpPath } from '../../src/bridges/cursor_install.js'
import { geminiSettingsPath } from '../../src/bridges/gemini_install.js'
import { grokHookScriptPath } from '../../src/bridges/grok_install.js'
import { jetbrainsUserMcpPath } from '../../src/bridges/jetbrains_install.js'
import { kimiAgentsPath, kimiSkillDir } from '../../src/bridges/kimi_install.js'
import { neovimUserConfigPath } from '../../src/bridges/neovim_install.js'
import { openclawConfigPath, openclawPluginPath } from '../../src/bridges/openclaw_install.js'
import { opencodePluginPath } from '../../src/bridges/opencode_install.js'
import { piGlobalExtensionPath } from '../../src/bridges/pi_install.js'
import { qwenSettingsPath } from '../../src/bridges/qwen_install.js'

// The real values isolate-home.ts captured as TG_REAL_<NAME> before it redirected each one.
const REAL_NAMES = ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR'] as const

function capturedRealDirs(): Array<readonly [string, string]> {
  const out: Array<readonly [string, string]> = []
  for (const name of REAL_NAMES) {
    const value = process.env[`TG_REAL_${name}`]
    if (value !== undefined && value.trim() !== '') out.push([name, value])
  }
  return out
}

function sandboxRoot(): string {
  const root = process.env['TG_TEST_RUN_ROOT']
  if (root === undefined || root.trim() === '') throw new Error('TG_TEST_RUN_ROOT is unset: globalSetup did not run')
  return root
}

// The product's own canonical form (slashes, 8.3 names, drive letter, macOS /var alias), then case-folded on Windows.
function normalise(p: string): string {
  const canonical = normalizePath(path.resolve(p)).replace(/\/+$/, '')
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

function isInside(child: string, root: string): boolean {
  const c = normalise(child)
  const r = normalise(root)
  return c === r || c.startsWith(`${r}/`)
}

// Throws unless resolved sits in the run root and in no real directory that does not contain the root.
function assertIsolated(label: string, resolved: string, realDirs: ReadonlyArray<readonly [string, string]>, root: string): void {
  if (!isInside(resolved, root)) {
    throw new Error(`${label} resolves to ${resolved}, outside the isolated run root ${root}`)
  }
  for (const [name, dir] of realDirs) {
    if (isInside(root, dir)) continue
    if (isInside(resolved, dir)) throw new Error(`${label} resolves to ${resolved}, inside the real ${name} directory ${dir}`)
  }
}

// Every exported user-level path resolver, called with no arguments under the standard setup.
const RESOLVERS: ReadonlyArray<readonly [string, () => string]> = [
  ['dataDir', dataDir],
  ['tokenGoatHome', tokenGoatHome],
  ['configPath', configPath],
  ['globalDbPath', globalDbPath],
  ['claudeConfigDir', () => claudeConfigDir()],
  ['claudeGlobalJsonPath', () => claudeGlobalJsonPath()],
  ['skillOutputsDir', skillOutputsDir],
  ['copilotCliUserRoot', () => copilotCliUserRoot()],
  ['copilotCliCacheRoot', copilotCliCacheRoot],
  ['copilotCliMcpToolsDir', copilotCliMcpToolsDir],
  ['codexHomeDir', codexHomeDir],
  ['codexConfigPath', codexConfigPath],
  ['grokHooksDir', grokHooksDir],
  ['grokConfigPath', grokConfigPath],
  ['kimiHome', kimiHome],
  ['kimiConfigPath', kimiConfigPath],
  ['antigravityPluginsDir', antigravityPluginsDir],
  ['antigravityHooksPath', antigravityHooksPath],
  ['aiderUserConventionsPath', aiderUserConventionsPath],
  ['codexAgentsPath', codexAgentsPath],
  ['codexHookScriptPath', codexHookScriptPath],
  ['copilotCliUserHooksDir', copilotCliUserHooksDir],
  ['copilotCliConfigPath', () => copilotCliConfigPath()],
  ['copilotCliInstructionsPath', () => copilotCliInstructionsPath()],
  ['copilotMcpConfigPath', copilotMcpConfigPath],
  ['cursorMcpPath', () => cursorMcpPath()],
  ['geminiSettingsPath', geminiSettingsPath],
  ['grokHookScriptPath', grokHookScriptPath],
  ['jetbrainsUserMcpPath', jetbrainsUserMcpPath],
  ['kimiAgentsPath', kimiAgentsPath],
  ['kimiSkillDir', kimiSkillDir],
  ['neovimUserConfigPath', neovimUserConfigPath],
  ['openclawConfigPath', openclawConfigPath],
  ['openclawPluginPath', openclawPluginPath],
  ['opencodePluginPath', opencodePluginPath],
  ['piGlobalExtensionPath', piGlobalExtensionPath],
  ['qwenSettingsPath', qwenSettingsPath],
]

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, out)
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

const HOME_ENV_KEYS = 'HOME|USERPROFILE|LOCALAPPDATA|APPDATA|XDG_[A-Z_]+|TG_REAL_[A-Z_]+'
const HOME_ENV_READ = new RegExp(`\\benv(?:\\[\\s*['"\`](?:${HOME_ENV_KEYS})['"\`]\\s*\\]|\\.(?:${HOME_ENV_KEYS})\\b)`)

// Code lines only: a comment line is prose about code, not a read.
function codeLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => {
    const code = line.trim()
    return !(code.startsWith('//') || code.startsWith('*') || code.startsWith('/*'))
  })
}

function relative(full: string): string {
  return path.relative(process.cwd(), full).split(path.sep).join('/')
}

// Per-file count of lines reading homedir (any form, aliases included) or a home-style env variable.
function homeReadCounts(files: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const full of files) {
    const lines = codeLines(fs.readFileSync(full, 'utf8'))
    const n = lines.filter((line) => /\bhomedir\b/.test(line) || HOME_ENV_READ.test(line)).length
    if (n > 0) counts.set(relative(full), n)
  }
  return counts
}

// Per-file count of lines calling userInfo, the one account read that ignores HOME and USERPROFILE.
function accountLookupCounts(files: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const full of files) {
    const n = codeLines(fs.readFileSync(full, 'utf8')).filter((line) => /\buserInfo\b/.test(line)).length
    if (n > 0) counts.set(relative(full), n)
  }
  return counts
}

// Ratchet: each listed file may hold exactly this many home-read lines; any other count fails.
// Each one is an os.homedir() default or a home-variable read, which setup redirects into the run root.
const SANCTIONED_HOME_READS: Readonly<Record<string, number>> = {
  'src/bridges/aider_install.ts': 1,
  'src/bridges/antigravity_install.ts': 1,
  'src/bridges/copilot_session_start.ts': 1,
  'src/bridges/cursor_install.ts': 1,
  'src/bridges/detect_ecosystems.ts': 1,
  'src/bridges/gemini_install.ts': 1,
  'src/bridges/jetbrains_install.ts': 2,
  'src/bridges/neovim_install.ts': 1,
  'src/bridges/openclaw.ts': 2,
  'src/bridges/openclaw_install.ts': 1,
  'src/bridges/opencode_install.ts': 4,
  'src/bridges/pi.ts': 2,
  'src/bridges/pi_install.ts': 1,
  'src/bridges/qwen_install.ts': 1,
  'src/bridges/visualstudio_install.ts': 2,
  'src/bridges/vscode_install.ts': 7,
  'src/bridges/zed_install.ts': 4,
  'src/claude_config_dir.ts': 2,
  'src/cli_bootstrap_audit.ts': 1,
  'src/cli_context_stats.ts': 3,
  'src/cli_doctor_harness_perf.ts': 3,
  'src/cli_mcp_audit.ts': 1,
  'src/codex_rules.ts': 1,
  'src/constants.ts': 5,
  'src/copilot_home.ts': 4,
  'src/copilot_skill_path.ts': 2,
  'src/hooks_bash_commands.ts': 2,
  'src/mcp_server.ts': 2,
  'src/purge.ts': 3,
  'src/screenshot.ts': 3,
  'src/session_audit.ts': 2,
  'src/sharepoint_resolve.ts': 1,
  'src/shell.ts': 2,
  'src/skip_scope.ts': 1,
  'src/spec_path.ts': 1,
  'src/vscode_duplicate.ts': 1,
  'src/walk_index.ts': 1,
}

// Account lookups allowed; both are darwin-only and feed a managed-prefs path that sourceAllowed refuses.
const SANCTIONED_ACCOUNT_LOOKUPS: Readonly<Record<string, number>> = {
  'src/codex_rules.ts': 1,
  'src/rewrite_permission.ts': 1,
}

function diffCounts(actual: Map<string, number>, listed: Readonly<Record<string, number>>): string[] {
  const keys = new Set([...actual.keys(), ...Object.keys(listed)])
  const problems: string[] = []
  for (const key of [...keys].sort()) {
    const have = actual.get(key) ?? 0
    const want = listed[key] ?? 0
    if (have !== want) problems.push(`${key}: ${have} read line(s), ratchet allows ${want}`)
  }
  return problems
}

describe('user-level resolvers stay inside the isolated run root', () => {
  it('resolves every exported user-level path inside the run root and outside every real user directory', () => {
    const root = sandboxRoot()
    const realDirs = capturedRealDirs()
    expect(realDirs.map(([name]) => name)).toContain('HOME')
    const failures: string[] = []
    for (const [label, resolve] of RESOLVERS) {
      try {
        assertIsolated(label, resolve(), realDirs, root)
      } catch (err) {
        failures.push((err as Error).message)
      }
    }
    expect(failures).toEqual([])
  })

  it('fails when a resolver result points at a captured real directory', () => {
    const root = sandboxRoot()
    const realDirs = capturedRealDirs()
    const probes = realDirs.map(([name, dir]) => ({ name, target: path.join(dir, 'token-goat-tripwire-probe') }))
    expect(probes.length).toBeGreaterThan(0)
    for (const { name, target } of probes) {
      expect(() => assertIsolated(`probe ${name}`, target, realDirs, root)).toThrow(/inside the real|outside the isolated run root/)
    }
  })

  it('accepts a resolver result inside the run root, so the refusal above is not a blanket one', () => {
    const root = sandboxRoot()
    expect(() => assertIsolated('probe run root', path.join(root, 'tg-test-data-probe'), capturedRealDirs(), root)).not.toThrow()
  })
})

describe('no source file reads a home-style location outside the sanctioned set', () => {
  it('lists every src file that reads homedir or a home variable, with the count the ratchet allows', () => {
    const files = pinnedPopulation({
      what: 'src/**/*.ts files scanned for home-style reads',
      items: sourceFiles(path.join(process.cwd(), 'src')),
      floor: 400,
      mustInclude: ['constants.ts', 'purge.ts'],
    })
    expect(diffCounts(homeReadCounts(files), SANCTIONED_HOME_READS)).toEqual([])
  })

  it('lists every src file that performs an account lookup, with the count the ratchet allows', () => {
    const files = pinnedPopulation({
      what: 'src/**/*.ts files scanned for account lookups',
      items: sourceFiles(path.join(process.cwd(), 'src')),
      floor: 400,
      mustInclude: ['constants.ts'],
    })
    expect(diffCounts(accountLookupCounts(files), SANCTIONED_ACCOUNT_LOOKUPS)).toEqual([])
  })
})
