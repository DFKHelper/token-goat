/** Platform and harness integration diagnostics for token-goat doctor. Checks configuration and health across VS Code, Visual Studio, Zed, Cursor, global MCP configuration, and stray CLAUDE.md blocks. */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { cursorManagedEntry } from './bridges/cursor_install.js'
import { findStrayClaudeMdBlocks } from './install.js'
import { hasManagedServer, isResidueServersJson } from './bridges/mcp_servers_json.js'
import { visualStudioManagedEntry } from './bridges/visualstudio_install.js'
import { zedManagedEntry } from './bridges/zed_install.js'
import type { DoctorResult } from './doctor_result.js'
import { displaySafeText, normalizePath } from './paths.js'

export function globalMcpConfigPath(): string {
  const copilotHome = process.env['COPILOT_HOME']
  const root = copilotHome !== undefined && copilotHome.trim() !== ''
    ? path.resolve(copilotHome)
    : path.join(os.homedir(), '.copilot')
  return path.join(root, 'mcp-config.json')
}

export function checkGlobalMcpConfig(configPath = globalMcpConfigPath()): DoctorResult {
  if (!fs.existsSync(configPath)) {
    return { name: 'Global MCP configuration', status: 'ok', message: `no global Copilot MCP configuration found at ${displaySafeText(configPath)}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch {
    return {
      name: 'Global MCP configuration',
      status: 'warn',
      message: `could not read global Copilot MCP configuration at ${displaySafeText(configPath)}; unable to audit heavy launchers.`,
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      name: 'Global MCP configuration',
      status: 'warn',
      message: `global Copilot MCP configuration at ${displaySafeText(configPath)} has an unsupported format; unable to audit heavy launchers.`,
    }
  }

  const configuredServers = (parsed as Record<string, unknown>)['mcpServers']
  if (typeof configuredServers !== 'object' || configuredServers === null || Array.isArray(configuredServers)) {
    return { name: 'Global MCP configuration', status: 'ok', message: `no global stdio MCP servers configured at ${displaySafeText(configPath)}` }
  }

  let chromeDevTools = 0
  let playwright = 0
  for (const server of Object.values(configuredServers)) {
    if (typeof server !== 'object' || server === null || Array.isArray(server)) continue
    const entry = server as Record<string, unknown>
    const rawCommand = entry['command']
    const command = typeof rawCommand === 'string' ? rawCommand : ''
    const args = entry['args']
    if (!/\bnpx(?:\.cmd)?\b/i.test(command) || !Array.isArray(args)) continue
    const invocation = args.filter((arg): arg is string => typeof arg === 'string').join(' ')
    if (/\bchrome-devtools-mcp\b/i.test(invocation)) chromeDevTools += 1
    if (/@playwright[\\/]mcp\b/i.test(invocation)) playwright += 1
  }

  if (chromeDevTools > 0 || playwright > 0) {
    const launchers: string[] = []
    if (chromeDevTools > 0) launchers.push(`${chromeDevTools} Chrome DevTools MCP launcher${chromeDevTools === 1 ? '' : 's'}`)
    if (playwright > 0) launchers.push(`${playwright} Playwright MCP launcher${playwright === 1 ? '' : 's'}`)
    return {
      name: 'Global MCP configuration',
      status: 'warn',
      message: `${launchers.join(' and ')} configured at ${displaySafeText(configPath)}. Move heavy launchers to project scope or remove them when not actively needed.`,
    }
  }

  return { name: 'Global MCP configuration', status: 'ok', message: `no known heavy global MCP launchers configured at ${displaySafeText(configPath)}` }
}

/** What `install --vscode` prints when it walked an existing user-scope install back to project scope. */
export const VSCODE_USER_SCOPE_MIGRATED_NOTE =
  'Moved the VS Code integration from user scope to this project. It used to live in ~/.copilot/hooks, where VS Code resolves its working directory to the FIRST folder of a multi-root workspace and nothing else, so read hints, image shrinking and edit interception were silently doing nothing for every other folder. The shared ~/.copilot/hooks files stay in place if "token-goat install --copilot" still needs them.'

/** What `install --vscode` prints after a project-scope install, since it no longer covers every project. */
export const VSCODE_PROJECT_SCOPE_COVERAGE_NOTE =
  'This covers this project only. Run "token-goat install --vscode" once in each project you want it in, or "token-goat install --vscode --user" for one install covering every project (single-root workspaces only — see below).'

/** What `install --vscode --user` prints, so the opt-out states the limitation it is opting into. */
export const VSCODE_USER_SCOPE_MULTIROOT_NOTE =
  'NOTE: a user-scope install works in every project, but VS Code runs it with the first folder of a multi-root workspace as its working directory, so it does nothing for the other folders. Use "token-goat install --vscode" (project scope, the default) in each folder that needs it.'

/** Report a VS Code hooks install still sitting in user scope, where it cannot see past folders[0]. */
export function checkVscodeUserScopeHooks(userScope: boolean, projectScope: boolean): DoctorResult | null {
  if (!userScope) return null
  return {
    name: 'VS Code hooks scope',
    status: 'warn',
    message: projectScope
      ? 'token-goat VS Code hooks are installed in BOTH ~/.copilot/hooks and this project\'s .github/hooks, and VS Code runs every hooks file it finds, so each hook fires twice. The user-scope copy is also pinned to the first folder of a multi-root workspace. Run "token-goat uninstall --vscode --user" to keep only the project install.'
      : 'token-goat VS Code hooks are installed in user scope (~/.copilot/hooks). VS Code runs them with the FIRST folder of a multi-root workspace as their working directory, so read hints, image shrinking and edit interception do nothing for any other folder. Run "token-goat install --vscode" in each project to move it to project scope.',
  }
}

/** One-line note `install --vscode` prints when VS Code will also run the Claude Code hooks. */
export const VSCODE_DOUBLE_FIRE_NOTE =
  'NOTE: VS Code has chat.useClaudeHooks turned on, so it also runs the token-goat hooks in ~/.claude/settings.json and each one fires twice. Turn chat.useClaudeHooks off in VS Code settings to keep only the --vscode hooks.'

/** Warn when VS Code will run token-goat's Claude Code hooks as well as its own. */
export function checkVscodeClaudeHooks(useClaudeHooks: boolean, claudeHooksInstalled: boolean, vscodeHooksInstalled: boolean): DoctorResult | null {
  if (!useClaudeHooks || !claudeHooksInstalled) return null
  return {
    name: 'VS Code hooks',
    status: 'warn',
    message: vscodeHooksInstalled
      ? 'VS Code has chat.useClaudeHooks on and token-goat hooks are in both ~/.claude/settings.json and the Copilot hooks file, so each hook fires twice in VS Code. Turn chat.useClaudeHooks off in VS Code settings.'
      : 'VS Code has chat.useClaudeHooks on, so it runs the token-goat hooks from ~/.claude/settings.json in Claude Code wire format, which VS Code reads only in part. Run "token-goat install --vscode" and turn chat.useClaudeHooks off in VS Code settings.',
  }
}

/** Name the Claude Code hook events a scope's install lacks, from `missingHookEvents` (install.ts) per scope. Null when neither scope has a token-goat install, so a machine without Claude Code gets no row. An event added by a later release is the usual cause: the existing settings.json keeps the old set until `token-goat install` runs again. */
export function checkClaudeHookEvents(missing: { readonly user: readonly string[] | null; readonly project: readonly string[] | null }): DoctorResult | null {
  const name = 'Claude Code hook events'
  if (missing.user === null && missing.project === null) return null
  const gaps: string[] = []
  if (missing.user !== null && missing.user.length > 0) gaps.push(`user scope lacks ${missing.user.join(', ')}; run: token-goat install`)
  if (missing.project !== null && missing.project.length > 0) gaps.push(`project scope lacks ${missing.project.join(', ')}; run: token-goat install --project`)
  if (gaps.length === 0) return { name, status: 'ok', message: 'every event this build handles is wired' }
  return { name, status: 'warn', message: `${gaps.join('. ')}. Those events never reach token-goat until then; restart any running session afterwards.` }
}

/** `paths` with duplicates removed, comparing on the resolved path. */
export function dedupeByResolvedPath(paths: readonly string[]): string[] {
  const seen = new Set<string>()
  return paths.filter((p) => {
    const key = normalizePath(path.resolve(p)).toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function checkVisualStudio(mcpPaths: readonly string[], alsoReadPaths: readonly string[] = []): DoctorResult | null {
  const found = dedupeByResolvedPath(mcpPaths).flatMap((mcpPath) => {
    const entry = visualStudioManagedEntry(mcpPath)
    return entry === null ? [] : [{ mcpPath, ...entry }]
  })
  if (found.length === 0) return null
  const stale = found.find((e) => !fs.existsSync(e.command) || !fs.existsSync(e.bundlePath))
  if (stale !== undefined) {
    return {
      name: 'Visual Studio',
      status: 'warn',
      message: `the token-goat MCP entry in ${displaySafeText(stale.mcpPath)} points at ${displaySafeText(stale.command)} ${displaySafeText(stale.bundlePath)}, which no longer exists; run "token-goat uninstall --visualstudio" and then "token-goat install --visualstudio" again (add -p for the project entry).`,
    }
  }
  const registered = dedupeByResolvedPath([...found.map((e) => e.mcpPath), ...alsoReadPaths.filter((p) => visualStudioManagedEntry(p) !== null)])
  if (registered.length > 1) {
    return {
      name: 'Visual Studio',
      status: 'warn',
      message: `Visual Studio reads ${registered.map(displaySafeText).join(' and ')}, and each registers token-goat, so it lists the token-goat server more than once. Keep one: "token-goat uninstall --vscode -p" drops the .vscode/mcp.json entry, "token-goat uninstall --visualstudio" (add -p for the project entry) drops a Visual Studio one.`,
    }
  }
  return {
    name: 'Visual Studio',
    status: 'ok',
    message: `MCP server registered in ${found.map((e) => displaySafeText(e.mcpPath)).join(', ')}. Visual Studio runs no token-goat hooks: it gets the MCP tools and instructions only, and only once the token-goat tools are ticked in the chat Tools picker.`,
  }
}

export function checkZed(settingsPath: string): DoctorResult | null {
  const entry = zedManagedEntry(settingsPath)
  if (entry === null) return null
  const shimPath = entry.command
  if (!fs.existsSync(shimPath)) {
    return {
      name: 'Zed',
      status: 'warn',
      message: `the token-goat MCP entry in ${displaySafeText(settingsPath)} points at ${displaySafeText(shimPath)}, which no longer exists; run "token-goat uninstall --zed" and then "token-goat install --zed" again.`,
    }
  }
  const script = fs.readFileSync(shimPath, 'utf8')
  const referencedPaths = [...script.matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((p): p is string => typeof p === 'string' && p.length > 0)
  const stalePath = referencedPaths.find((p) => !fs.existsSync(p))
  if (stalePath !== undefined) {
    return {
      name: 'Zed',
      status: 'warn',
      message: `the token-goat shim at ${displaySafeText(shimPath)} points at ${displaySafeText(stalePath)}, which no longer exists; run "token-goat uninstall --zed" and then "token-goat install --zed" again.`,
    }
  }
  return {
    name: 'Zed',
    status: 'ok',
    message: `MCP context server registered in ${displaySafeText(settingsPath)}. Zed runs no token-goat hooks: it gets the MCP tools only, and only once the token-goat server is enabled in Zed's Agent panel.`,
  }
}

export function checkCursor(mcpPath: string, claudeHooksInstalled: boolean): DoctorResult | null {
  const entry = cursorManagedEntry(mcpPath)
  if (entry === null) return null
  return {
    name: 'Cursor',
    status: 'ok',
    message: claudeHooksInstalled
      ? `MCP server registered in ${displaySafeText(mcpPath)}. Cursor also imports the token-goat hooks already installed in ~/.claude/settings.json by default, so hooks work in Cursor too with no separate hooks.json entry.`
      : `MCP server registered in ${displaySafeText(mcpPath)}. Cursor writes and runs no token-goat hooks here: it imports Claude Code hooks from ~/.claude/settings.json by default, but none are installed there yet -- run "token-goat install" to get hooks in Cursor too.`,
  }
}

export function checkStrayClaudeMdBlocks(searchRoot?: string): DoctorResult {
  const strays = findStrayClaudeMdBlocks(searchRoot)
  if (strays.length === 0) {
    return { name: 'CLAUDE.md block', status: 'ok', message: 'no stray copies outside CLAUDE.md' }
  }
  return {
    name: 'CLAUDE.md block',
    status: 'warn',
    message:
      `${strays.length} stray cop${strays.length === 1 ? 'y' : 'ies'} outside CLAUDE.md ` +
      `(never refreshed by install, never removed by uninstall, will go stale): ${strays.join(', ')}`,
  }
}

/** Warn about deprecated or empty `.vscode/mcp.json`. Copilot CLI v1.0.84+ removed incomplete support for `.vscode/mcp.json` and prints a migration banner on every CLI startup if this file exists in the workspace. */
export function checkVscodeProjectMcp(projectRoot: string = process.cwd()): DoctorResult | null {
  const mcpPath = path.join(path.resolve(projectRoot), '.vscode', 'mcp.json')
  if (!fs.existsSync(mcpPath)) return null
  // A file token-goat itself wrote is not residue: `install --vscode -p` puts the managed server here, and checkVisualStudio already reports that same file as healthy. Warning "deprecated" on a healthy install would tell the user to delete a file their own install created.
  if (hasManagedServer(mcpPath, 'VS Code')) return null
  try {
    const content = fs.readFileSync(mcpPath, 'utf8')
    if (isResidueServersJson(content)) {
      return {
        name: 'VS Code project MCP',
        status: 'warn',
        message: `empty residue file at ${displaySafeText(mcpPath)} triggers Copilot CLI deprecation warnings; delete it or run 'token-goat uninstall --vscode'`,
      }
    }
    return {
      name: 'VS Code project MCP',
      status: 'warn',
      message: `${displaySafeText(mcpPath)} is deprecated by Copilot CLI v1.0.84+; migrate configured servers to .mcp.json or .github/mcp.json (https://gh.io/copilotcli-mcpmigrate)`,
    }
  } catch {
    return null
  }
}

