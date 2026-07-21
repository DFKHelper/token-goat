/**
 * Qwen Code (QwenLM/qwen-code, a Gemini CLI fork) hook integration.
 *
 * Unlike Gemini CLI's own custom event/matcher scheme (BeforeTool/AfterTool/
 * PreCompress, per-tool matcher groups -- see gemini_install.ts), Qwen Code's
 * hooks wire format diverged from its Gemini CLI ancestor and now mirrors
 * Claude Code's own natively: event names (PreToolUse/PostToolUse/PreCompact/
 * UserPromptSubmit/SubagentStop), the settings.json `hooks: { <Event>: [{
 * matcher, hooks: [{ type: 'command', command }] }] }` nesting, and snake_case
 * stdin JSON fields -- confirmed against QwenLM/qwen-code's published docs
 * (docs/users/features/hooks.md, docs/users/configuration/settings.md), not
 * live-tested against a running Qwen Code install. Qwen Code's own tool-name
 * taxonomy (`write_file`/`read_file`/`run_shell_command` runtime ids, with
 * `WriteFile`/`ReadFile`-style display names accepted as matcher aliases) is
 * only partially documented, so this integration deliberately uses an empty
 * (catch-all) matcher per event -- exactly the same approach install.ts uses
 * for Claude Code itself -- rather than risk an incomplete per-tool matcher
 * list silently missing tool names Qwen Code has not documented.
 *
 * The generated hook command appends `--harness qwen` (see qwenHookCommand below): unlike
 * pi.ts/copilot_cli.ts (full JS relay scripts that set process.env.TOKEN_GOAT_HARNESS_OVERRIDE
 * directly), this bridge writes a bare command string into settings.json with no ambient env
 * var to identify it, so detectHarness() (src/bridges/registry.ts) needs the override passed
 * as a CLI flag on the `hook` subcommand instead.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { anchoredMarkerPattern } from '../install.js'
import { stripOwnHooksFromMap, stripStaleGroupHooks, writeJsonSettings } from '../util.js'

// Qwen Code -> token-goat internal HookEventName (src/types.ts's HOOK_EVENTS).
// Only these five have a token-goat handler; every other real Qwen Code
// event (Notification, SessionEnd, PostToolUseFailure, StopFailure,
// SubagentStart, PermissionRequest, TodoCreated, TodoCompleted) is left
// unimplemented rather than guessed at, since token-goat's own docs source
// (QwenLM/qwen-code's hooks.md) was not live-tested against a running
// install to confirm each event's payload shape.
const QWEN_HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'PreCompact', 'UserPromptSubmit', 'SubagentStop'] as const
type QwenHookEvent = (typeof QWEN_HOOK_EVENTS)[number]

const QWEN_EVENT_ARG: Record<QwenHookEvent, string> = {
  PreToolUse: 'pre_tool_use',
  PostToolUse: 'post_tool_use',
  PreCompact: 'pre_compact',
  UserPromptSubmit: 'user_prompt_submit',
  SubagentStop: 'subagent_stop',
}

interface QwenHookEntry {
  type: string
  command: string
  [key: string]: unknown
}

interface QwenMatcherGroup {
  matcher?: string
  hooks?: QwenHookEntry[]
}

interface QwenSettings {
  hooks?: Record<string, QwenMatcherGroup[]>
  [key: string]: unknown
}

export class QwenSettingsParseError extends Error {}

export function qwenSettingsPath(): string {
  return path.join(os.homedir(), '.qwen', 'settings.json')
}

function readQwenSettings(p: string, opts: { strict?: boolean } = {}): QwenSettings {
  let raw: string
  try {
    raw = fs.readFileSync(p, 'utf8')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    if (opts.strict === true) {
      throw new QwenSettingsParseError(
        `Qwen Code settings file '${p}' exists but contains invalid JSON. Fix or back up the file before running install.`,
      )
    }
    return {}
  }
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    return parsed as QwenSettings
  }
  if (opts.strict === true) {
    throw new QwenSettingsParseError(`Qwen Code settings file '${p}' does not contain a JSON object at the top level. Fix or back up the file before running install.`)
  }
  return {}
}

const QWEN_LEGACY_COMMAND_MARKER = 'token-goat hook'
const QWEN_LEGACY_MARKER_PATTERN = anchoredMarkerPattern(QWEN_LEGACY_COMMAND_MARKER)
const QWEN_COMMAND_PATTERN =
  /^"[^"]+"\s+"([^"]+)"\s+hook\s+(?:pre_tool_use|post_tool_use|pre_compact|user_prompt_submit|subagent_stop)(?:\s+--harness\s+qwen)?$/
const QWEN_ENTRY_PATH_MARKER_PATTERN = anchoredMarkerPattern('token-goat')

function isQwenTokenGoatCommand(command: string): boolean {
  if (typeof command !== 'string') return false
  const match = QWEN_COMMAND_PATTERN.exec(command)
  if (match) {
    const entryPath = match[1] ?? ''
    return QWEN_ENTRY_PATH_MARKER_PATTERN.test(entryPath)
  }
  return QWEN_LEGACY_MARKER_PATTERN.test(command)
}

function isCurrentQwenTokenGoatCommand(command: string, desiredCommand: string): boolean {
  if (typeof command !== 'string') return false
  return command === desiredCommand
}

function groupHasTokenGoat(groups: QwenMatcherGroup[] | undefined, predicate: (command: string) => boolean = isQwenTokenGoatCommand): boolean {
  if (groups === undefined) return false
  for (const group of groups) {
    for (const h of group.hooks ?? []) {
      if (predicate(h.command)) return true
    }
  }
  return false
}

/**
 * Bakes the absolute node/entry-script path, same robustness rationale as gemini_install.ts's
 * geminiHookCommand: no assumption that `token-goat` resolves on Qwen Code's subprocess PATH.
 *
 * The trailing `--harness qwen` flag exists because detectHarness() (src/bridges/registry.ts)
 * has no ambient env var that identifies a real Qwen Code subprocess -- unlike pi.ts and
 * copilot_cli.ts, which are full JS relay scripts loaded in-process by their host tool and can
 * set process.env.TOKEN_GOAT_HARNESS_OVERRIDE directly before invoking token-goat's hook logic,
 * this bridge only writes a bare command string into Qwen Code's settings.json, so there is no
 * JS relay in the middle to set an env var -- the override has to travel as a CLI flag instead.
 */
function qwenHookCommand(eventArg: string): string {
  const entryPath = process.argv[1]
  if (!entryPath) return `token-goat hook ${eventArg} --harness qwen`
  return `"${process.execPath}" "${entryPath}" hook ${eventArg} --harness qwen`
}

interface QwenInstallResult {
  readonly settingsPath: string
  /** True when every hook entry was already present (no write needed). */
  readonly alreadyInstalled: boolean
}

export function installQwen(): QwenInstallResult {
  const p = qwenSettingsPath()
  // strict: true -- a settings.json that exists but fails to parse must abort before any write, not silently proceed as if it were empty and get clobbered below.
  const settings = readQwenSettings(p, { strict: true })
  const hooks = settings.hooks ?? {}

  let changed = false
  for (const event of QWEN_HOOK_EVENTS) {
    const command = qwenHookCommand(QWEN_EVENT_ARG[event])
    const existingGroups = hooks[event] ?? []

    if (groupHasTokenGoat(existingGroups, (c) => isCurrentQwenTokenGoatCommand(c, command))) {
      hooks[event] = existingGroups
      continue
    }

    // A stale entry (legacy bare command, or a same-shape command whose baked entry path is otherwise not current) is not "already installed" -- strip it before writing the current command, so a re-install upgrades in place instead of leaving a dead duplicate.
    const groups: QwenMatcherGroup[] = stripStaleGroupHooks(existingGroups, isQwenTokenGoatCommand)
    groups.push({ matcher: '', hooks: [{ type: 'command', command }] })
    hooks[event] = groups
    changed = true
  }

  if (!changed) {
    return { settingsPath: p, alreadyInstalled: true }
  }

  settings.hooks = hooks
  writeJsonSettings(p, settings)
  return { settingsPath: p, alreadyInstalled: false }
}

export function uninstallQwen(): boolean {
  const p = qwenSettingsPath()
  const settings = readQwenSettings(p)
  const hooks = settings.hooks
  if (hooks === undefined) return false

  const removed = stripOwnHooksFromMap(hooks, isQwenTokenGoatCommand)

  if (!removed) return false

  if (Object.keys(hooks).length === 0) {
    delete settings.hooks
  } else {
    settings.hooks = hooks
  }

  writeJsonSettings(p, settings)
  return true
}

export function isQwenInstalled(): boolean {
  const settings = readQwenSettings(qwenSettingsPath())
  const hooks = settings.hooks
  if (hooks === undefined) return false
  for (const event of QWEN_HOOK_EVENTS) {
    const command = qwenHookCommand(QWEN_EVENT_ARG[event])
    if (!groupHasTokenGoat(hooks[event], (c) => isCurrentQwenTokenGoatCommand(c, command))) return false
  }
  return true
}
