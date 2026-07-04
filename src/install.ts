/**
 * Install / uninstall token-goat's hooks in Claude Code settings.
 *
 * Ports the `patch_settings_json` / `unpatch_settings_json` slice of
 * `install.py` to TypeScript. Claude Code reads hook wiring from
 * `~/.claude/settings.json` (user scope) or `<project>/.claude/settings.json`
 * (project scope). Each token-goat hook is a `{ type: "command", command:
 * "token-goat hook <event>" }` entry under the matching event key.
 *
 * Writes go through {@link atomicWriteText}; an absent settings file is created
 * with only the hooks section. Installation is idempotent — re-running never
 * duplicates an entry — and uninstall removes only token-goat's own entries,
 * leaving any user-authored hooks intact.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { atomicWriteText, ensureDirSync } from './util.js'

/** Where to install: the user's home `~/.claude` or the project's `.claude`. */
export type HookScope = 'user' | 'project'

/** Outcome of an {@link installHooks} call. */
export interface InstallResult {
  /** Scope the hooks were written to. */
  readonly scope: HookScope
  /** Absolute path to the settings file that was written. */
  readonly settingsPath: string
  /** True when every token-goat hook was already present (no write needed). */
  readonly alreadyInstalled: boolean
}

/**
 * Claude Code event names token-goat wires, mapped to their internal event arg.
 *
 * The settings key is Claude Code's PascalCase event name; the value is the arg
 * passed to `token-goat hook <event>`, matching the internal HookEventName
 * spellings the relay dispatches on.
 */
const HOOK_EVENT_MAP: ReadonlyArray<readonly [string, string]> = [
  ['PreToolUse', 'pre_tool_use'],
  ['PostToolUse', 'post_tool_use'],
  ['PreCompact', 'pre_compact'],
]

/** Marker substring identifying a token-goat hook command for idempotency. */
const COMMAND_MARKER = 'token-goat hook'

/**
 * Command substrings from earlier product eras that must still be recognized
 * as token-goat's own, so an upgrade doesn't leave a dead duplicate behind:
 * - `tokenwise` — the pre-rename product name (2026-05-13 rename to token-goat).
 * - `token_goat` — the pre-TS-port Python invocation (`pythonw -m token_goat.cli hook ...`).
 * - `tg-hook` — the Python-era persistent wrapper script (`tg-hook.cmd` / `tg-hook.sh`).
 * - `token-goat-hook` — the Python-era GUI-subsystem exe wrapper (`token-goat-hook.exe`).
 * None of these resolve on a machine running the current build, so a settings.json
 * entry carrying one is always a stale leftover to detect and strip, never a
 * legitimately different install to leave alone.
 */
const LEGACY_COMMAND_MARKERS = ['tokenwise', 'token_goat', 'tg-hook', 'token-goat-hook']

/**
 * Builds a regex that matches `marker` only at a word/path boundary, so a plain
 * substring check can't false-positive on a marker embedded inside a longer
 * identifier (e.g. a user hook literally named `my-token-goat-hook-config`).
 */
function anchoredMarkerPattern(marker: string): RegExp {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![a-zA-Z0-9_-])${escaped}(?![a-zA-Z0-9_-])`)
}

const HOOK_MARKER_PATTERNS = [COMMAND_MARKER, ...LEGACY_COMMAND_MARKERS].map(anchoredMarkerPattern)

/** True when `command` is a current-or-legacy token-goat hook invocation. */
function isTokenGoatHookCommand(command: string): boolean {
  return HOOK_MARKER_PATTERNS.some((pattern) => pattern.test(command))
}

/** Build the hook command string for an internal event arg. */
function hookCommand(eventArg: string): string {
  return `token-goat hook ${eventArg}`
}

/** Return the `~/.claude` or `<cwd>/.claude` settings path for `scope`. */
export function settingsPath(scope: HookScope): string {
  const base = scope === 'user' ? path.join(os.homedir(), '.claude') : path.join(process.cwd(), '.claude')
  return path.join(base, 'settings.json')
}

/** A single hook command entry as Claude Code stores it. */
interface HookCommandEntry {
  type: string
  command: string
}

/** A matcher group: an optional matcher plus the list of hook commands. */
interface HookMatcherGroup {
  matcher?: string
  hooks?: HookCommandEntry[]
}

/** The settings shape we read/write; unknown keys are preserved verbatim. */
interface Settings {
  hooks?: Record<string, HookMatcherGroup[]>
  [key: string]: unknown
}

/**
 * Thrown by {@link readSettings} in strict mode when the settings file exists
 * but isn't parseable JSON, or parses to something other than a JSON object.
 * A caller about to overwrite the file (installHooks) must let this propagate
 * rather than silently proceeding as if the file were empty -- otherwise a
 * single JSON typo in the user's settings.json gets clobbered on write.
 */
export class SettingsParseError extends Error {}

/**
 * Parse the settings file at `p`.
 *
 * A missing file always yields `{}` -- that's the legitimate "nothing
 * installed yet" case. When `opts.strict` is true, a file that *exists* but
 * fails to parse (or parses to something other than a JSON object) throws
 * {@link SettingsParseError} instead of returning `{}`, so a caller about to
 * overwrite the file can tell "genuinely empty" apart from "corrupt, do not
 * touch." Non-strict callers (read-only, or a no-op on corrupt) keep the old
 * lenient `{}` fallback.
 */
function readSettings(p: string, opts: { strict?: boolean } = {}): Settings {
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
      throw new SettingsParseError(
        `settings file '${p}' exists but contains invalid JSON. Fix or back up the file before running install.`,
      )
    }
    // Corrupt JSON: do not clobber it silently — but for our read we treat it as empty so callers can decide. (installHooks rewrites the whole file.)
    return {}
  }
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    return parsed as Settings
  }
  if (opts.strict === true) {
    throw new SettingsParseError(
      `settings file '${p}' does not contain a JSON object at the top level. Fix or back up the file before running install.`,
    )
  }
  return {}
}

/** True when `group` already contains a token-goat hook for `eventArg`. */
function groupHasTokenGoat(groups: HookMatcherGroup[] | undefined): boolean {
  if (groups === undefined) return false
  for (const group of groups) {
    for (const h of group.hooks ?? []) {
      if (isTokenGoatHookCommand(h.command)) return true
    }
  }
  return false
}

/**
 * Install token-goat hooks into the `scope` settings file.
 *
 * Reads the existing settings (creating an empty doc when absent), adds any
 * missing token-goat hook entries under each mapped event key, and writes the
 * result atomically. `alreadyInstalled` is true when nothing had to change.
 */
export function installHooks(scope: HookScope = 'user'): InstallResult {
  const p = settingsPath(scope)
  // strict: true -- a settings file that exists but fails to parse must abort
  // before any write (see SettingsParseError), not silently proceed as if it
  // were empty and get clobbered below.
  const settings = readSettings(p, { strict: true })
  const hooks = settings.hooks ?? {}

  let changed = false
  for (const [eventKey, eventArg] of HOOK_EVENT_MAP) {
    const groups = hooks[eventKey] ?? []
    if (groupHasTokenGoat(groups)) continue
    groups.push({ matcher: '', hooks: [{ type: 'command', command: hookCommand(eventArg) }] })
    hooks[eventKey] = groups
    changed = true
  }

  if (!changed) {
    return { scope, settingsPath: p, alreadyInstalled: true }
  }

  settings.hooks = hooks
  ensureDirSync(path.dirname(p))
  atomicWriteText(p, `${JSON.stringify(settings, null, 2)}\n`)
  return { scope, settingsPath: p, alreadyInstalled: false }
}

/**
 * Remove token-goat hooks from the `scope` settings file.
 *
 * Strips every hook entry whose command targets `token-goat hook ...`, prunes
 * now-empty matcher groups and event keys, and drops the `hooks` section if it
 * becomes empty. Returns true when at least one entry was removed; false when
 * none were present (no write occurs in that case).
 */
export function uninstallHooks(scope: HookScope = 'user'): boolean {
  const p = settingsPath(scope)
  const settings = readSettings(p)
  const hooks = settings.hooks
  if (hooks === undefined) return false

  let removed = false
  for (const eventKey of Object.keys(hooks)) {
    const groups = hooks[eventKey]
    if (groups === undefined) continue
    const keptGroups: HookMatcherGroup[] = []
    for (const group of groups) {
      const keptHooks = (group.hooks ?? []).filter((h) => {
        const isOurs = typeof h.command === 'string' && isTokenGoatHookCommand(h.command)
        if (isOurs) removed = true
        return !isOurs
      })
      if (keptHooks.length > 0) {
        keptGroups.push({ ...group, hooks: keptHooks })
      } else if ((group.hooks ?? []).length === 0) {
        // A group that had no hooks to begin with is user data; preserve it.
        keptGroups.push(group)
      }
    }
    if (keptGroups.length > 0) {
      hooks[eventKey] = keptGroups
    } else {
      delete hooks[eventKey]
    }
  }

  if (!removed) return false

  if (Object.keys(hooks).length === 0) {
    delete settings.hooks
  } else {
    settings.hooks = hooks
  }

  ensureDirSync(path.dirname(p))
  atomicWriteText(p, `${JSON.stringify(settings, null, 2)}\n`)
  return true
}

/**
 * Are token-goat hooks installed in `scope`?
 *
 * True only when every mapped event key carries a token-goat hook command —
 * a partial install (some events wired, some not) reads as not installed so
 * {@link installHooks} will top up the missing entries.
 */
export function isInstalled(scope: HookScope = 'user'): boolean {
  const settings = readSettings(settingsPath(scope))
  const hooks = settings.hooks
  if (hooks === undefined) return false
  for (const [eventKey] of HOOK_EVENT_MAP) {
    if (!groupHasTokenGoat(hooks[eventKey])) return false
  }
  return true
}
