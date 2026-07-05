/**
 * Gemini CLI install / uninstall writer.
 *
 * `token-goat install --gemini` writes hook entries into `~/.gemini/settings.json`
 * in addition to the base Claude Code install (see README's "Gemini CLI users"
 * section). This module only ever touches that one file -- the base Claude
 * Code writer in `../install.ts` is unaffected and is always run separately by
 * the caller, exactly like `../bridges/codex_install.ts`'s `installCodex` and
 * `./pi_install.ts`'s `installPi`.
 *
 * Gemini CLI's own hook config (verified against https://geminicli.com/docs/hooks/reference/)
 * uses the same `hooks: Record<Event, Array<{ matcher?, hooks: [...] }>>` shape
 * Claude Code's own `settings.json` uses (see `HookMatcherGroup`/`HookCommandEntry`
 * in `../install.ts`), just under different event keys and with tool-name
 * matchers that are genuine regexes (Gemini docs: "matchers are Regular
 * Expressions" for `BeforeTool`/`AfterTool`; lifecycle events like
 * `SessionStart`/`PreCompress` take no matcher and fire on every occurrence).
 * No shim script is needed the way Codex's strict `additionalProperties: false`
 * schemas require one: Gemini's hook command is invoked directly
 * (`token-goat hook <event>`), exactly as Claude Code's own `hookCommand` in
 * `../install.ts` does. `relay.ts`'s `harnessForNormalization()` routes the
 * resulting `token-goat hook` subprocess to `normalizePayload(..., 'gemini')`
 * whenever it inherits Gemini CLI's own environment (`GEMINI_API_KEY` /
 * `GOOGLE_API_KEY`, via `detectHarness()`), which is what actually translates
 * Gemini's snake_case tool names to token-goat's canonical ones at runtime --
 * this module only has to get the *installed command* right.
 *
 * Event -> internal-tool coverage is derived from {@link GEMINI_TOOL_NAME_MAP}
 * (`../hooks_cli.ts`, exported so both the runtime payload normalizer and this
 * installer share one source of truth) grouped by which internal tool actually
 * has a registered `pre_tool_use`/`post_tool_use` handler -- see
 * {@link GEMINI_PRE_TOOLS}/{@link GEMINI_POST_TOOLS} below for the exact
 * evidence (registerHook call sites in hooks_bash.ts/hooks_read.ts/hooks_edit.ts/
 * hooks_fetch.ts). Gemini's `glob` tool name maps to token-goat's `Glob`
 * canonical tool, but `Glob` currently has no registered hook handler at all
 * (a pre-existing, separately-tracked gap, despite `hooks_read.ts`'s own doc
 * comments claiming Read/Grep/Glob coverage) -- wiring a matcher for it here
 * would just be an inert subprocess spawn per Gemini `glob` call, so it is
 * intentionally left out of both `BeforeTool` and `AfterTool`, mirroring how
 * `installCodex`'s own `CODEX_MATCHERS` excludes Codex's glob-equivalent tool
 * names for the same reason.
 *
 * A corrupt-but-recoverable `settings.json` (exists but fails to parse) must
 * never be silently clobbered -- {@link installGemini} throws
 * {@link GeminiSettingsParseError} before any write in that case, mirroring the
 * `SettingsParseError` / `CodexConfigParseError` strict-mode guards in
 * `../install.ts` / `./codex_install.ts`.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { GEMINI_TOOL_NAME_MAP } from '../hooks_cli.js'
import { anchoredMarkerPattern } from '../install.js'
import { atomicWriteText, backupFile, ensureDirSync, extractErrorMessage } from '../util.js'

/** Marker substring identifying a token-goat-authored Gemini hook command. */
const GEMINI_COMMAND_MARKER = 'token-goat hook'

/** Gemini CLI's own hook event keys that token-goat wires (README "Gemini CLI users"). */
const GEMINI_HOOK_EVENTS = ['BeforeTool', 'AfterTool', 'SessionStart', 'PreCompress'] as const
type GeminiHookEvent = (typeof GEMINI_HOOK_EVENTS)[number]

/** Gemini event key -> the internal event arg passed to `token-goat hook`. */
const GEMINI_EVENT_ARG: Record<GeminiHookEvent, string> = {
  BeforeTool: 'pre_tool_use',
  AfterTool: 'post_tool_use',
  SessionStart: 'session_start',
  PreCompress: 'pre_compact',
}

/**
 * Internal tools with a registered `pre_tool_use` handler (evidence:
 * `registerHook('pre_tool_use', ...)` call sites): Bash (hooks_bash.ts
 * preBashHandler), Read (hooks_read.ts preReadHandler + image_shrink.ts
 * preReadImageHandler), Grep (hooks_read.ts preReadHandler, registered
 * separately for the 'Grep' tool name), WebFetch (hooks_fetch.ts
 * preFetchHandler). Write/Edit have no pre-hook; Glob has none at all.
 */
const GEMINI_PRE_TOOLS: ReadonlySet<string> = new Set(['Bash', 'Read', 'Grep', 'WebFetch'])

/**
 * Internal tools with a registered `post_tool_use` handler: Bash
 * (hooks_bash.ts postBashHandler), Read (hooks_read.ts postReadHandler),
 * Write/Edit (hooks_edit.ts postEditHandler), WebFetch (hooks_fetch.ts
 * postFetchHandler). Grep has no post-hook registered; Glob has none at all.
 */
const GEMINI_POST_TOOLS: ReadonlySet<string> = new Set(['Bash', 'Read', 'Write', 'Edit', 'WebFetch'])

/** One `type: "command"` hook entry as Gemini's settings.json stores it. */
interface GeminiHookEntry {
  type: string
  command: string
  [key: string]: unknown
}

/** One matcher group under a Gemini hook event array. */
interface GeminiMatcherGroup {
  matcher?: string
  hooks?: GeminiHookEntry[]
}

/** The settings.json shape read/written; unknown top-level keys are preserved verbatim. */
interface GeminiSettings {
  hooks?: Record<string, GeminiMatcherGroup[]>
  [key: string]: unknown
}

/**
 * Thrown by {@link installGemini}/{@link uninstallGemini} when `settings.json`
 * exists but isn't parseable JSON (or isn't a JSON object at the top level). A
 * caller about to write the file must let this propagate rather than silently
 * proceeding as if the file were empty -- otherwise a single JSON typo in the
 * user's settings gets clobbered on write.
 */
export class GeminiSettingsParseError extends Error {}

/** Absolute path to `~/.gemini/settings.json`. */
export function geminiSettingsPath(): string {
  return path.join(os.homedir(), '.gemini', 'settings.json')
}

/**
 * Parse `settings.json` at `p`.
 *
 * A missing file yields `{}` -- the legitimate "nothing installed yet" case.
 * When `opts.strict` is true, a file that *exists* but fails to parse (or
 * whose top level isn't a JSON object) throws {@link GeminiSettingsParseError}
 * instead of returning `{}`, so a caller about to overwrite the file can tell
 * "genuinely empty" apart from "corrupt, do not touch." Non-strict (read-only)
 * callers keep the lenient `{}` fallback.
 */
function readGeminiSettings(p: string, opts: { strict?: boolean } = {}): GeminiSettings {
  let raw: string
  try {
    raw = fs.readFileSync(p, 'utf8')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    if (opts.strict === true) {
      throw new GeminiSettingsParseError(
        `Gemini settings file '${p}' exists but contains invalid JSON. Fix or back up the file before running install. (${extractErrorMessage(e)})`,
      )
    }
    return {}
  }
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    return parsed as GeminiSettings
  }
  if (opts.strict === true) {
    throw new GeminiSettingsParseError(
      `Gemini settings file '${p}' does not contain a JSON object at the top level. Fix or back up the file before running install.`,
    )
  }
  return {}
}

/** True when `command` is a token-goat-authored Gemini hook invocation. */
const GEMINI_MARKER_PATTERN = anchoredMarkerPattern(GEMINI_COMMAND_MARKER)

/** True when `command` invokes token-goat's Gemini hook -- anchored so a marker embedded as a substring inside an unrelated command can't false-positive. */
function isGeminiTokenGoatCommand(command: string): boolean {
  return typeof command === 'string' && GEMINI_MARKER_PATTERN.test(command)
}

/** True when `groups` already has a token-goat hook entry under the exact `matcher` value (`undefined` for a no-matcher lifecycle group). */
function groupHasTokenGoat(groups: GeminiMatcherGroup[] | undefined, matcher: string | undefined): boolean {
  if (groups === undefined) return false
  for (const group of groups) {
    if (group.matcher !== matcher) continue
    for (const h of group.hooks ?? []) {
      if (isGeminiTokenGoatCommand(h.command)) return true
    }
  }
  return false
}


/** Build the shell command Gemini should run for one hook entry. */
function geminiHookCommand(eventArg: string): string {
  return `token-goat hook ${eventArg}`
}

/**
 * Group {@link GEMINI_TOOL_NAME_MAP}'s Gemini tool names by their mapped
 * internal tool, preserving the map's own key order (so output is
 * deterministic across runs).
 */
function geminiNamesByInternalTool(): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const [geminiName, internalTool] of Object.entries(GEMINI_TOOL_NAME_MAP)) {
    const list = out.get(internalTool)
    if (list) {
      list.push(geminiName)
    } else {
      out.set(internalTool, [geminiName])
    }
  }
  return out
}

/**
 * Desired matcher list for one Gemini hook event.
 *
 * `SessionStart`/`PreCompress` are lifecycle events: a single no-matcher
 * group (`undefined`) that fires on every occurrence, per Gemini's own docs.
 * `BeforeTool`/`AfterTool` get one regex-alternation matcher per internal tool
 * that actually has a registered handler for that (event, tool) pair (see
 * {@link GEMINI_PRE_TOOLS}/{@link GEMINI_POST_TOOLS}), e.g.
 * `^(read_file|read_many_files|list_directory)$` for Read.
 */
function desiredMatchersFor(event: GeminiHookEvent): Array<string | undefined> {
  if (event === 'SessionStart' || event === 'PreCompress') return [undefined]
  const toolSet = event === 'BeforeTool' ? GEMINI_PRE_TOOLS : GEMINI_POST_TOOLS
  const matchers: string[] = []
  for (const [internalTool, names] of geminiNamesByInternalTool()) {
    if (!toolSet.has(internalTool)) continue
    matchers.push(`^(${names.join('|')})$`)
  }
  return matchers
}

/** Outcome of an {@link installGemini} call. */
export interface GeminiInstallResult {
  readonly settingsPath: string
  /** True when every hook entry was already present (no write needed). */
  readonly alreadyInstalled: boolean
}

/**
 * Install the Gemini CLI integration.
 *
 * Always additive: never touches Claude Code's `~/.claude/settings.json` (the
 * caller is responsible for also running the base install). Idempotent -- a
 * second call reports `alreadyInstalled: true` and does not duplicate any
 * matcher group.
 */
export function installGemini(): GeminiInstallResult {
  const p = geminiSettingsPath()
  // strict: true -- a settings.json that exists but fails to parse must abort
  // before any write (see GeminiSettingsParseError), not silently proceed as
  // if it were empty and get clobbered below.
  const settings = readGeminiSettings(p, { strict: true })
  const hooks = settings.hooks ?? {}

  let changed = false
  for (const event of GEMINI_HOOK_EVENTS) {
    const command = geminiHookCommand(GEMINI_EVENT_ARG[event])
    const groups = [...(hooks[event] ?? [])]
    for (const matcher of desiredMatchersFor(event)) {
      if (groupHasTokenGoat(groups, matcher)) continue
      const group: GeminiMatcherGroup =
        matcher === undefined ? { hooks: [{ type: 'command', command }] } : { matcher, hooks: [{ type: 'command', command }] }
      groups.push(group)
      changed = true
    }
    hooks[event] = groups
  }

  if (!changed) {
    return { settingsPath: p, alreadyInstalled: true }
  }

  settings.hooks = hooks
  ensureDirSync(path.dirname(p))
  backupFile(p)
  atomicWriteText(p, `${JSON.stringify(settings, null, 2)}\n`)
  return { settingsPath: p, alreadyInstalled: false }
}

/**
 * Remove the Gemini CLI integration: strips only token-goat's own hook
 * entries from `settings.json` (preserving any other keys/hooks/matchers).
 * Returns true when at least one entry was present and removed; false when
 * nothing was installed (no write occurs in that case).
 */
export function uninstallGemini(): boolean {
  const p = geminiSettingsPath()
  const settings = readGeminiSettings(p)
  const hooks = settings.hooks
  if (hooks === undefined) return false

  let removed = false
  for (const eventKey of Object.keys(hooks)) {
    const groups = hooks[eventKey]
    if (groups === undefined) continue
    const kept: GeminiMatcherGroup[] = []
    for (const group of groups) {
      const keptHooks = (group.hooks ?? []).filter((h) => {
        const isOurs = isGeminiTokenGoatCommand(h.command)
        if (isOurs) removed = true
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

  if (!removed) return false

  if (Object.keys(hooks).length === 0) {
    delete settings.hooks
  } else {
    settings.hooks = hooks
  }

  ensureDirSync(path.dirname(p))
  backupFile(p)
  atomicWriteText(p, `${JSON.stringify(settings, null, 2)}\n`)
  return true
}

/**
 * Is the Gemini CLI integration currently present?
 *
 * True only when every (event, matcher) pair {@link desiredMatchersFor}
 * expects carries a token-goat hook entry. A partial install (e.g. one
 * matcher group deleted by hand) reads as not installed, so
 * {@link installGemini} will top up what's missing.
 */
export function isGeminiInstalled(): boolean {
  const settings = readGeminiSettings(geminiSettingsPath())
  const hooks = settings.hooks
  if (hooks === undefined) return false
  for (const event of GEMINI_HOOK_EVENTS) {
    for (const matcher of desiredMatchersFor(event)) {
      if (!groupHasTokenGoat(hooks[event], matcher)) return false
    }
  }
  return true
}
