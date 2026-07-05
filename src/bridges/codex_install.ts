/**
 * Codex CLI install / uninstall writer.
 *
 * `token-goat install --codex` patches Codex CLI in addition to the base
 * Claude Code install (see README's "Codex CLI users" section: "The `--codex`
 * flag patches both Claude Code and Codex CLI in one pass"). This module only
 * ever touches paths under `~/.codex/` -- the base Claude Code writer in
 * `../install.ts` is unaffected and is always run separately by the caller.
 *
 * Three artifacts are installed:
 * - `~/.codex/hooks/token-goat-shim.js` -- {@link CODEX_HOOK_SCRIPT} written to
 *   disk. Codex's `command` hook field just invokes `node "<this path>" <event>`;
 *   the shim itself forwards stdin to `token-goat hook <event>` and massages the
 *   JSON response to satisfy Codex's strict (`additionalProperties: false`)
 *   output schemas. Rewritten unconditionally on every install so an upgraded
 *   token-goat version's shim logic always reaches disk, even when the
 *   config.toml hooks block itself needed no changes.
 * - `~/.codex/config.toml` -- a `[[hooks.<Event>]]` / `[[hooks.<Event>.hooks]]`
 *   array-of-tables block (Codex's real hook config shape; verified against
 *   OpenAI's Codex hooks documentation) wiring `PreToolUse`/`PostToolUse` for
 *   the three Codex-specific matchers the README documents: `view_image|Bash`,
 *   `apply_patch`, `web_search`. Parsed/serialized with `smol-toml`, the same
 *   library `config.ts` already uses for token-goat's own config file, so no
 *   TOML is hand-rolled. Any other keys/tables in the file are preserved
 *   verbatim (mirrors `install.ts`'s treatment of unrelated `settings.json`
 *   keys). A timestamped `.bak` is written before any in-place edit.
 * - `~/.codex/AGENTS.md` -- a delimited `<!-- token-goat-codex-begin -->` /
 *   `<!-- token-goat-codex-end -->` block with the same routing guidance as
 *   Claude Code's `CLAUDE.md` block, adapted for Codex's own tool names
 *   (`shell`, `apply_patch`, `view_image`, `web_search` -- see
 *   `CODEX_TOOL_NAME_MAP` in `../hooks_cli.ts`). Content outside the markers is
 *   always preserved.
 *
 * A corrupt-but-recoverable `config.toml` (exists but fails to parse) must
 * never be silently clobbered -- {@link installCodex} throws
 * {@link CodexConfigParseError} before any write in that case, mirroring the
 * `SettingsParseError` strict-mode guard in `../install.ts`.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { parse, stringify } from 'smol-toml'

import { atomicWriteText, ensureDirSync, extractErrorMessage } from '../util.js'
import { anchoredMarkerPattern } from '../install.js'
import { CODEX_HOOK_SCRIPT } from './codex.js'

/** Marker substring identifying a token-goat-authored Codex hook command. */
const CODEX_COMMAND_MARKER = 'token-goat-shim'

/**
 * The three Codex-specific tool-name matchers token-goat wires (README
 * "What gets installed?" -> "With `--codex`"). `view_image|Bash` covers image
 * reads and shell execution together (mirrors Claude Code's combined
 * Read/Grep/Bash pre-read handling); `apply_patch` covers file edits; `web_search`
 * covers Codex's web-fetch equivalent.
 */
const CODEX_MATCHERS = ['view_image|Bash', 'apply_patch', 'web_search'] as const

/** Event keys wired for each matcher: pre- and post- tool-call interception. */
const CODEX_HOOK_EVENTS = ['PreToolUse', 'PostToolUse'] as const
type CodexHookEvent = (typeof CODEX_HOOK_EVENTS)[number]

/** Codex event key -> the internal event arg passed to the shim / `token-goat hook`. */
const CODEX_EVENT_ARG: Record<CodexHookEvent, string> = {
  PreToolUse: 'pre_tool_use',
  PostToolUse: 'post_tool_use',
}

/** One `type = "command"` hook entry as Codex's config.toml stores it. */
interface CodexHookEntry {
  type: string
  command: string
  [key: string]: unknown
}

/** One `[[hooks.<Event>]]` matcher group. */
interface CodexMatcherGroup {
  matcher?: string
  hooks?: CodexHookEntry[]
}

/** The config.toml shape read/written; unknown top-level keys are preserved verbatim. */
interface CodexConfig {
  hooks?: Record<string, CodexMatcherGroup[]>
  [key: string]: unknown
}

/**
 * Thrown by {@link installCodex} when `config.toml` exists but isn't parseable
 * TOML. A caller about to overwrite the file must let this propagate rather
 * than silently proceeding as if the file were empty -- otherwise a single
 * TOML typo in the user's config gets clobbered on write.
 */
export class CodexConfigParseError extends Error {}

/** Absolute path to `~/.codex/config.toml`. */
export function codexConfigPath(): string {
  return path.join(os.homedir(), '.codex', 'config.toml')
}

/** Absolute path to `~/.codex/AGENTS.md`. */
export function codexAgentsPath(): string {
  return path.join(os.homedir(), '.codex', 'AGENTS.md')
}

/** Absolute path the Codex hook shim script is installed to. */
export function codexHookScriptPath(): string {
  return path.join(os.homedir(), '.codex', 'hooks', 'token-goat-shim.js')
}

/**
 * Parse `config.toml` at `p`.
 *
 * A missing file yields `{}` -- the legitimate "nothing installed yet" case.
 * When `opts.strict` is true, a file that *exists* but fails to parse throws
 * {@link CodexConfigParseError} instead of returning `{}`, so a caller about to
 * overwrite the file can tell "genuinely empty" apart from "corrupt, do not
 * touch." Non-strict (read-only) callers keep the lenient `{}` fallback.
 */
function readCodexConfig(p: string, opts: { strict?: boolean } = {}): CodexConfig {
  let raw: string
  try {
    raw = fs.readFileSync(p, 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed = parse(raw)
    return parsed as CodexConfig
  } catch (e) {
    if (opts.strict === true) {
      throw new CodexConfigParseError(
        `Codex config file '${p}' exists but contains invalid TOML. Fix or back up the file before running install. (${extractErrorMessage(e)})`,
      )
    }
    return {}
  }
}

/** True when `command` is a token-goat-authored Codex hook invocation. */
const CODEX_MARKER_PATTERN = anchoredMarkerPattern(CODEX_COMMAND_MARKER)

/** True when `command` invokes token-goat's Codex shim -- anchored so a marker embedded as a substring inside an unrelated command (e.g. a longer path) can't false-positive. */
function isCodexTokenGoatCommand(command: string): boolean {
  return typeof command === 'string' && CODEX_MARKER_PATTERN.test(command)
}

/** True when `groups` already has a token-goat hook entry under the exact `matcher` value. */
function groupHasTokenGoat(groups: CodexMatcherGroup[] | undefined, matcher: string): boolean {
  if (groups === undefined) return false
  for (const group of groups) {
    if (group.matcher !== matcher) continue
    for (const h of group.hooks ?? []) {
      if (isCodexTokenGoatCommand(h.command)) return true
    }
  }
  return false
}

/** Write a timestamped `.bak` copy of `p` if it currently exists. Windows-safe (no `:` in the name). */
function backupFile(p: string): void {
  if (!fs.existsSync(p)) return
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  fs.copyFileSync(p, `${p}.bak.${stamp}`)
}

/** Build the shell command Codex should run for one hook entry. */
function hookCommandFor(scriptPath: string, eventArg: string): string {
  return `node "${scriptPath}" ${eventArg}`
}

/** Outcome of an {@link installCodex} call. */
export interface CodexInstallResult {
  readonly configPath: string
  readonly agentsPath: string
  readonly hookScriptPath: string
  /** True when every artifact was already present and up to date (no write needed). */
  readonly alreadyInstalled: boolean
}

/**
 * Install the Codex CLI integration.
 *
 * Always additive: never touches Claude Code's `~/.claude/settings.json`
 * (the caller is responsible for also running the base install per README's
 * "patches both Claude Code and Codex CLI in one pass"). Idempotent -- a
 * second call reports `alreadyInstalled: true` and does not duplicate any
 * hook entry or AGENTS.md block.
 */
export function installCodex(): CodexInstallResult {
  const configPath = codexConfigPath()
  const agentsPath = codexAgentsPath()
  const scriptPath = codexHookScriptPath()

  // The shim is a generated, never-user-edited file: keep it in sync with the
  // running token-goat version on every install call, independent of whether
  // the config.toml hooks block itself needs any change.
  ensureDirSync(path.dirname(scriptPath))
  atomicWriteText(scriptPath, CODEX_HOOK_SCRIPT)

  // strict: true -- a config.toml that exists but fails to parse must abort
  // before any write (see CodexConfigParseError), not silently proceed as if
  // it were empty and get clobbered below.
  const config = readCodexConfig(configPath, { strict: true })
  const hooks = config.hooks ?? {}

  let hooksChanged = false
  for (const event of CODEX_HOOK_EVENTS) {
    const eventArg = CODEX_EVENT_ARG[event]
    const groups = [...(hooks[event] ?? [])]
    for (const matcher of CODEX_MATCHERS) {
      if (groupHasTokenGoat(groups, matcher)) continue
      groups.push({ matcher, hooks: [{ type: 'command', command: hookCommandFor(scriptPath, eventArg) }] })
      hooksChanged = true
    }
    hooks[event] = groups
  }

  const agentsChanged = writeAgentsBlock(agentsPath)

  if (hooksChanged) {
    config.hooks = hooks
    ensureDirSync(path.dirname(configPath))
    backupFile(configPath)
    atomicWriteText(configPath, stringify(config as Record<string, unknown>))
  }

  return {
    configPath,
    agentsPath,
    hookScriptPath: scriptPath,
    alreadyInstalled: !hooksChanged && !agentsChanged,
  }
}

/**
 * Remove the Codex CLI integration: strips only token-goat's own hook entries
 * from `config.toml` (preserving any other hooks/keys), strips the delimited
 * block from `AGENTS.md` (preserving any other content), and removes the hook
 * shim script. Returns true when at least one of the three was present and
 * removed; false when nothing was installed (no writes occur in that case).
 */
export function uninstallCodex(): boolean {
  const configPath = codexConfigPath()
  const agentsPath = codexAgentsPath()
  const scriptPath = codexHookScriptPath()

  let removedAny = false

  const config = readCodexConfig(configPath)
  const hooks = config.hooks
  if (hooks !== undefined) {
    let hooksRemoved = false
    for (const eventKey of Object.keys(hooks)) {
      const groups = hooks[eventKey]
      if (groups === undefined) continue
      const kept: CodexMatcherGroup[] = []
      for (const group of groups) {
        const keptHooks = (group.hooks ?? []).filter((h) => {
          const isOurs = isCodexTokenGoatCommand(h.command)
          if (isOurs) hooksRemoved = true
          return !isOurs
        })
        if (keptHooks.length > 0) {
          kept.push({ ...group, hooks: keptHooks })
        } else if ((group.hooks ?? []).length === 0) {
          // A group that had no hooks to begin with is user data; preserve it.
          kept.push(group)
        }
      }
      if (kept.length > 0) {
        hooks[eventKey] = kept
      } else {
        delete hooks[eventKey]
      }
    }
    if (hooksRemoved) {
      if (Object.keys(hooks).length === 0) {
        delete config.hooks
      } else {
        config.hooks = hooks
      }
      backupFile(configPath)
      atomicWriteText(configPath, stringify(config as Record<string, unknown>))
      removedAny = true
    }
  }

  if (stripAgentsBlock(agentsPath)) {
    removedAny = true
  }

  try {
    fs.unlinkSync(scriptPath)
    removedAny = true
  } catch {
    // Already absent; nothing to remove.
  }

  return removedAny
}

/**
 * Is the Codex CLI integration currently present?
 *
 * True only when every (event, matcher) pair carries a token-goat hook entry,
 * the shim script exists on disk, and the AGENTS.md delimited block is present.
 * A partial install (e.g. config.toml wired but the shim script deleted by
 * hand) reads as not installed, so {@link installCodex} will top up what's missing.
 */
export function isCodexInstalled(): boolean {
  const config = readCodexConfig(codexConfigPath())
  const hooks = config.hooks
  if (hooks === undefined) return false
  for (const event of CODEX_HOOK_EVENTS) {
    for (const matcher of CODEX_MATCHERS) {
      if (!groupHasTokenGoat(hooks[event], matcher)) return false
    }
  }
  if (!fs.existsSync(codexHookScriptPath())) return false

  let agents: string
  try {
    agents = fs.readFileSync(codexAgentsPath(), 'utf8')
  } catch {
    return false
  }
  return agents.includes(AGENTS_BEGIN) && agents.includes(AGENTS_END)
}

// --- AGENTS.md delimited-block writer ---

const AGENTS_BEGIN = '<!-- token-goat-codex-begin -->'
const AGENTS_END = '<!-- token-goat-codex-end -->'

/** Routing-guidance block, adapted for Codex's own tool names (see `CODEX_TOOL_NAME_MAP` in `../hooks_cli.ts`). */
function buildAgentsBlock(): string {
  return [
    AGENTS_BEGIN,
    '## token-goat',
    '',
    'Prefer token-goat commands over reading whole files:',
    '- `token-goat symbol NAME` -- find a function/class/type',
    '- `token-goat read "file::symbol"` -- one function/method body',
    '- `token-goat section "file::Heading"` -- one doc or config section',
    '- `token-goat semantic "description"` -- find code by meaning',
    '- `token-goat outline file` / `token-goat skeleton file` -- signatures without bodies',
    '',
    'Use this before a full-file read via `shell` (cat/type), before previewing a diff with',
    '`apply_patch`, and before a `view_image` on a large screenshot (token-goat hooks shrink',
    'oversized images automatically). token-goat commands return narrow slices, typically',
    '85-97% smaller than the full file.',
    AGENTS_END,
  ].join('\n')
}

/**
 * Write the delimited block into `p`, preserving everything outside the
 * markers. Returns false (no write) when the file already contains this exact
 * block -- the idempotent re-install case.
 */
function writeAgentsBlock(p: string): boolean {
  const block = buildAgentsBlock()
  let existing: string
  try {
    existing = fs.readFileSync(p, 'utf8')
  } catch {
    existing = ''
  }

  const beginIdx = existing.indexOf(AGENTS_BEGIN)
  const endIdx = existing.indexOf(AGENTS_END)

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = existing.slice(0, beginIdx)
    const after = existing.slice(endIdx + AGENTS_END.length)
    const current = existing.slice(beginIdx, endIdx + AGENTS_END.length)
    if (current === block) return false
    ensureDirSync(path.dirname(p))
    atomicWriteText(p, `${before}${block}${after}`)
    return true
  }

  const trimmed = existing.replace(/\s+$/, '')
  const next = trimmed.length > 0 ? `${trimmed}\n\n${block}\n` : `${block}\n`
  ensureDirSync(path.dirname(p))
  atomicWriteText(p, next)
  return true
}

/** Strip the delimited block from `p`, preserving everything outside the markers. */
function stripAgentsBlock(p: string): boolean {
  let existing: string
  try {
    existing = fs.readFileSync(p, 'utf8')
  } catch {
    return false
  }

  const beginIdx = existing.indexOf(AGENTS_BEGIN)
  const endIdx = existing.indexOf(AGENTS_END)
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) return false

  const before = existing.slice(0, beginIdx).replace(/\s+$/, '')
  const after = existing.slice(endIdx + AGENTS_END.length).replace(/^\s+/, '')

  let next: string
  if (before.length > 0 && after.length > 0) {
    next = `${before}\n\n${after}`
  } else if (before.length > 0) {
    next = `${before}\n`
  } else {
    next = after
  }

  atomicWriteText(p, next)
  return true
}
