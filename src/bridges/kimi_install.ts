/**
 * Kimi Code CLI (MoonshotAI/kimi-code) install / uninstall writer.
 *
 * `token-goat install --kimi` patches Kimi Code in addition to the base Claude
 * Code install, exactly like `--codex`. This module only ever touches paths
 * under Kimi's own data root, which is `$KIMI_CODE_HOME` when set and
 * `~/.kimi-code` otherwise (`docs/en/configuration/data-locations.md`: "The
 * default data root is `~/.kimi-code/`" and "If you need to move the data
 * directory elsewhere ... set `KIMI_CODE_HOME`").
 *
 * Four artifacts are installed:
 * - `<root>/hooks/token-goat-shim.js` -- {@link KIMI_HOOK_SCRIPT} written to
 *   disk. `<root>/hooks/` is Kimi's own documented location for hook scripts
 *   (`docs/en/customization/hooks.md` wires its worked example as
 *   `node ~/.kimi-code/hooks/block-dangerous-bash.mjs`). The shim is invoked
 *   with the absolute Node binary and a baked token-goat entry path rather
 *   than a bare `node`/`token-goat` on PATH, same rationale as the Codex and
 *   Copilot CLI bridges. Rewritten unconditionally on every install so an
 *   upgraded token-goat's shim logic always reaches disk.
 * - `<root>/config.toml` -- `[[hooks]]` entries, one per wired event. That is
 *   Kimi's real hook config shape: an array of tables whose schema accepts
 *   exactly `event`, `matcher`, `command`, and `timeout` and rejects anything
 *   else (`HookDefSchema` is `.strict()` in
 *   `packages/agent-core-v2/src/agent/externalHooks/configSection.ts`), which
 *   is why nothing else is written into those tables. `matcher` is omitted so
 *   each hook matches every target -- Kimi documents an omitted matcher as
 *   "matches all", and token-goat's own handlers already filter by tool name.
 *   Parsed and serialized with `smol-toml`, the same library `config.ts` uses
 *   for token-goat's own config, so no TOML is hand-rolled. Every other key in
 *   the file is preserved verbatim, and a timestamped `.bak` is written before
 *   any in-place edit.
 * - `<root>/AGENTS.md` -- the shared routing-guidance block between
 *   `<!-- token-goat-kimi-begin -->` / `<!-- token-goat-kimi-end -->` markers.
 *   Kimi reads global instructions from `$KIMI_CODE_HOME/AGENTS.md`
 *   (`docs/en/customization/agents.md`: "Global Kimi-specific instructions can
 *   live at `$KIMI_CODE_HOME/AGENTS.md`"). Content outside the markers is
 *   always preserved.
 * - `<root>/skills/token-goat/SKILL.md` -- the same gate body as Claude Code's
 *   skill, under frontmatter Kimi actually parses. Kimi loads user skills from
 *   `$KIMI_CODE_HOME/skills/` (`docs/en/customization/skills.md`), and a
 *   directory-form `SKILL.md` **must** declare both `name` and `description`
 *   or parsing fails -- so those two fields are written and nothing else.
 *
 * A corrupt-but-recoverable `config.toml` (exists but fails to parse) is never
 * silently clobbered: {@link installKimi} throws {@link KimiConfigParseError}
 * before any write, mirroring `codex_install.ts`'s strict-mode guard.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { parse, stringify } from 'smol-toml'

import { atomicWriteText, backupFile, ensureDirSync, extractErrorMessage, hookCommandFor, stripDelimitedBlock, upsertDelimitedBlock } from '../util.js'
import { anchoredMarkerPattern } from '../install.js'
import { KIMI_HOOK_SCRIPT } from './kimi.js'
import { buildGuidanceBlock, buildGuidanceBody } from './guidance_block.js'
import { loadConfig } from '../config.js'

/**
 * Kimi Code event names token-goat wires, mapped to the internal event arg.
 *
 * Every name here is a member of `HOOK_EVENT_TYPES` in
 * `packages/agent-core-v2/src/agent/externalHooks/types.ts`. The remaining
 * real Kimi events (`Notification`, `Stop`, `StopFailure`, `Interrupt`,
 * `PostToolUseFailure`, `PermissionRequest`, `PermissionResult`,
 * `UserPromptQueued`, `TurnStarted`, `TaskStarted`, `SubagentStart`,
 * `SessionEnd`, `SessionHeartbeat`, `PostCompact`) are left unwired: none of
 * them has a token-goat server-side handler to dispatch to, so wiring them
 * would spawn a process per event to do nothing.
 */
const KIMI_EVENT_ARG: Readonly<Record<string, string>> = {
  PreToolUse: 'pre_tool_use',
  PostToolUse: 'post_tool_use',
  PreCompact: 'pre_compact',
  UserPromptSubmit: 'user_prompt_submit',
  SubagentStop: 'subagent_stop',
  SessionStart: 'session_start',
}

/** Wired Kimi event names, in the order they are written to `config.toml`. */
export const KIMI_HOOK_EVENTS: readonly string[] = Object.keys(KIMI_EVENT_ARG)

/**
 * One `[[hooks]]` entry as Kimi's `config.toml` stores it. Only the four
 * fields `HookDefSchema` accepts appear here; the schema is `.strict()`, so an
 * extra key makes the whole config file fail to load.
 */
interface KimiHookEntry {
  event: string
  matcher?: string
  command: string
  timeout?: number
}

/** The `config.toml` shape read/written; unknown top-level keys are preserved verbatim. */
interface KimiConfig {
  hooks?: KimiHookEntry[]
  [key: string]: unknown
}

/** Thrown by {@link installKimi} when `config.toml` exists but isn't parseable as TOML. */
export class KimiConfigParseError extends Error {}

/**
 * Kimi's data root: `$KIMI_CODE_HOME` when set and non-blank, else
 * `~/.kimi-code`. Resolved on every call rather than cached so tests (and a
 * user switching roots between commands) see the current value.
 */
export function kimiHome(): string {
  const override = process.env['KIMI_CODE_HOME']
  if (override !== undefined && override.trim() !== '') return path.resolve(override)
  return path.join(os.homedir(), '.kimi-code')
}

/** Absolute path to Kimi's `config.toml`. */
export function kimiConfigPath(): string {
  return path.join(kimiHome(), 'config.toml')
}

/** Absolute path to Kimi's global `AGENTS.md`. */
export function kimiAgentsPath(): string {
  return path.join(kimiHome(), 'AGENTS.md')
}

/** Absolute path the Kimi hook shim script is installed to. */
export function kimiHookScriptPath(): string {
  return path.join(kimiHome(), 'hooks', 'token-goat-shim.js')
}

/** Absolute path to the token-goat skill directory Kimi loads. */
export function kimiSkillDir(): string {
  return path.join(kimiHome(), 'skills', 'token-goat')
}

/** Absolute path to `<root>/skills/token-goat/SKILL.md`. */
export function kimiSkillPath(): string {
  return path.join(kimiSkillDir(), 'SKILL.md')
}

function readKimiConfig(p: string, opts: { strict?: boolean } = {}): KimiConfig {
  let raw: string
  try {
    raw = fs.readFileSync(p, 'utf8')
  } catch {
    return {}
  }
  try {
    return parse(raw) as KimiConfig
  } catch (e) {
    if (opts.strict === true) {
      throw new KimiConfigParseError(
        `Kimi Code config file '${p}' exists but contains invalid TOML. Fix or back up the file before running install. (${extractErrorMessage(e)})`,
      )
    }
    return {}
  }
}

/** Marker substring identifying a token-goat-authored Kimi hook command. */
const KIMI_COMMAND_MARKER = 'token-goat'
const KIMI_MARKER_PATTERN = anchoredMarkerPattern(KIMI_COMMAND_MARKER)

/** True when `command` is a token-goat-authored Kimi hook invocation, anchored so an unrelated command that merely contains the word cannot false-positive. */
function isKimiTokenGoatCommand(command: unknown): boolean {
  return typeof command === 'string' && KIMI_MARKER_PATTERN.test(command)
}

const AGENTS_BEGIN = '<!-- token-goat-kimi-begin -->'
const AGENTS_END = '<!-- token-goat-kimi-end -->'

/** Routing-guidance block, adapted for Kimi Code's own tool names (see `docs/en/reference/tools.md` in MoonshotAI/kimi-code). */
function buildKimiAgentsBlock(): string {
  return buildGuidanceBlock({
    beginMarker: AGENTS_BEGIN,
    endMarker: AGENTS_END,
    fallbackToolClause:
      "Kimi Code's native `Read`, `Grep`, `Glob`, and `ReadMediaFile` tools (shell commands like `cat`/`type` run inside `Bash`)",
    gdrive: loadConfig().gdrive.enabled,
  })
}

function writeKimiAgentsBlock(p: string): boolean {
  return upsertDelimitedBlock(p, AGENTS_BEGIN, AGENTS_END, buildKimiAgentsBlock())
}

function stripKimiAgentsBlock(p: string): boolean {
  return stripDelimitedBlock(p, AGENTS_BEGIN, AGENTS_END)
}

/**
 * The SKILL.md Kimi loads. Only `name` and `description` are declared: those
 * two are required for a directory-form skill, and every other frontmatter
 * field Kimi documents (`type`, `whenToUse`, `disableModelInvocation`,
 * `arguments`) would change invocation semantics token-goat does not want.
 * Notably there is no `allowed-tools` key in Kimi's schema, so none is written.
 */
function kimiSkillContent(): string {
  const gdrive = loadConfig().gdrive.enabled
  const frontmatter = [
    '---',
    'name: token-goat',
    `description: Use before reading whole files or grepping wide. token-goat commands (symbol, read, section, semantic, outline, skeleton, map, refs, changed, config-get, bash-output, web-output${gdrive ? ', gdrive-sections' : ''}) return narrow slices of code and docs at a fraction of the token cost.`,
    '---',
  ].join('\n')
  const body = buildGuidanceBody("Kimi Code's own Read, Grep, and Glob preference rules", { gdrive })
  return `${frontmatter}\n\n${body}\n`
}

function writeKimiSkill(): boolean {
  const p = kimiSkillPath()
  const content = kimiSkillContent()
  let existing: string | null = null
  try {
    existing = fs.readFileSync(p, 'utf8')
  } catch {
    // Absent; falls through to the write below.
  }
  if (existing === content) return false
  ensureDirSync(kimiSkillDir())
  atomicWriteText(p, content)
  return true
}

/** Outcome of an {@link installKimi} call. */
export interface KimiInstallResult {
  readonly configPath: string
  readonly agentsPath: string
  readonly hookScriptPath: string
  readonly skillPath: string
  /** True when every artifact was already present and up to date (no write needed). */
  readonly alreadyInstalled: boolean
}

/** Install the Kimi Code CLI integration. */
export function installKimi(): KimiInstallResult {
  const configPath = kimiConfigPath()
  const agentsPath = kimiAgentsPath()
  const scriptPath = kimiHookScriptPath()

  ensureDirSync(path.dirname(scriptPath))
  atomicWriteText(scriptPath, KIMI_HOOK_SCRIPT)

  // strict: true -- a config.toml that exists but fails to parse must abort before any write, not silently proceed as if it were empty and get clobbered below.
  const config = readKimiConfig(configPath, { strict: true })
  const existing = Array.isArray(config.hooks) ? config.hooks : []

  const desired: KimiHookEntry[] = KIMI_HOOK_EVENTS.map((event) => ({
    event,
    command: hookCommandFor(scriptPath, KIMI_EVENT_ARG[event] ?? ''),
  }))

  // Everything token-goat did not write is preserved as-is; our own entries are
  // rebuilt from scratch so a re-install upgrades a stale baked path in place
  // instead of leaving a dead duplicate next to the current one.
  const foreign = existing.filter((h) => !isKimiTokenGoatCommand(h?.command))
  const ours = existing.filter((h) => isKimiTokenGoatCommand(h?.command))
  const hooksChanged = JSON.stringify(ours) !== JSON.stringify(desired)

  const agentsChanged = writeKimiAgentsBlock(agentsPath)
  const skillChanged = writeKimiSkill()

  if (hooksChanged) {
    config.hooks = [...foreign, ...desired]
    ensureDirSync(path.dirname(configPath))
    backupFile(configPath)
    atomicWriteText(configPath, stringify(config as Record<string, unknown>))
  }

  return {
    configPath,
    agentsPath,
    hookScriptPath: scriptPath,
    skillPath: kimiSkillPath(),
    alreadyInstalled: !hooksChanged && !agentsChanged && !skillChanged,
  }
}

/**
 * Remove the Kimi Code integration: strips only token-goat's own `[[hooks]]`
 * entries, the delimited AGENTS.md block, the skill directory, and the shim
 * script. Returns true when anything was actually removed.
 */
export function uninstallKimi(): boolean {
  const configPath = kimiConfigPath()
  const config = readKimiConfig(configPath)
  let removed = false

  if (Array.isArray(config.hooks)) {
    const kept = config.hooks.filter((h) => !isKimiTokenGoatCommand(h?.command))
    if (kept.length !== config.hooks.length) {
      if (kept.length === 0) {
        delete config.hooks
      } else {
        config.hooks = kept
      }
      backupFile(configPath)
      atomicWriteText(configPath, stringify(config as Record<string, unknown>))
      removed = true
    }
  }

  if (stripKimiAgentsBlock(kimiAgentsPath())) removed = true

  try {
    if (fs.existsSync(kimiSkillDir())) {
      fs.rmSync(kimiSkillDir(), { recursive: true, force: true })
      removed = true
    }
  } catch {
    // best-effort: a locked skill directory must not fail the whole uninstall
  }

  try {
    if (fs.existsSync(kimiHookScriptPath())) {
      fs.rmSync(kimiHookScriptPath(), { force: true })
      removed = true
    }
  } catch {
    // best-effort, same rationale as the skill directory above
  }

  return removed
}

/** Is the Kimi Code integration currently present and up to date? */
export function isKimiInstalled(): boolean {
  const config = readKimiConfig(kimiConfigPath())
  if (!Array.isArray(config.hooks)) return false
  const scriptPath = kimiHookScriptPath()
  for (const event of KIMI_HOOK_EVENTS) {
    const expected = hookCommandFor(scriptPath, KIMI_EVENT_ARG[event] ?? '')
    if (!config.hooks.some((h) => h?.event === event && h?.command === expected)) return false
  }
  return true
}
