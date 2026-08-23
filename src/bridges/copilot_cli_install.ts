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

import { hookCommandFor, stripDelimitedBlock, upsertDelimitedBlock, writeIfDifferent } from '../util.js'
import { COPILOT_CLI_HOOK_SCRIPT } from './copilot_cli.js'
import { buildGuidanceBlock } from './guidance_block.js'
import { loadConfig } from '../config.js'

/** Scope selector shared by every Copilot CLI path helper below, mirroring PiScopeOptions. */
export interface CopilotCliScopeOptions {
  /** When true, target the project-scoped `.github/hooks/` directory instead of the user-scoped `~/.copilot/hooks/` one. */
  local?: boolean
}

/** Copilot's own hook event names that this bridge implements (see copilot_cli.ts's COPILOT_TO_TG_EVENT). */
const COPILOT_CLI_HOOK_EVENTS = [
  'sessionStart',
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
  bash: string
  powershell: string
  timeoutSec: number
}

interface CopilotCliConfig {
  version: 1
  hooks: Partial<Record<CopilotCliHookEvent, CopilotHookEntry[]>>
}

/**
 * The user-scope Copilot directory. Copilot CLI documents `COPILOT_HOME` as replacing
 * `~/.copilot` wholesale for both hooks and instructions ("If `COPILOT_HOME` is set,
 * create the file in `$COPILOT_HOME/hooks/`" --
 * https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks).
 * Ignoring it is a silent total failure rather than a degraded one: install reports
 * success, writes a valid config to `~/.copilot`, and Copilot never reads that path, so
 * every hook simply never fires and nothing surfaces the mismatch. Blank/whitespace is
 * treated as unset, matching how an exported-but-empty variable behaves everywhere else.
 */
export function copilotCliUserRoot(): string {
  const override = process.env['COPILOT_HOME']
  if (override !== undefined && override.trim() !== '') return path.resolve(override)
  return path.join(os.homedir(), '.copilot')
}

export function copilotCliUserHooksDir(): string {
  return path.join(copilotCliUserRoot(), 'hooks')
}

export function copilotCliProjectHooksDir(): string {
  return path.join(process.cwd(), '.github', 'hooks')
}

/**
 * Copilot's *cache* root, which is a different directory from its user root.
 *
 * copilotCliUserRoot() above resolves COPILOT_HOME / ~/.copilot, where config
 * and session state live. The MCP tool-definition cache is not there: it sits
 * under a separate cache root, and conflating the two would silently read an
 * empty directory and report that no MCP servers are configured.
 *
 * The rule below was read directly out of the shipped Copilot 1.0.80 bundle
 * rather than taken from documentation. The native entry point is
 * `copilotCacheHome(platform, homedir, COPILOT_CACHE_HOME, LOCALAPPDATA,
 * XDG_CACHE_HOME)`, and the bundle also carries a plain-JS twin of the same
 * rule which is what this mirrors. Two details are easy to get wrong and are
 * both taken from that twin: COPILOT_CACHE_HOME is the cache root *itself*
 * and gets no `copilot` segment appended (the bundle joins it straight to
 * `pkg`), whereas every platform default does append one. On win32 the
 * fallback when LOCALAPPDATA is unset is ~/.cache, not ~/Library or an XDG
 * path.
 */
export function copilotCliCacheRoot(): string {
  const override = process.env['COPILOT_CACHE_HOME']
  if (override !== undefined && override.trim() !== '') return path.resolve(override)
  const home = os.homedir()
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches', 'copilot')
  if (process.platform === 'win32') {
    const local = process.env['LOCALAPPDATA']
    const base = local !== undefined && local.trim() !== '' ? local : path.join(home, '.cache')
    return path.join(base, 'copilot')
  }
  const xdg = process.env['XDG_CACHE_HOME']
  const base = xdg !== undefined && xdg.trim() !== '' ? xdg : path.join(home, '.cache')
  return path.join(base, 'copilot')
}

/** Directory holding Copilot's per-server MCP tool-definition cache files. */
export function copilotCliMcpToolsDir(): string {
  return path.join(copilotCliCacheRoot(), 'mcp-tools')
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

// Copilot CLI reads custom instructions from `~/.copilot/copilot-instructions.md`
// (user scope) and `<repo>/.github/copilot-instructions.md` (project scope) --
// the same repository-custom-instructions filename GitHub Copilot uses across
// its surfaces. The instructions file therefore lives one directory up from the
// scope's hooks dir: `~/.copilot/hooks` -> `~/.copilot/copilot-instructions.md`,
// and `<cwd>/.github/hooks` -> `<cwd>/.github/copilot-instructions.md`, so the
// existing `local` scope selector applies to it unchanged.
export function copilotCliInstructionsPath(opts: CopilotCliScopeOptions = {}): string {
  return path.join(path.dirname(copilotCliHooksDir(opts)), 'copilot-instructions.md')
}

// Same generic markers the base Claude Code install writes into ~/.claude/CLAUDE.md,
// deliberately NOT a Copilot-specific pair: a real user's hand-written
// copilot-instructions.md already carries a token-goat block delimited by exactly
// these markers (copied from the CLAUDE.md convention), and the installer must
// upgrade that block in place, not append a second one beside it. The file is a
// separate path from CLAUDE.md, so there is no marker collision.
const COPILOT_INSTRUCTIONS_BEGIN = '<!-- token-goat-begin -->'
const COPILOT_INSTRUCTIONS_END = '<!-- token-goat-end -->'

/** The token-goat routing block for Copilot CLI, naming Copilot's own read tools in the conflict clause. */
function buildCopilotInstructionsBlock(): string {
  // Copilot's fallback parser can infer tool names from backtick-quoted prose when no
  // `allowed-tools` frontmatter exists, so keep this surface free of inline code spans.
  return stripInlineCodeSpans(
    buildGuidanceBlock({
      beginMarker: COPILOT_INSTRUCTIONS_BEGIN,
      endMarker: COPILOT_INSTRUCTIONS_END,
      fallbackToolClause:
        "Copilot CLI's native `view`, `grep`, and `glob` tools (with PowerShell commands `Get-Content`/`Select-String` as search fallbacks)",
      gdrive: loadConfig().gdrive.enabled,
    }),
  )
}

function stripInlineCodeSpans(text: string): string {
  return text.replace(/`([^`]+)`/g, '$1')
}

/**
 * Idempotent merge-or-append of the token-goat block into the Copilot
 * instructions file, preserving every byte outside the markers (the file is
 * user-owned and hand-edited). Mirrors codex_install.ts's writeAgentsBlock.
 */
function writeCopilotInstructionsBlock(p: string): boolean {
  return upsertDelimitedBlock(p, COPILOT_INSTRUCTIONS_BEGIN, COPILOT_INSTRUCTIONS_END, buildCopilotInstructionsBlock())
}

function stripCopilotInstructionsBlock(p: string): boolean {
  return stripDelimitedBlock(p, COPILOT_INSTRUCTIONS_BEGIN, COPILOT_INSTRUCTIONS_END)
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
// hookCommandFor is shared with codex_install.ts -- see util.ts.

// The hooks reference doc (https://docs.github.com/en/copilot/reference/hooks-reference)
// confirms 'command' is only a cross-platform *fallback*: it's copied verbatim to 'bash' and
// 'powershell' when those fields are absent, and Copilot CLI runs 'powershell' by feeding the
// string directly to PowerShell as a script -- not via cmd.exe. hookCommandFor()'s output
// (a bare quoted-exe-then-quoted-args string, e.g. `"C:\...\node.exe" "...\shim.js" preToolUse
// ...`) is valid cmd.exe command-line syntax but is NOT valid PowerShell: two adjacent quoted
// string literals with no call operator is a parse error in PowerShell ("Unexpected token
// '"...\token-goat-shim.js"' in expression or statement"), confirmed live via Copilot CLI's own
// logged ParserError. Relying on 'command' alone meant every Windows install was silently
// broken -- the hook process never even started, Copilot's preToolUse fails *closed*, and every
// tool call got denied with "(hook errored)" regardless of PATH/absolute-path correctness (a
// distinct bug from the PATH-resolution class github/copilot-cli#4001 already fixed). Emitting
// an explicit 'powershell' entry prefixed with '&' (PowerShell's call operator, required to
// invoke a quoted path as a command rather than evaluate it as a string expression) fixes this;
// 'bash' gets the same command text since POSIX shells don't need a call operator for a quoted
// path. 'command' is kept for older Copilot CLI builds that might not read 'bash'/'powershell'.
function hookPowershellCommandFor(scriptPath: string, event: CopilotCliHookEvent): string {
  return `& ${hookCommandFor(scriptPath, event)}`
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
    hooks[event] = [
      {
        type: 'command',
        command: hookCommandFor(scriptPath, event),
        bash: hookCommandFor(scriptPath, event),
        powershell: hookPowershellCommandFor(scriptPath, event),
        timeoutSec: HOOK_TIMEOUT_SEC,
      },
    ]
  }
  return { version: 1, hooks }
}

export interface CopilotCliInstallResult {
  readonly configPath: string
  readonly scriptPath: string
  /** Path to the copilot-instructions.md that received the token-goat routing block. */
  readonly instructionsPath: string
  /** True when the shim script, the hook config, and the instructions block were all already up to date (no write needed). */
  readonly alreadyInstalled: boolean
}

export function installCopilotCli(opts: CopilotCliScopeOptions = {}): CopilotCliInstallResult {
  const configPath = copilotCliConfigPath(opts)
  const scriptPath = copilotCliScriptPath(opts)
  const instructionsPath = copilotCliInstructionsPath(opts)

  // The shim is a generated, never-user-edited file: keep it in sync with the
  // running token-goat version on every install call, independent of whether
  // the hook config itself needs any change (mirrors installCodex()).
  const scriptChanged = writeIfDifferent(scriptPath, COPILOT_CLI_HOOK_SCRIPT)

  const desiredText = JSON.stringify(buildConfig(scriptPath), null, 2) + '\n'
  const configChanged = writeIfDifferent(configPath, desiredText, true)

  const instructionsChanged = writeCopilotInstructionsBlock(instructionsPath)

  return {
    configPath,
    scriptPath,
    instructionsPath,
    alreadyInstalled: !scriptChanged && !configChanged && !instructionsChanged,
  }
}

function uninstallCopilotCliScope(opts: CopilotCliScopeOptions): boolean {
  const configPath = copilotCliConfigPath(opts)
  const scriptPath = copilotCliScriptPath(opts)
  const instructionsPath = copilotCliInstructionsPath(opts)

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
  // The instructions file is user-owned: strip only the delimited block and
  // preserve everything else, never unlink the whole file (mirrors codex uninstall).
  if (stripCopilotInstructionsBlock(instructionsPath)) {
    removedAny = true
  }
  return removedAny
}

// Uninstall is a cleanup operation, not a mirror of install's scope targeting: a plain
// `token-goat uninstall --copilot` (opts.local left unset) must remove the hook config
// wherever it actually is, not just the user scope, or a --local (project-scoped)
// install silently survives. Only when the caller explicitly asks for the local scope
// (opts.local === true) do we narrow to that one scope and leave a coexisting
// user-scoped install untouched (mirrors uninstallPi in ./pi_install.js).
export function uninstallCopilotCli(opts: CopilotCliScopeOptions = {}): boolean {
  if (opts.local === true) {
    return uninstallCopilotCliScope({ local: true })
  }
  const userRemoved = uninstallCopilotCliScope({ local: false })
  const localRemoved = uninstallCopilotCliScope({ local: true })
  return userRemoved || localRemoved
}

export function isCopilotCliInstalled(opts: CopilotCliScopeOptions = {}): boolean {
  if (!fs.existsSync(copilotCliConfigPath(opts)) || !fs.existsSync(copilotCliScriptPath(opts))) {
    return false
  }
  let instructions: string
  try {
    instructions = fs.readFileSync(copilotCliInstructionsPath(opts), 'utf8')
  } catch {
    return false
  }
  return instructions.includes(COPILOT_INSTRUCTIONS_BEGIN) && instructions.includes(COPILOT_INSTRUCTIONS_END)
}
