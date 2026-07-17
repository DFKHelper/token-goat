/**
 * OpenClaw install / uninstall writer.
 *
 * `token-goat install --openclaw` drops the bridge plugin file
 * (`./openclaw.js`'s {@link OPENCLAW_PLUGIN_SCRIPT}) and registers it in
 * `~/.openclaw/openclaw.json`, in addition to the base Claude Code install
 * (see README's "openclaw users" section). This module only ever touches
 * those two paths -- the base Claude Code writer in `../install.ts` is
 * unaffected and is always run separately by the caller, exactly like every
 * other bridge installer in this directory.
 *
 * Unlike opencode/pi (auto-discovered by directory convention, nothing to
 * register) and unlike Gemini/Codex (a single settings file, no separate
 * plugin file to drop), OpenClaw needs both halves: a dropped `.ts` file *and*
 * a config entry pointing at it. Per a live fetch of
 * docs.openclaw.ai/gateway/configuration-reference (this session), the
 * current schema is two-part:
 *   - `plugins.load.paths`: an array of standalone plugin file paths OpenClaw
 *     auto-loads (confirmed a single `.ts` file works here with no
 *     `package.json`/manifest required).
 *   - `plugins.entries.<id>`: `{enabled, config, env, hooks}` -- no `path`
 *     field; the plugin's own `definePluginEntry({id: "token-goat", ...})`
 *     declaration is what `<id>` joins against.
 * A corrupt-but-recoverable `openclaw.json` (exists but fails to parse) must
 * never be silently clobbered -- {@link installOpenclaw} throws
 * {@link OpenclawConfigParseError} before any write in that case, mirroring
 * `GeminiSettingsParseError` in `./gemini_install.ts` / `SettingsParseError`
 * in `../install.ts`.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { atomicWriteText, ensureDirSync, extractErrorMessage, foldPath, writeJsonSettings } from '../util.js'
import { OPENCLAW_PLUGIN_SCRIPT } from './openclaw.js'

interface OpenclawPluginEntry {
  enabled?: boolean
  config?: unknown
  env?: unknown
  hooks?: unknown
}

interface OpenclawPlugins {
  load?: { paths?: string[] }
  entries?: Record<string, OpenclawPluginEntry>
}

interface OpenclawSettings {
  plugins?: OpenclawPlugins
  [key: string]: unknown
}

export class OpenclawConfigParseError extends Error {}

const OPENCLAW_PLUGIN_ID = 'token-goat'

function openclawHomeDir(): string {
  return path.join(os.homedir(), '.openclaw')
}

export function openclawConfigPath(): string {
  return path.join(openclawHomeDir(), 'openclaw.json')
}

export function openclawPluginPath(): string {
  return path.join(openclawHomeDir(), 'plugins', 'token-goat.ts')
}

/**
 * Sidecar JSON file, written next to the plugin, carrying the absolute path
 * to the token-goat CLI entry that was running at install time (`process.argv[1]`).
 * The plugin has no per-invocation command line to bake this into the way
 * Codex/Copilot's generated hook commands do (OpenClaw loads it once as a
 * module), so `callHook`'s `resolveEntryPath()` reads this file at runtime
 * instead, to invoke that entry directly via `process.execPath` rather than
 * depending on PATH resolution for a bare `token-goat` lookup (mirrors
 * `piEntrySidecarPath` in `./pi_install.js`).
 */
export function openclawEntrySidecarPath(): string {
  return path.join(path.dirname(openclawPluginPath()), 'token-goat-entry.json')
}

function readOpenclawConfig(p: string, opts: { strict?: boolean } = {}): OpenclawSettings {
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
      throw new OpenclawConfigParseError(
        `OpenClaw config file '${p}' exists but contains invalid JSON. Fix or back up the file before running install. (${extractErrorMessage(e)})`,
      )
    }
    return {}
  }
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    return parsed as OpenclawSettings
  }
  if (opts.strict === true) {
    throw new OpenclawConfigParseError(
      `OpenClaw config file '${p}' does not contain a JSON object at the top level. Fix or back up the file before running install.`,
    )
  }
  return {}
}


export interface OpenclawInstallResult {
  readonly configPath: string
  readonly pluginPath: string
  /** True when both the plugin file and the config entry were already present (no write needed). */
  readonly alreadyInstalled: boolean
}

export function installOpenclaw(): OpenclawInstallResult {
  const configPath = openclawConfigPath()
  const pluginPath = openclawPluginPath()

  let existingPlugin: string | undefined
  try {
    existingPlugin = fs.readFileSync(pluginPath, 'utf8')
  } catch {
    existingPlugin = undefined
  }
  const pluginChanged = existingPlugin !== OPENCLAW_PLUGIN_SCRIPT

  // strict: true -- a config file that exists but fails to parse must abort
  // before any write, not silently proceed as if it were empty and get
  // clobbered below. Must run before the sidecar write below: writing the
  // sidecar unconditionally, then aborting on a corrupt config, would leave
  // a stray token-goat-entry.json behind despite the install as a whole
  // having failed and the plugin config never having been touched.
  const settings = readOpenclawConfig(configPath, { strict: true })

  // process.argv[1] is the absolute path to whichever token-goat entry point
  // launched this install run. Written unconditionally on every successful
  // run past the strict parse above (even when the plugin itself is already
  // up to date) so re-running install after moving/upgrading the token-goat
  // install refreshes a stale sidecar too.
  const entryPath = process.argv[1]
  if (entryPath) {
    ensureDirSync(path.dirname(pluginPath))
    atomicWriteText(openclawEntrySidecarPath(), JSON.stringify({ entryPath }))
  }

  const plugins: OpenclawPlugins = settings.plugins ?? {}
  const loadPaths = [...(plugins.load?.paths ?? [])]
  const entries = { ...(plugins.entries ?? {}) }

  let configChanged = false
  if (!loadPaths.some((p) => foldPath(p) === foldPath(pluginPath))) {
    loadPaths.push(pluginPath)
    configChanged = true
  }
  if (entries[OPENCLAW_PLUGIN_ID] === undefined) {
    entries[OPENCLAW_PLUGIN_ID] = { enabled: true }
    configChanged = true
  }

  if (!pluginChanged && !configChanged) {
    return { configPath, pluginPath, alreadyInstalled: true }
  }

  if (pluginChanged) {
    ensureDirSync(path.dirname(pluginPath))
    atomicWriteText(pluginPath, OPENCLAW_PLUGIN_SCRIPT)
  }

  if (configChanged) {
    settings.plugins = { ...plugins, load: { ...plugins.load, paths: loadPaths }, entries }
    writeJsonSettings(configPath, settings)
  }

  return { configPath, pluginPath, alreadyInstalled: false }
}

export function uninstallOpenclaw(): boolean {
  const configPath = openclawConfigPath()
  const pluginPath = openclawPluginPath()

  let removed = false

  try {
    fs.unlinkSync(pluginPath)
    removed = true
  } catch {
    // nothing to remove
  }

  try {
    fs.unlinkSync(openclawEntrySidecarPath())
  } catch {
    // nothing to remove
  }

  const settings = readOpenclawConfig(configPath)
  const plugins = settings.plugins
  if (plugins !== undefined) {
    const loadPaths = plugins.load?.paths
    const entries = plugins.entries

    let configChanged = false

    if (loadPaths !== undefined && loadPaths.some((p) => foldPath(p) === foldPath(pluginPath))) {
      const kept = loadPaths.filter((p) => foldPath(p) !== foldPath(pluginPath))
      if (kept.length > 0) {
        plugins.load = { ...plugins.load, paths: kept }
      } else if (plugins.load !== undefined) {
        delete plugins.load.paths
        if (Object.keys(plugins.load).length === 0) delete plugins.load
      }
      configChanged = true
      removed = true
    }

    if (entries !== undefined && entries[OPENCLAW_PLUGIN_ID] !== undefined) {
      delete entries[OPENCLAW_PLUGIN_ID]
      if (Object.keys(entries).length === 0) delete plugins.entries
      configChanged = true
      removed = true
    }

    if (configChanged) {
      if (Object.keys(plugins).length === 0) {
        delete settings.plugins
      } else {
        settings.plugins = plugins
      }
      writeJsonSettings(configPath, settings)
    }
  }

  return removed
}

export function isOpenclawInstalled(): boolean {
  if (!fs.existsSync(openclawPluginPath())) return false
  const settings = readOpenclawConfig(openclawConfigPath())
  const plugins = settings.plugins
  if (plugins === undefined) return false
  const targetFolded = foldPath(openclawPluginPath())
  const hasPath = (plugins.load?.paths ?? []).some((p) => foldPath(p) === targetFolded)
  const hasEntry = plugins.entries?.[OPENCLAW_PLUGIN_ID] !== undefined
  return hasPath && hasEntry
}
