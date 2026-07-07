/**
 * Copilot CLI install/uninstall wiring.
 *
 * Copilot's hook config is a standalone JSON file, one file per hook
 * registration (not a shared/merge-heavy config like Codex's config.toml),
 * confirmed against
 * https://docs.github.com/en/copilot/reference/hooks-reference and
 * https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks:
 *
 *   { "version": 1, "hooks": { "<eventName>": [{ "type": "command", "command": "..." }] } }
 *
 * written to `.github/hooks/token-goat.json` (project scope, confirmed) or
 * `~/.copilot/hooks/token-goat.json` (user scope, confirmed). Because the
 * file is entirely token-goat's own (no other tool writes to a file named
 * exactly `token-goat.json` in that directory), this follows pi_install.ts's
 * simpler whole-file overwrite-on-diff pattern rather than Codex's
 * parse/merge/`.bak`-backup pattern -- there is nothing to merge into.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { atomicWriteText, ensureDirSync } from '../util.js'
import { COPILOT_CLI_HOOK_SCRIPT } from './copilot_cli.js'

/** Scope selector shared by every Copilot CLI path helper below, mirroring PiScopeOptions. */
export interface CopilotCliScopeOptions {
  /** When true, target the project-scoped `.github/hooks/` directory instead of the user-scoped `~/.copilot/hooks/` one. */
  local?: boolean
}

/** Copilot's own hook event names that this bridge implements (see copilot_cli.ts's COPILOT_TO_TG_EVENT). */
const COPILOT_CLI_HOOK_EVENTS = ['preToolUse', 'postToolUse', 'preCompact', 'agentStop', 'subagentStop'] as const
type CopilotCliHookEvent = (typeof COPILOT_CLI_HOOK_EVENTS)[number]

interface CopilotHookEntry {
  type: 'command'
  command: string
}

interface CopilotCliConfig {
  version: 1
  hooks: Partial<Record<CopilotCliHookEvent, CopilotHookEntry[]>>
}

export function copilotCliUserHooksDir(): string {
  return path.join(os.homedir(), '.copilot', 'hooks')
}

export function copilotCliProjectHooksDir(): string {
  return path.join(process.cwd(), '.github', 'hooks')
}

function copilotCliHooksDir(opts: CopilotCliScopeOptions = {}): string {
  return opts.local === true ? copilotCliProjectHooksDir() : copilotCliUserHooksDir()
}

export function copilotCliConfigPath(opts: CopilotCliScopeOptions = {}): string {
  return path.join(copilotCliHooksDir(opts), 'token-goat.json')
}

export function copilotCliScriptPath(opts: CopilotCliScopeOptions = {}): string {
  return path.join(copilotCliHooksDir(opts), 'token-goat-shim.js')
}

// Cross-platform 'command' field (vs the also-supported bash/powershell-specific
// fields) -- confirmed as a valid entry shape in the hooks reference doc. The
// event name is passed as an explicit CLI arg (argv[2] on the shim's side),
// exactly like Codex's hookCommandFor(scriptPath, eventArg) -- the same shim
// script is registered under every event key, and nothing in Copilot's
// documented preToolUse/postToolUse input schema (sessionId/timestamp/cwd/
// toolName/toolArgs) identifies which event fired, so the command line is the
// only place this bridge can encode it. Caught by dogfooding a real install +
// invocation before this was tested any other way.
function hookCommandFor(scriptPath: string, event: CopilotCliHookEvent): string {
  return `node "${scriptPath}" ${event}`
}

function buildConfig(scriptPath: string): CopilotCliConfig {
  const hooks: Partial<Record<CopilotCliHookEvent, CopilotHookEntry[]>> = {}
  for (const event of COPILOT_CLI_HOOK_EVENTS) {
    hooks[event] = [{ type: 'command', command: hookCommandFor(scriptPath, event) }]
  }
  return { version: 1, hooks }
}

/** Writes `content` to `p` only if it differs from what's already on disk; returns whether a write happened. */
function writeIfDifferent(p: string, content: string): boolean {
  let existing: string | undefined
  try {
    existing = fs.readFileSync(p, 'utf8')
  } catch {
    existing = undefined
  }
  if (existing === content) return false
  ensureDirSync(path.dirname(p))
  atomicWriteText(p, content)
  return true
}

export interface CopilotCliInstallResult {
  readonly configPath: string
  readonly scriptPath: string
  /** True when both the shim script and the hook config were already up to date (no write needed). */
  readonly alreadyInstalled: boolean
}

export function installCopilotCli(opts: CopilotCliScopeOptions = {}): CopilotCliInstallResult {
  const configPath = copilotCliConfigPath(opts)
  const scriptPath = copilotCliScriptPath(opts)

  // The shim is a generated, never-user-edited file: keep it in sync with the
  // running token-goat version on every install call, independent of whether
  // the hook config itself needs any change (mirrors installCodex()).
  const scriptChanged = writeIfDifferent(scriptPath, COPILOT_CLI_HOOK_SCRIPT)

  const desiredText = JSON.stringify(buildConfig(scriptPath), null, 2) + '\n'
  const configChanged = writeIfDifferent(configPath, desiredText)

  return { configPath, scriptPath, alreadyInstalled: !scriptChanged && !configChanged }
}

export function uninstallCopilotCli(opts: CopilotCliScopeOptions = {}): boolean {
  const configPath = copilotCliConfigPath(opts)
  const scriptPath = copilotCliScriptPath(opts)

  let removedAny = false
  try {
    fs.unlinkSync(configPath)
    removedAny = true
  } catch {
    // Already absent; nothing to remove.
  }
  try {
    fs.unlinkSync(scriptPath)
    removedAny = true
  } catch {
    // Already absent; nothing to remove.
  }
  return removedAny
}

export function isCopilotCliInstalled(opts: CopilotCliScopeOptions = {}): boolean {
  return fs.existsSync(copilotCliConfigPath(opts)) && fs.existsSync(copilotCliScriptPath(opts))
}
