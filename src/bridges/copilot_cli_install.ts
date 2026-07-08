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
 * parse/merge pattern -- there is nothing to merge into. It does, however,
 * still `.bak` the config before overwriting it (like Codex/Gemini/OpenClaw),
 * because Copilot's hooks schema supports per-entry fields token-goat writes
 * only some of (`timeoutSec` -- see HOOK_TIMEOUT_SEC below) and never touches
 * others of (`cwd`, `env`, `matcher`, `allowedEnvVars` --
 * https://docs.github.com/en/copilot/reference/hooks-reference) that a user
 * could plausibly hand-tune; since install always regenerates the whole file
 * from scratch, a hand-edit would otherwise be silently destroyed with no
 * recovery path.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { atomicWriteText, backupFile, ensureDirSync } from '../util.js'
import { COPILOT_CLI_HOOK_SCRIPT } from './copilot_cli.js'

/** Scope selector shared by every Copilot CLI path helper below, mirroring PiScopeOptions. */
export interface CopilotCliScopeOptions {
  /** When true, target the project-scoped `.github/hooks/` directory instead of the user-scoped `~/.copilot/hooks/` one. */
  local?: boolean
}

/** Copilot's own hook event names that this bridge implements (see copilot_cli.ts's COPILOT_TO_TG_EVENT). */
const COPILOT_CLI_HOOK_EVENTS = [
  'preToolUse',
  'postToolUse',
  'preCompact',
  'agentStop',
  'subagentStop',
  'userPromptSubmitted',
] as const
type CopilotCliHookEvent = (typeof COPILOT_CLI_HOOK_EVENTS)[number]

interface CopilotHookEntry {
  type: 'command'
  command: string
  timeoutSec: number
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
//
// The interpreter is invoked via the absolute path to the Node binary that
// ran this installer (`process.execPath`, baked in at install time), not a
// bare `node` relying on PATH resolution -- confirmed live-production root
// cause of every tool call being denied with "(hook errored)" on Copilot CLI
// 1.0.68 (github/copilot-cli#4001): Copilot's `command`-type hooks fail
// closed, so if the environment it spawns them in doesn't resolve `node` on
// PATH, the hook process never launches, Copilot sees a failed process, and
// denies unconditionally. Quoted the same way as scriptPath below since the
// Node install path can also contain spaces (e.g. `C:\Program Files\nodejs\node.exe`).
function hookCommandFor(scriptPath: string, event: CopilotCliHookEvent): string {
  // process.argv[1] is the absolute path to whichever token-goat entry point launched this
  // install run (dist/token-goat.mjs when installed via npm, the dev entry under tsx
  // otherwise). Baked in here as a third CLI arg so the shim's own inner `token-goat hook
  // <event>` call (copilot_cli.ts) can invoke it directly via process.execPath instead of
  // depending on PATH/cmd.exe resolution -- same rationale, and same #4001 fail-closed
  // deny-all class, as process.execPath two lines up. Omitted when unavailable (should never
  // happen under a real `node <script>` invocation) rather than baking in something wrong;
  // the shim's inner call falls back to its old PATH-based lookup in that case.
  const entryPath = process.argv[1]
  const entryArg = entryPath ? ` "${entryPath}"` : ''
  return `"${process.execPath}" "${scriptPath}" ${event}${entryArg}`
}

// Copilot's own default (per its hooks reference doc) is 30s, and a killed-on-timeout
// preToolUse hook fails *open* (proceeds to normal permission flow), not closed -- so
// this is not itself a fix for the "(hook errored)" deny-all class (that's exclusively
// hookCommandFor's PATH hardening above). It exists for a narrower reason: a cold first
// invocation (bundle load + DB open, or a symlinked dev-clone mid `npm install`/`npm run
// build`) can plausibly exceed a 30s default, and every non-preToolUse event here (unlike
// preToolUse) has no documented fail-open timeout carve-out -- so a slow cold start on
// those still risks a "Killed after timeoutSec" error being logged for no real reason.
// Double Copilot's own default as cheap, harmless headroom.
const HOOK_TIMEOUT_SEC = 60

function buildConfig(scriptPath: string): CopilotCliConfig {
  const hooks: Partial<Record<CopilotCliHookEvent, CopilotHookEntry[]>> = {}
  for (const event of COPILOT_CLI_HOOK_EVENTS) {
    hooks[event] = [{ type: 'command', command: hookCommandFor(scriptPath, event), timeoutSec: HOOK_TIMEOUT_SEC }]
  }
  return { version: 1, hooks }
}

/** Writes `content` to `p` only if it differs from what's already on disk; returns whether a write happened. */
function writeIfDifferent(p: string, content: string, backup = false): boolean {
  let existing: string | undefined
  try {
    existing = fs.readFileSync(p, 'utf8')
  } catch {
    existing = undefined
  }
  if (existing === content) return false
  if (backup) backupFile(p)
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
  const configChanged = writeIfDifferent(configPath, desiredText, true)

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
