/** Codex CLI install / uninstall writer. `token-goat install --codex` patches Codex CLI in addition to the base Claude Code install (see README's "Codex CLI users" section: "The `--codex` flag patches both Claude Code and Codex CLI in one pass"). This module only ever touches paths under `~/.codex/` -- the base Claude Code writer in `../install.ts` is unaffected and is always run separately by the caller. Three artifacts are installed: - `~/.codex/hooks/token-goat-shim.cjs` -- {@link CODEX_HOOK_SCRIPT} written to disk. Codex's `command` hook field invokes it via `hookCommandFor` below as `"<process.execPath>" "<this path>" <event> "<token-goat entry path>"` -- the absolute Node binary and a baked token-goat entry path, not a bare `node`/`token-goat` depending on PATH resolution (github/copilot-cli#4001 class of failure, fixed here the same way as the Copilot CLI bridge). The shim itself forwards stdin to that baked entry (`token-goat hook <event>`, falling back to a PATH-based lookup when the entry arg is absent) and massages the JSON response to satisfy Codex's strict (`additionalProperties: false`) output schemas. Rewritten unconditionally on every install so an upgraded token-goat version's shim logic always reaches disk, even when the config.toml hooks block itself needed no changes. - `~/.codex/config.toml` -- a `[[hooks.<Event>]]` / `[[hooks.<Event>.hooks]]` array-of-tables block (Codex's real hook config shape; verified against OpenAI's Codex hooks documentation) wiring `PreToolUse`/`PostToolUse` for the three Codex-specific matchers the README documents: `view_image|Bash|exec|shell|bash`, `apply_patch`, `web_search` -- plus three matcher-less global events, `PreCompact`/`UserPromptSubmit`/`SubagentStop`, matching what Claude Code and Grok already wire (see {@link CODEX_GLOBAL_HOOK_EVENTS}'s docstring). Parsed/serialized with `smol-toml`, the same library `config.ts` already uses for token-goat's own config file, so no TOML is hand-rolled. Any other keys/tables in the file are preserved verbatim (mirrors `install.ts`'s treatment of unrelated `settings.json` keys). A timestamped `.bak` is written before any in-place edit. - `~/.codex/AGENTS.md` -- a delimited `<!-- token-goat-codex-begin -->` / `<!-- token-goat-codex-end -->` block with the same routing guidance as Claude Code's `CLAUDE.md` block, adapted for Codex's own tool names (`shell`, `apply_patch`, `view_image`, `web_search` -- see `CODEX_TOOL_NAME_MAP` in `../hooks_cli.ts`). Content outside the markers is always preserved. A corrupt-but-recoverable `config.toml` (exists but fails to parse) must never be silently clobbered -- {@link installCodex} throws {@link CodexConfigParseError} before any write in that case, mirroring the `SettingsParseError` strict-mode guard in `../install.ts`. */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { parse, stringify } from 'smol-toml'

import { recordCreatedBy, removeCreatedBackups, removeCreatedTree } from './created_configs.js'
import { atomicWriteText, backupFile, ensureDirSync, extractErrorMessage, hookCommandFor, hookPowershellCommand, stripDelimitedBlock, stripOwnHooksFromMap, stripStaleGroupHooks, upsertDelimitedBlock, writeConfigText } from '../util.js'
import { powershellHookLine } from '../process_util.js'
import { anchoredMarkerPattern } from '../install.js'
import { nativeHookBinary, nativeHookCommandLine, splitHookCommand, type WiredHookEntry } from '../native_hook.js'
import { CODEX_HOOK_SCRIPT } from './codex.js'
import { LEGACY_SHIM_FILE, SHIM_FILE, legacyShimForwarder } from './shim_common.js'
import { buildGuidanceBlock } from './guidance_block.js'
import { loadConfig } from '../config.js'
import { groupHasTokenGoat, findTokenGoatEntryPosition, findAnyTokenGoatEntryPosition } from './matcher_group.js'
import { echoedValue } from '../hint_suggestion_guard.js'

/** Marker substring identifying a token-goat-authored Codex hook command. */
const CODEX_COMMAND_MARKER = 'token-goat-shim'

/** The Codex-specific tool-name matchers token-goat wires (README "What gets installed?" -> "With `--codex`"). Codex's matcher string is matched against its own native tool names, not token-goat's internal ones, so this alternation covers image reads and shell execution together (mirroring Claude Code's combined Read/Grep/Bash pre-read handling); `apply_patch` covers file edits and `web_search` covers Codex's web-fetch equivalent. Codex's matcher is tested against the tool name it puts on the hook wire, and 0.155.0 does not use one vocabulary for that. CAPTURE, 2026-09-22, read out of the hook payload itself rather than off the rollout: a shell command arrives as `tool_name: "Bash"` -- Codex normalizes its own `exec` tool into Claude Code's PascalCase naming before matching -- while the patch tool arrives under its native `apply_patch`. So `Bash` is what covers shell execution here, and the rollout's `custom_tool_call` name (`exec`) is the internal spelling, which never reaches the matcher. Reaching that took a calibrated test rather than a guess. With `view_image|exec|shell|bash` installed, a real run's isolated ledger held `hook:pre_compact|8` and `hook:user_prompt_submit|1` and no `hook:pre_tool_use` or `hook:post_tool_use` row at all -- every tool-scoped hook silently dead, which also stranded the pre-compact manifest, since it queues on PreCompact and drains on the next PostToolUse (eight queued across that run, none delivered). A null that shape has two causes: a matcher that does not match, or a `[hooks.state]` trusted_hash Codex rejects. Substituting `.*` with a recomputed hash made both rows appear immediately, which separates them: the hash was always right and the matcher was always wrong. The broken names were not wrong by accident, and one of them was a regression. An older version wired `view_image|Bash`, which matched; it was changed to `view_image|shell|bash` on the strength of this file's own `buildAgentsBlock` text naming "Codex's native `shell`, `apply_patch`, and `view_image` tools" -- a fixture read off the producer sitting beside it rather than off a run, so it agreed with the mistake by construction and every test kept passing. Lowercase `bash`, `shell` and `exec` are kept as alternatives because an older Codex or a fork may still send them and an unmatched alternative costs nothing. `view_image` and `web_search` carry no capture: neither was invoked in the runs above, so they stay unverified rather than confirmed. */
const CODEX_MATCHERS = ['view_image|Bash|exec|shell|bash', 'apply_patch', 'web_search', 'spawn_agent'] as const

/** Event keys wired for each matcher: pre- and post- tool-call interception. */
const CODEX_HOOK_EVENTS = ['PreToolUse', 'PostToolUse'] as const
type CodexHookEvent = (typeof CODEX_HOOK_EVENTS)[number]

/** Codex event key -> the internal event arg passed to the shim / `token-goat hook`. */
const CODEX_EVENT_ARG: Record<CodexHookEvent, string> = {
  PreToolUse: 'pre_tool_use',
  PostToolUse: 'post_tool_use',
}

/** Codex hook events that are turn-scoped but not tool-specific, so they need no `matcher` (Codex's docs: omit `matcher` entirely to match every occurrence of a supported event). Confirmed against Codex's real hooks documentation (developers.openai.com/codex/hooks, "Configuration Reference"/"Hooks" pages, checked 2026-07-18): `PreCompact`, `UserPromptSubmit`, and `SubagentStop` are real Codex hook events using the identical `[[hooks.<Event>]]` config.toml shape already used for `PreToolUse`/`PostToolUse` above -- token-goat just wasn't wiring them. Claude Code (`../install.ts`'s `HOOK_EVENT_MAP`) and Grok (`grok_install.ts`'s `GROK_HOOK_EVENTS`) already wire the equivalent three events to the same server-side handlers (`preCompactHandler`/ `preCompactIndexHandler`, `userPromptSubmitHandler`, `subagentStopHandler` in src/hooks_compact.ts, src/hooks_index.ts, src/hooks_session.ts). */
const CODEX_GLOBAL_HOOK_EVENTS = ['PreCompact', 'UserPromptSubmit', 'SubagentStop'] as const
type CodexGlobalHookEvent = (typeof CODEX_GLOBAL_HOOK_EVENTS)[number]

/** Codex global event key -> the internal event arg passed to the shim / `token-goat hook`. */
const CODEX_GLOBAL_EVENT_ARG: Record<CodexGlobalHookEvent, string> = {
  PreCompact: 'pre_compact',
  UserPromptSubmit: 'user_prompt_submit',
  SubagentStop: 'subagent_stop',
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
  hooks?: Record<string, CodexMatcherGroup[] | undefined> & { state?: Record<string, { trusted_hash?: string }> }
  [key: string]: unknown
}

/** Thrown by {@link installCodex}/{@link uninstallCodex} when `config.toml` exists but cannot be read or isn't parseable TOML. A caller about to write the file must let this propagate rather than silently proceeding as if the file were empty -- otherwise a single TOML typo in the user's config gets clobbered on write, or the hook shim and the file's backups are deleted while it still names them. */
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
  return path.join(os.homedir(), '.codex', 'hooks', SHIM_FILE)
}

/** The shim's pre-`.cjs` path, now a forwarder to it (see {@link LEGACY_SHIM_FILE}). */
function codexLegacyHookScriptPath(): string {
  return path.join(os.homedir(), '.codex', 'hooks', LEGACY_SHIM_FILE)
}

/** Parse `config.toml` at `p`. A missing file yields `{}` -- the legitimate "nothing installed yet" case. When `opts.strict` is true, a file that *exists* but cannot be read or fails to parse throws {@link CodexConfigParseError} instead of returning `{}`, so a caller about to overwrite or strip the file can tell "genuinely empty" apart from "corrupt, do not touch"; `opts.command` names the command the message tells the user to run again. Non-strict (read-only) callers keep the lenient `{}` fallback. */
function readCodexConfig(p: string, opts: { strict?: boolean; command?: 'install' | 'uninstall' } = {}): CodexConfig {
  const refuse = (problem: string, detail?: string): CodexConfigParseError =>
    new CodexConfigParseError(
      (opts.command === 'uninstall'
        ? `Codex config file ${echoedValue(p)} is unreadable: it ${problem}. Uninstall left it untouched, along with the hook shim it may still name, the AGENTS.md block and the file's backups; fix the file and run uninstall again.`
        : `Codex config file ${echoedValue(p)} ${problem}. Fix or back up the file before running install.`) + (detail === undefined ? '' : ` (${detail})`),
    )
  let raw: string
  try {
    raw = fs.readFileSync(p, 'utf8')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    // Only an absent file is the "nothing installed yet" case; see install.ts's readSettings.
    if (opts.strict === true && code !== 'ENOENT' && code !== 'ENOTDIR') throw refuse('exists but cannot be read', code ?? extractErrorMessage(e))
    return {}
  }
  try {
    const parsed = parse(raw)
    return parsed as CodexConfig
  } catch (e) {
    if (opts.strict === true) throw refuse('exists but contains invalid TOML', extractErrorMessage(e))
    return {}
  }
}

/** True when `command` is a token-goat-authored Codex hook invocation. */
const CODEX_MARKER_PATTERN = anchoredMarkerPattern(CODEX_COMMAND_MARKER)

/** True when `command` invokes token-goat's Codex shim -- anchored so a marker embedded as a substring inside an unrelated command (e.g. a longer path) can't false-positive. */
function isCodexTokenGoatCommand(command: string): boolean {
  return typeof command === 'string' && CODEX_MARKER_PATTERN.test(command)
}

/** True when `groups` (a matcher-less/global event's `[[hooks.<Event>]]` array) already has an entry matching `predicate`, regardless of `matcher` value. Mirrors {@link groupHasTokenGoat} but without the exact-matcher requirement, since {@link CODEX_GLOBAL_HOOK_EVENTS} entries are written with no `matcher` field at all. */
function anyGroupHasTokenGoat(
  groups: CodexMatcherGroup[] | undefined,
  predicate: (command: string) => boolean = isCodexTokenGoatCommand,
): boolean {
  return findAnyTokenGoatEntryPosition(groups, predicate) !== undefined
}

// hookCommandFor is shared with copilot_cli_install.ts -- see util.ts.

/** Build the hook command for Codex. On Windows, Codex CLI executes hook commands via PowerShell (`powershell.exe -Command ...`). In PowerShell, adjacent quoted string literals without a call operator fail with a ParserError ("Unexpected token '...' in expression or statement"). On Windows the command is therefore powershellHookLine over hookPowershellCommand: the call operator, single-quoted paths (a double-quoted one let PowerShell expand a `$` in the path), and the exit suffix that keeps the hook's exit code; the same line `copilot_cli_install.ts` writes for Copilot CLI's `powershell` field and `grok_install.ts` for Grok. On Unix (Linux/macOS), Codex executes hooks via POSIX `sh`, where `&` would be an invalid background operator, so the bare quoted command is preserved. */
export function codexHookCommandFor(scriptPath: string, eventArg: string, opts: { sync?: boolean } = {}): string {
  // The native client in front, when this install wires it: quoted for PowerShell on Windows (single quotes, so a `$` in a path stays literal) and for the POSIX shell Codex runs hooks with elsewhere. `sync: false` (the installed check) never refreshes the Windows copy.
  const bin = nativeHookBinary(process.argv[1], opts)
  const native = bin === undefined ? undefined : nativeHookCommandLine(process.platform === 'win32' ? 'powershell' : 'sh', bin, 'codex', scriptPath, eventArg)
  if (native !== undefined) return native
  return process.platform === 'win32' ? powershellHookLine(hookPowershellCommand(scriptPath, eventArg)) : hookCommandFor(scriptPath, eventArg)
}

/** Compute the canonical `trusted_hash` string that Codex CLI uses in `[hooks.state]` to track whether a hook definition is trusted. Codex canonicalizes the hook into: { event_name: <snake_case_event>, hooks: [{ async: false, command: <command>, timeout: 600, type: "command" }], matcher?: <matcher> } and hashes the compact JSON representation with SHA-256 (`sha256:<hex>`). */
export function computeCodexHookHash(
  eventArg: string,
  command: string,
  matcher?: string,
): string {
  const norm: Record<string, unknown> = {
    event_name: eventArg,
    hooks: [
      {
        async: false,
        command,
        timeout: 600,
        type: 'command',
      },
    ],
  }
  if (matcher !== undefined) {
    norm['matcher'] = matcher
  }
  const serialized = JSON.stringify(norm)
  const hash = crypto.createHash('sha256').update(serialized).digest('hex')
  return `sha256:${hash}`
}

/** Delimiters of the block {@link installCodex} appends to config.toml, so uninstall can take away exactly that text and leave every byte the user wrote, comments included. The second begin line records that the file had no final newline, so the removal knows how many separator newlines it added. */
const MANAGED_BEGIN = '# >>> token-goat codex hooks (managed block; token-goat uninstall removes it) >>>'
const MANAGED_BEGIN_NO_EOL = '# >>> token-goat codex hooks (managed block; token-goat uninstall removes it; file had no final newline) >>>'
const MANAGED_END = '# <<< token-goat codex hooks <<<'

/** `text` without the managed block and the separator newlines install put before it, or undefined when it holds no well-formed block. */
function removeManagedBlock(text: string): string | undefined {
  for (const begin of [MANAGED_BEGIN_NO_EOL, MANAGED_BEGIN]) {
    const start = text.indexOf(begin)
    if (start < 0 || (start > 0 && text[start - 1] !== '\n')) continue
    const endMark = text.indexOf(MANAGED_END, start)
    if (endMark < 0) return undefined
    const nl = text.indexOf('\n', endMark)
    const end = nl < 0 ? text.length : nl + 1
    const sep = start === 0 ? 0 : begin === MANAGED_BEGIN_NO_EOL ? 2 : 1
    if (text.slice(start - sep, start) !== '\n'.repeat(sep)) return undefined
    return text.slice(0, start - sep) + text.slice(end)
  }
  return undefined
}

/** A comparable form of a parsed TOML value: object keys sorted, so two documents that differ only in key order compare equal. */
function canonicalToml(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalToml).join(',')}]`
  if (v instanceof Date) return `d${v.toISOString()}`
  if (typeof v === 'bigint') return `n${v}`
  if (typeof v === 'object' && v !== null) {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalToml((v as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(v) ?? 'undefined'
}

/** The text of `target` built by appending a managed block to the user's own text, or undefined when that cannot be done safely. The user's bytes, comments and layout, stay as they were; the result is returned only when it parses to exactly `target`, so a layout the append cannot express (a static `hooks = [...]` array, a stale token-goat entry outside the block, an edited state entry) falls back to re-serializing the whole file. */
function appendManagedBlock(original: string, target: CodexConfig): string | undefined {
  const base = removeManagedBlock(original) ?? original
  try {
    const baseHooks = (parse(base) as CodexConfig).hooks ?? {}
    const targetHooks = target.hooks ?? {}
    const added: Record<string, unknown> = {}
    for (const [event, groups] of Object.entries(targetHooks)) {
      if (event === 'state' || !Array.isArray(groups)) continue
      const have = Array.isArray(baseHooks[event]) ? baseHooks[event].length : 0
      if (groups.length > have) added[event] = groups.slice(have)
    }
    const baseState = (baseHooks['state'] ?? {}) as Record<string, unknown>
    const addedState = Object.fromEntries(Object.entries(targetHooks['state'] ?? {}).filter(([k]) => !(k in baseState)))
    if (Object.keys(addedState).length > 0) added['state'] = addedState
    let candidate = base
    if (Object.keys(added).length > 0) {
      const noEol = base.length > 0 && !base.endsWith('\n')
      const lead = base.length === 0 ? '' : noEol ? '\n\n' : '\n'
      candidate = `${base}${lead}${noEol ? MANAGED_BEGIN_NO_EOL : MANAGED_BEGIN}\n${stringify({ hooks: added }).trimEnd()}\n${MANAGED_END}\n`
    }
    return canonicalToml(parse(candidate)) === canonicalToml(target) ? candidate : undefined
  } catch {
    return undefined
  }
}

/** The text of `target` built by taking the managed block out of the user's own text and renaming the state tables `rekey` moves, or undefined when that does not parse to exactly `target` (no block to take out, a state table written inline). */
function removeManagedBlockText(original: string, target: CodexConfig, rekey: ReadonlyMap<string, string>): string | undefined {
  const without = removeManagedBlock(original)
  if (without === undefined) return undefined
  const renamed = without.replace(/^([ \t]*)\[hooks\.state\.("(?:[^"\\\n]|\\.)*"|'[^'\n]*')\]([ \t]*(?:#[^\r\n]*)?)(\r?)$/gm, (whole, indent: string, quoted: string, tail: string, cr: string) => {
    let key: string
    try {
      key = quoted.startsWith('"') ? (JSON.parse(quoted) as string) : quoted.slice(1, -1)
    } catch {
      return whole
    }
    const next = rekey.get(key)
    return next === undefined ? whole : `${indent}[hooks.state.${JSON.stringify(next)}]${tail}${cr}`
  })
  try {
    return canonicalToml(parse(renamed)) === canonicalToml(target) ? renamed : undefined
  } catch {
    return undefined
  }
}

/** The event label Codex puts in a hook's state key and hash: the snake_case spelling install writes for the events it wires, derived the same way for any other event. */
function codexEventLabel(event: string): string {
  const known = (CODEX_EVENT_ARG as Record<string, string>)[event] ?? (CODEX_GLOBAL_EVENT_ARG as Record<string, string>)[event]
  return known ?? event.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

/** What stripping token-goat's hooks does to `[hooks.state]`: the keys and hashes that were token-goat's own, and the new key of every user hook whose position the strip moves. Codex keys a hook's trust by position, `<config path>:<event label>:<group index>:<handler index>` (codex-rs/hooks/src/lib.rs `hook_key`; the position keying is discussed in https://github.com/openai/codex/issues/49399), so a user group sitting after a removed group of ours changes index and loses its trust unless its entry is renamed. Mirrors {@link stripOwnHooksFromMap}: a group stays when it has a hook left or began with none. */
function planStateCleanup(configPath: string, hooks: Record<string, unknown>): { ownKeys: Set<string>; ownHashes: Set<string>; rekey: Map<string, string> } {
  const ownKeys = new Set<string>()
  const ownHashes = new Set<string>()
  const rekey = new Map<string, string>()
  for (const [event, groups] of Object.entries(hooks)) {
    if (event === 'state' || !Array.isArray(groups)) continue
    const label = codexEventLabel(event)
    const keyOf = (g: number, h: number): string => `${configPath}:${label}:${g}:${h}`
    let newGroup = 0
    groups.forEach((group: CodexMatcherGroup | null, gi: number) => {
      const list = Array.isArray(group?.hooks) ? group.hooks : []
      const matcher = typeof group?.matcher === 'string' ? group.matcher : undefined
      const mine = list.map((h) => isCodexTokenGoatCommand(h?.command))
      list.forEach((h, hi) => {
        if (!mine[hi]) return
        ownKeys.add(keyOf(gi, hi))
        ownHashes.add(computeCodexHookHash(label, h.command, matcher))
        ownHashes.add(computeCodexHookHash(label, h.command))
      })
      const kept = mine.filter((m) => !m).length
      if (kept === 0 && list.length > 0) return
      let newHook = 0
      list.forEach((_h, hi) => {
        if (mine[hi]) return
        if (newGroup !== gi || newHook !== hi) rekey.set(keyOf(gi, hi), keyOf(newGroup, newHook))
        newHook++
      })
      newGroup++
    })
  }
  return { ownKeys, ownHashes, rekey }
}

/** Outcome of an {@link installCodex} call. */
export interface CodexInstallResult {
  readonly configPath: string
  readonly agentsPath: string
  readonly hookScriptPath: string
  /** True when every artifact was already present and up to date (no write needed). */
  readonly alreadyInstalled: boolean
}

/** Install the Codex CLI integration. Always additive: never touches Claude Code's `~/.claude/settings.json` (the caller is responsible for also running the base install per README's "patches both Claude Code and Codex CLI in one pass"). Idempotent -- a second call reports `alreadyInstalled: true` and does not duplicate any hook entry or AGENTS.md block. */
export function installCodex(): CodexInstallResult {
  return recordCreatedBy(codexArtifactPaths(), installCodexFiles)
}

/** Every file the Codex integration writes; the directories above them are what the created-configs ledger tracks too. */
function codexArtifactPaths(): string[] {
  return [codexConfigPath(), codexAgentsPath(), codexHookScriptPath(), codexLegacyHookScriptPath()]
}

function installCodexFiles(): CodexInstallResult {
  const configPath = codexConfigPath()
  const agentsPath = codexAgentsPath()
  const scriptPath = codexHookScriptPath()

  // The shim is a generated, never-user-edited file: keep it in sync with the running token-goat version on every install call, independent of whether the config.toml hooks block itself needs any change.
  ensureDirSync(path.dirname(scriptPath))
  atomicWriteText(scriptPath, CODEX_HOOK_SCRIPT)
  atomicWriteText(codexLegacyHookScriptPath(), legacyShimForwarder('{}'))

  // strict: true -- a config.toml that exists but fails to parse must abort before any write (see CodexConfigParseError), not silently proceed as if it were empty and get clobbered below.
  const config = readCodexConfig(configPath, { strict: true })
  const hooks: NonNullable<CodexConfig['hooks']> = config.hooks ?? {}

  let hooksChanged = false
  // State keys carrying a group's own real array position (see the write loop near the end of this function) go stale the moment that position changes; the migration cleanup below records the exact key of every token-goat entry it strips so the stale-key purge further down can drop it instead of leaving orphaned trust hashes behind.
  const staleStateKeysToRemove: string[] = []
  for (const event of CODEX_HOOK_EVENTS) {
    const eventArg = CODEX_EVENT_ARG[event]
    const expectedCommand = codexHookCommandFor(scriptPath, eventArg)
    // A hand-edited or foreign-tool-written config.toml can hold a scalar (e.g. a bare string) under a key that Codex CLI's own hooks schema requires to be an array of matcher-group tables; spreading a scalar here would silently split a string into single-character garbage entries, so treat any non-array shape as absent rather than corrupting the write.
    const groups = Array.isArray(hooks[event]) ? [...hooks[event]] : []
    // Migrate a group left behind by a previous token-goat version whose matcher string has since changed (e.g. CODEX_MATCHERS[0] widening from "view_image|Bash" to "view_image|shell|bash" to "view_image|Bash|exec|shell|bash"): stripStaleGroupHooks below only ever compares against the *current* matcher being installed, so a group under an old, no-longer-current matcher would otherwise survive untouched forever and permanently desync every later group's array position from what isCodexInstalled expects. A state key records the position the *existing* config wrote it under, so it has to be built from the group's original index; `idx` alone is the live-array index, which every splice below shifts down, which would record a key one slot short and leave the real orphan behind while transiently deleting a live entry's key.
    let removedGroups = 0
    for (let idx = 0; idx < groups.length; idx++) {
      const g = groups[idx]!
      if (g.matcher === undefined || (CODEX_MATCHERS as readonly string[]).includes(g.matcher)) continue
      const hookList = g.hooks ?? []
      const keptHooks = hookList.filter((h) => !isCodexTokenGoatCommand(h.command))
      if (keptHooks.length === hookList.length) continue
      const originalIdx = idx + removedGroups
      hookList.forEach((h, hi) => {
        if (isCodexTokenGoatCommand(h.command)) staleStateKeysToRemove.push(`${configPath}:${eventArg}:${originalIdx}:${hi}`)
      })
      hooksChanged = true
      if (keptHooks.length > 0) {
        groups[idx] = { ...g, hooks: keptHooks }
      } else {
        groups.splice(idx, 1)
        idx--
        removedGroups++
      }
    }
    for (const matcher of CODEX_MATCHERS) {
      if (groupHasTokenGoat(groups, matcher, (c) => c === expectedCommand)) continue

      // A marker-matched entry whose baked command text is no longer current (stale execPath/entry path from a deleted dev checkout or a node version switch) is not "already installed" -- strip it before writing the current command, so a re-install upgrades in place instead of leaving a dead, unreachable entry next to nothing.
      const nextGroups = stripStaleGroupHooks(groups, isCodexTokenGoatCommand, { matcher })
      groups.length = 0
      groups.push(...nextGroups)

      groups.push({ matcher, hooks: [{ type: 'command', command: expectedCommand }] })
      hooksChanged = true
    }
    hooks[event] = groups
  }

  for (const event of CODEX_GLOBAL_HOOK_EVENTS) {
    const eventArg = CODEX_GLOBAL_EVENT_ARG[event]
    const expectedCommand = codexHookCommandFor(scriptPath, eventArg)
    // Same non-array-scalar guard as the matcher-scoped loop above: a foreign or hand-edited config.toml can hold a bare scalar under this key.
    const groups = Array.isArray(hooks[event]) ? [...hooks[event]] : []

    if (anyGroupHasTokenGoat(groups, (c) => c === expectedCommand)) {
      hooks[event] = groups
      continue
    }

    // Same stale-entry handling as the matcher loop above: strip any outdated token-goat entry before writing the current command.
    const nextGroups = stripStaleGroupHooks(groups, isCodexTokenGoatCommand)
    nextGroups.push({ hooks: [{ type: 'command', command: expectedCommand }] })
    hooks[event] = nextGroups
    hooksChanged = true
  }

  const agentsChanged = writeAgentsBlock(agentsPath)

  // Ensure [hooks.state] in config.toml carries the valid trusted_hash for each installed token-goat hook so Codex CLI never prompts or silently skips the hooks as untrusted.
  const hooksState = (hooks['state'] as Record<string, { trusted_hash?: string }> | undefined) ?? {}
  // Drop the trust hashes of exactly the entries the migration cleanup above stripped, so a stale group's old array position never leaves an orphaned key behind for a later, unrelated group to collide with.
  for (const key of staleStateKeysToRemove) {
    if (key in hooksState) {
      delete hooksState[key]
      hooksChanged = true
    }
  }
  for (const event of CODEX_HOOK_EVENTS) {
    const eventArg = CODEX_EVENT_ARG[event]
    const groups = (hooks[event] as CodexMatcherGroup[] | undefined) ?? []
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const g = groups[groupIndex]
      if (g && g.matcher && CODEX_MATCHERS.includes(g.matcher as (typeof CODEX_MATCHERS)[number])) {
        const hookList = g.hooks ?? []
        for (let hookIndex = 0; hookIndex < hookList.length; hookIndex++) {
          const h = hookList[hookIndex]
          if (h && isCodexTokenGoatCommand(h.command)) {
            const stateKey = `${configPath}:${eventArg}:${groupIndex}:${hookIndex}`
            const hash = computeCodexHookHash(eventArg, h.command, g.matcher)
            if (hooksState[stateKey]?.trusted_hash !== hash) {
              hooksState[stateKey] = { ...hooksState[stateKey], trusted_hash: hash }
              hooksChanged = true
            }
          }
        }
      }
    }
  }

  for (const event of CODEX_GLOBAL_HOOK_EVENTS) {
    const eventArg = CODEX_GLOBAL_EVENT_ARG[event]
    const groups = (hooks[event] as CodexMatcherGroup[] | undefined) ?? []
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const g = groups[groupIndex]
      if (!g) continue
      const hookList = g.hooks ?? []
      for (let hookIndex = 0; hookIndex < hookList.length; hookIndex++) {
        const h = hookList[hookIndex]
        if (h && isCodexTokenGoatCommand(h.command)) {
          const stateKey = `${configPath}:${eventArg}:${groupIndex}:${hookIndex}`
          const hash = computeCodexHookHash(eventArg, h.command)
          if (hooksState[stateKey]?.trusted_hash !== hash) {
            hooksState[stateKey] = { ...hooksState[stateKey], trusted_hash: hash }
            hooksChanged = true
          }
        }
      }
    }
  }

  if (Object.keys(hooksState).length > 0) {
    hooks['state'] = hooksState
  }

  if (hooksChanged) {
    config.hooks = hooks
    ensureDirSync(path.dirname(configPath))
    backupFile(configPath)
    // Append a delimited block to the user's own text rather than re-serializing the file, which would drop every comment in it; the whole-file rewrite is the fallback for a layout the append cannot express.
    const before = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : ''
    writeConfigText(configPath, appendManagedBlock(before, config) ?? stringify(config as Record<string, unknown>))
  }

  return {
    configPath,
    agentsPath,
    hookScriptPath: scriptPath,
    alreadyInstalled: !hooksChanged && !agentsChanged,
  }
}

/** Remove the Codex CLI integration: strips only token-goat's own hook entries from `config.toml` (preserving any other hooks/keys), strips the delimited block from `AGENTS.md` (preserving any other content), and removes the hook shim script. Returns true when at least one of the three was present and removed; false when nothing was installed (no writes occur in that case). */
export function uninstallCodex(): boolean {
  const configPath = codexConfigPath()
  const agentsPath = codexAgentsPath()
  const scriptPath = codexHookScriptPath()

  let removedAny = false

  // Strict, as install reads it: a file that is there but cannot be read or parsed may still wire hooks that run the shim, so uninstall stops here with the file, the shim, the AGENTS.md block and the file's backups as they were, rather than read it as holding no hooks and delete what those hooks run.
  const config = readCodexConfig(configPath, { strict: true, command: 'uninstall' })
  const hooks = config.hooks
  // Set when the config is rewritten from the parsed data, which loses comments: the pre-install backup is then the only copy of them and must stay.
  let keepBackups = false
  if (hooks !== undefined) {
    // Planned from the config as read, before the strip moves any group.
    const plan = planStateCleanup(configPath, structuredClone(hooks) as Record<string, unknown>)
    const hooksRemoved = stripOwnHooksFromMap(hooks, isCodexTokenGoatCommand)
    // Only token-goat's own trust entries go: the ones keyed to a group just stripped, or whose hash is of a token-goat command. A user's own entries stay, renamed where the strip moved their group.
    const hooksState = hooks['state'] as Record<string, unknown> | undefined
    let stateChanged = false
    if (hooksState && typeof hooksState === 'object') {
      const kept: Array<[string, unknown]> = []
      const moved: Array<[string, unknown]> = []
      for (const [key, value] of Object.entries(hooksState)) {
        const hash = (value as { trusted_hash?: unknown } | null)?.trusted_hash
        if (plan.ownKeys.has(key) || (typeof hash === 'string' && plan.ownHashes.has(hash))) {
          stateChanged = true
          continue
        }
        const next = plan.rekey.get(key)
        if (next === undefined) kept.push([key, value])
        else {
          moved.push([next, value])
          stateChanged = true
        }
      }
      for (const k of Object.keys(hooksState)) delete hooksState[k]
      for (const [k, v] of [...kept, ...moved]) hooksState[k] = v
      if (Object.keys(hooksState).length === 0) {
        delete hooks['state']
      }
    }
    if (hooksRemoved || stateChanged) {
      if (Object.keys(hooks).length === 0) {
        delete config.hooks
      } else {
        config.hooks = hooks
      }
      backupFile(configPath)
      const before = fs.readFileSync(configPath, 'utf8')
      const text = removeManagedBlockText(before, config, plan.rekey)
      if (text === undefined) {
        // A file that stringify(parse()) reproduces exactly has no comments or layout to lose.
        try {
          keepBackups = stringify(parse(before) as Record<string, unknown>) !== before
        } catch {
          keepBackups = true
        }
      }
      writeConfigText(configPath, text ?? stringify(config as Record<string, unknown>))
      removedAny = true
    }
  }

  if (stripAgentsBlock(agentsPath)) {
    removedAny = true
  }

  for (const p of [scriptPath, codexLegacyHookScriptPath()]) {
    try {
      fs.unlinkSync(p)
      removedAny = true
    } catch {
      // Already absent; nothing to remove.
    }
  }

  // The timestamped backups of this config are token-goat's own litter, so they leave with it.
  if (!keepBackups) removeCreatedBackups(configPath)
  removeCreatedTree(codexArtifactPaths())

  return removedAny
}

/** Every token-goat hook entry in Codex's config.toml, split the way the shell Codex runs it in would (PowerShell on Windows, sh elsewhere), and whether it is a command this build writes. Empty when nothing is wired or the file does not parse. */
export function wiredCodexHookWords(): WiredHookEntry[] {
  const hooks = readCodexConfig(codexConfigPath()).hooks ?? {}
  const scriptPath = codexHookScriptPath()
  const expected = new Set([...Object.values(CODEX_EVENT_ARG), ...Object.values(CODEX_GLOBAL_EVENT_ARG)].map((arg) => codexHookCommandFor(scriptPath, arg, { sync: false })))
  const out: WiredHookEntry[] = []
  for (const [event, groups] of Object.entries(hooks)) {
    if (event === 'state' || !Array.isArray(groups)) continue
    for (const g of groups) {
      for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
        if (isCodexTokenGoatCommand(h?.command)) out.push({ words: splitHookCommand(h.command, process.platform === 'win32' ? 'powershell' : 'sh'), current: expected.has(h.command) })
      }
    }
  }
  return out
}

/** Is the Codex CLI integration currently present? True only when every (event, matcher) pair carries a token-goat hook entry, the shim script exists on disk, the AGENTS.md delimited block is present, and every hook entry has its trusted_hash recorded under [hooks.state]. A partial install (e.g. config.toml wired but the shim script deleted by hand, or an untrusted/stale hash in hooks.state) reads as not installed, so {@link installCodex} will top up what's missing. */
export function isCodexInstalled(): boolean {
  const configPath = codexConfigPath()
  const config = readCodexConfig(configPath)
  const hooks = config.hooks
  if (hooks === undefined) return false
  const scriptPath = codexHookScriptPath()
  const hooksState = (hooks['state'] as Record<string, { trusted_hash?: string }> | undefined) ?? {}

  for (const event of CODEX_HOOK_EVENTS) {
    const eventArg = CODEX_EVENT_ARG[event]
    const expectedCommand = codexHookCommandFor(scriptPath, eventArg, { sync: false })
    const groups = (hooks[event] as CodexMatcherGroup[] | undefined) ?? []
    for (const matcher of CODEX_MATCHERS) {
      // Locate the entry's real position rather than assuming it sits at CODEX_MATCHERS's own index: a foreign or previous-version group ahead of ours in the array shifts every position, and a state key built from the wrong index never matches what installCodex actually wrote.
      const position = findTokenGoatEntryPosition(groups, matcher, (c) => c === expectedCommand)
      if (position === undefined) return false
      const stateKey = `${configPath}:${eventArg}:${position.groupIndex}:${position.hookIndex}`
      const expectedHash = computeCodexHookHash(eventArg, expectedCommand, matcher)
      if (hooksState[stateKey]?.trusted_hash !== expectedHash) return false
    }
  }
  for (const event of CODEX_GLOBAL_HOOK_EVENTS) {
    const eventArg = CODEX_GLOBAL_EVENT_ARG[event]
    const expectedCommand = codexHookCommandFor(scriptPath, eventArg, { sync: false })
    const groups = (hooks[event] as CodexMatcherGroup[] | undefined) ?? []
    // Same real-position lookup as above, but matcher-blind: a global (matcher-less) event can have a foreign group ahead of ours, so the hardcoded ":0:0" state key was wrong under the same conditions, and both write sides (anyGroupHasTokenGoat and the [hooks.state] loop below it) scan every group regardless of `matcher`, so demanding a matcher-less group here would report not-installed forever for an entry install itself writes and trusts.
    const position = findAnyTokenGoatEntryPosition(groups, (c) => c === expectedCommand)
    if (position === undefined) return false
    const stateKey = `${configPath}:${eventArg}:${position.groupIndex}:${position.hookIndex}`
    const expectedHash = computeCodexHookHash(eventArg, expectedCommand)
    if (hooksState[stateKey]?.trusted_hash !== expectedHash) return false
  }
  if (!fs.existsSync(scriptPath)) return false

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
  return buildGuidanceBlock({
    beginMarker: AGENTS_BEGIN,
    endMarker: AGENTS_END,
    fallbackToolClause:
      "Codex's native `exec`, `apply_patch`, and `view_image` tools (shell commands like `cat`/`type` run inside `exec`)",
    gdrive: loadConfig().gdrive.enabled,
  })
}

/** Write the delimited block into `p`, preserving everything outside the markers. Returns false (no write) when the file already contains this exact block -- the idempotent re-install case. */
function writeAgentsBlock(p: string): boolean {
  return upsertDelimitedBlock(p, AGENTS_BEGIN, AGENTS_END, buildAgentsBlock())
}

/** Strip the delimited block from `p`, preserving everything outside the markers. */
function stripAgentsBlock(p: string): boolean {
  return stripDelimitedBlock(p, AGENTS_BEGIN, AGENTS_END)
}
