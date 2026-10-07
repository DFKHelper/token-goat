/** Antigravity CLI (`agy`) hook integration. agy loads hooks from three places -- a global `~/.gemini/config/hooks.json`, a workspace `.agents/hooks.json`, and plugins -- and this bridge uses the third one only: a plugin directory of its own, `~/.gemini/config/plugins/token-goat/`, holding `plugin.json` (the marker agy requires before it treats a directory as a plugin) and `hooks.json`. The global hooks file is the user's and other tools' (orca-status writes there), so token-goat never edits it; its own plugin directory can be created and taken away whole. Plugins are enabled by default; a user who turned this one off in `~/.gemini/config/config.json` keeps it off, because that file is not touched either. agy's `hooks.json` is keyed by hook name, then event (FORMAT-DERIVED from atamel.dev's "Where agy hooks" and CAPTURE on agy 1.2.11: `{ "<name>": { "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command", "timeout" }] }] } }`). Only PreToolUse and PostToolUse are wired: they are the two events whose payloads normalizePayload (hooks_cli.ts) maps onto token-goat's canonical shape, and serializeAntigravityOutput (antigravity_hooks.ts) the two it answers. The command form on Windows is the part a live probe settled. agy runs a hook through `cmd /c` with the plugin directory as the working directory, and a quoted path inside the command string does not survive: Go escapes each `"` as `\"`, which cmd does not unescape, so `"C:\Program Files\nodejs\node.exe" ...` fails and every hook with a space anywhere in its node or entry path silently never runs. A bare `token-goat-hook.cmd` fails too, because `NoDefaultCurrentDirectoryInExePath` stops cmd searching the working directory for a bare name. `.\token-goat-hook.cmd <event>` works in both cases (CAPTURE: agy 1.2.11 on Windows, a plugin directory whose path contains a space), and quotes inside a `.cmd` file are ordinary batch quoting, so the shim carries the absolute, quoted node and entry paths the command string cannot. Elsewhere agy runs the command through `sh -c`, where quoteShellPath's double quotes are fine and no shim is needed. */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { atomicWriteText, extractErrorMessage, quoteShellPath, writeJsonSettings } from '../util.js'

import { ensureDirRecordingCreation, hasCreatedConfig, recordCreatedConfig, removeCreatedBackups, removeCreatedIfEmpty, takeCreatedConfig } from './created_configs.js'
import { stripBom } from '../jsonc_text.js'
import { echoedValue } from '../hint_suggestion_guard.js'

/** The hook name token-goat's entries live under in its plugin's hooks.json; any other name there is left alone. */
const HOOK_NAME = 'token-goat'
const PLUGIN_DIR_NAME = 'token-goat'
const SHIM_FILE = 'token-goat-hook.cmd'
const HOOK_TIMEOUT_SECONDS = 30
/** Present in every shim this bridge writes, and in nothing a user would plausibly write: what lets uninstall delete the shim and not a same-named file of someone else's. */
const SHIM_MARKER = '--harness antigravity'

const ANTIGRAVITY_HOOK_EVENTS = ['PreToolUse', 'PostToolUse'] as const
type AntigravityHookEvent = (typeof ANTIGRAVITY_HOOK_EVENTS)[number]

const ANTIGRAVITY_EVENT_ARG: Record<AntigravityHookEvent, string> = {
  PreToolUse: 'pre_tool_use',
  PostToolUse: 'post_tool_use',
}

type AntigravityHooksFile = Record<string, unknown>

export class AntigravitySettingsParseError extends Error {}

function geminiDir(): string {
  return path.join(os.homedir(), '.gemini')
}

function geminiConfigDir(): string {
  return path.join(geminiDir(), 'config')
}

/** `~/.gemini/config/plugins/`, agy's global plugin directory. */
export function antigravityPluginsDir(): string {
  return path.join(geminiConfigDir(), 'plugins')
}

/** `~/.gemini/config/plugins/token-goat/`, the plugin directory this bridge owns. */
export function antigravityPluginDir(): string {
  return path.join(antigravityPluginsDir(), PLUGIN_DIR_NAME)
}

export function antigravityHooksPath(): string {
  return path.join(antigravityPluginDir(), 'hooks.json')
}

function pluginManifestPath(): string {
  return path.join(antigravityPluginDir(), 'plugin.json')
}

function shimPath(): string {
  return path.join(antigravityPluginDir(), SHIM_FILE)
}

function readJsonObject(p: string, label: string, opts: { strict?: boolean; command?: 'install' | 'uninstall' } = {}): AntigravityHooksFile | undefined {
  const refuse = (problem: string, detail?: string): AntigravitySettingsParseError =>
    new AntigravitySettingsParseError(
      (opts.command === 'uninstall'
        ? `Antigravity ${label} ${echoedValue(p)} is unreadable: it ${problem}. Uninstall left it and its backups untouched; fix the file and run uninstall again.`
        : `Antigravity ${label} ${echoedValue(p)} ${problem}. Fix or back up the file before running install.`) + (detail === undefined ? '' : ` (${detail})`),
    )
  let raw: string
  try {
    raw = fs.readFileSync(p, 'utf8')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    // Only an absent file is the "nothing installed yet" case; see install.ts's readSettings.
    if (opts.strict === true && code !== 'ENOENT' && code !== 'ENOTDIR') throw refuse('exists but cannot be read', code ?? extractErrorMessage(e))
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stripBom(raw))
  } catch (e) {
    if (opts.strict === true) throw refuse('exists but contains invalid JSON', extractErrorMessage(e))
    return undefined
  }
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as AntigravityHooksFile
  if (opts.strict === true) throw refuse('does not contain a JSON object at the top level')
  return undefined
}

/** Batch-file contents of the Windows shim. `%` is doubled because cmd expands `%name%` inside a batch file even between quotes, so a path holding a literal `%` would otherwise be rewritten before node ever saw it. CRLF because cmd's parser is line-based on CRLF and mis-reads labels and continuations in an LF-only batch file. */
function shimContent(): string {
  const entryPath = process.argv[1]
  const escape = (value: string): string => quoteShellPath(value).replace(/%/g, '%%')
  const invocation = entryPath ? `${escape(process.execPath)} ${escape(entryPath)}` : 'token-goat'
  return `@${invocation} hook %1 ${SHIM_MARKER}\r\n@exit /b %ERRORLEVEL%\r\n`
}

/** The command string written into hooks.json for `eventArg`. Windows: the relative shim, for the reasons in the file comment. Elsewhere: the absolute node and entry paths, same robustness rationale as qwenHookCommand -- no assumption that `token-goat` resolves on agy's subprocess PATH. `--harness antigravity` travels as a flag because agy sets no env var detectHarness() could read that the parent session's own vars do not shadow: its hooks inherit the launching shell's CLAUDE_CODE_* variables (CAPTURE, agy 1.2.11). */
export function antigravityHookCommand(eventArg: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return `.\\${SHIM_FILE} ${eventArg}`
  const entryPath = process.argv[1]
  if (!entryPath) return `token-goat hook ${eventArg} ${SHIM_MARKER}`
  return `${quoteShellPath(process.execPath)} ${quoteShellPath(entryPath)} hook ${eventArg} ${SHIM_MARKER}`
}

function desiredHookEntry(): Record<AntigravityHookEvent, unknown[]> {
  const entry = {} as Record<AntigravityHookEvent, unknown[]>
  for (const event of ANTIGRAVITY_HOOK_EVENTS) {
    entry[event] = [{ matcher: '*', hooks: [{ type: 'command', command: antigravityHookCommand(ANTIGRAVITY_EVENT_ARG[event]), timeout: HOOK_TIMEOUT_SECONDS }] }]
  }
  return entry
}

function readShim(): string | undefined {
  try {
    return fs.readFileSync(shimPath(), 'utf8')
  } catch {
    return undefined
  }
}

interface AntigravityInstallResult {
  readonly pluginDir: string
  /** True when the plugin manifest, hooks entry and (on Windows) shim were all already current: nothing was written. */
  readonly alreadyInstalled: boolean
}

export function installAntigravity(): AntigravityInstallResult {
  const pluginDir = antigravityPluginDir()
  const hooksPath = antigravityHooksPath()
  const manifestPath = pluginManifestPath()
  // Both reads strict and both before any write: a hooks.json or plugin.json that is there but unreadable aborts the install with nothing on disk changed.
  const hooksFile = readJsonObject(hooksPath, 'plugin hooks file', { strict: true, command: 'install' })
  const manifest = readJsonObject(manifestPath, 'plugin manifest', { strict: true, command: 'install' })

  let changed = false
  // Each level recorded separately, outermost first: on a machine with no agy, install creates all four and uninstall takes back whichever of them are left empty, rather than leaving a bare `~/.gemini/config` behind.
  for (const dir of [geminiDir(), geminiConfigDir(), antigravityPluginsDir(), pluginDir]) ensureDirRecordingCreation(dir)

  if (manifest === undefined) {
    writeJsonSettings(manifestPath, { name: PLUGIN_DIR_NAME })
    recordCreatedConfig(manifestPath)
    changed = true
  }

  if (process.platform === 'win32') {
    const content = shimContent()
    const existing = readShim()
    if (existing !== content) {
      atomicWriteText(shimPath(), content)
      if (existing === undefined) recordCreatedConfig(shimPath())
      changed = true
    }
  }

  const desired = desiredHookEntry()
  const current = hooksFile?.[HOOK_NAME]
  if (JSON.stringify(current) !== JSON.stringify(desired)) {
    writeJsonSettings(hooksPath, { ...(hooksFile ?? {}), [HOOK_NAME]: desired })
    if (hooksFile === undefined) recordCreatedConfig(hooksPath)
    changed = true
  }

  return { pluginDir, alreadyInstalled: !changed }
}

export function uninstallAntigravity(): boolean {
  const pluginDir = antigravityPluginDir()
  const hooksPath = antigravityHooksPath()
  const manifestPath = pluginManifestPath()
  // Strict, as install reads it: a hooks file that is there but cannot be parsed may still hold token-goat's entry, so uninstall stops with it and its backups as they were.
  const hooksFile = readJsonObject(hooksPath, 'plugin hooks file', { strict: true, command: 'uninstall' })

  let removed = false
  if (hooksFile !== undefined && Object.prototype.hasOwnProperty.call(hooksFile, HOOK_NAME)) {
    const rest = { ...hooksFile }
    delete rest[HOOK_NAME]
    removed = true
    // Deleted only when nothing else is left in it AND token-goat created it; a hooks.json that was already there keeps its remaining (possibly empty) object.
    if (Object.keys(rest).length === 0 && takeCreatedConfig(hooksPath)) {
      fs.unlinkSync(hooksPath)
    } else {
      writeJsonSettings(hooksPath, rest)
    }
  }
  removeCreatedBackups(hooksPath)

  const shim = readShim()
  if (shim?.includes(SHIM_MARKER) === true) {
    fs.unlinkSync(shimPath())
    takeCreatedConfig(shimPath())
    removed = true
  }

  // plugin.json goes only when token-goat wrote it and it still says exactly what token-goat wrote: once hooks.json is gone a leftover manifest names a plugin with nothing in it, but a user's own manifest in this directory is theirs.
  const manifest = readJsonObject(manifestPath, 'plugin manifest')
  if (manifest !== undefined && hasCreatedConfig(manifestPath) && JSON.stringify(manifest) === JSON.stringify({ name: PLUGIN_DIR_NAME }) && !fs.existsSync(hooksPath)) {
    fs.unlinkSync(manifestPath)
    takeCreatedConfig(manifestPath)
    removed = true
  }
  removeCreatedBackups(manifestPath)

  for (const dir of [pluginDir, antigravityPluginsDir(), geminiConfigDir(), geminiDir()]) removeCreatedIfEmpty(dir)
  return removed
}

/** Whether any of token-goat's footprint is still in the plugin directory: its hooks.json entry, current or not, or its shim. Presence rather than currency, because the one caller (leftoverIntegrations) asks "would `uninstall --antigravity` remove something", and a stale entry from an older token-goat is exactly what it would. */
export function isAntigravityInstalled(): boolean {
  const hooksFile = readJsonObject(antigravityHooksPath(), 'plugin hooks file')
  if (hooksFile !== undefined && Object.prototype.hasOwnProperty.call(hooksFile, HOOK_NAME)) return true
  return readShim()?.includes(SHIM_MARKER) === true
}
