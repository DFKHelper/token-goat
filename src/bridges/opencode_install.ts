/**
 * opencode install / uninstall writer.
 *
 * `token-goat install --opencode` drops a TypeScript plugin file for opencode
 * in addition to the base Claude Code install (see README's "opencode users"
 * section: "The `--opencode` flag patches Claude Code and drops a TypeScript
 * bridge plugin into opencode's plugins directory -- one command, no separate
 * base install"). This module only ever touches the one plugin file path
 * below -- the base Claude Code writer in `../install.ts` is unaffected and is
 * always run separately by the caller, exactly like
 * `../bridges/codex_install.ts`'s `installCodex` and `../bridges/pi_install.ts`'s
 * `installPi`.
 *
 * Single install target: `$XDG_CONFIG_HOME/opencode/plugins/token-goat.ts`
 * (falling back to `~/.config/opencode/plugins/token-goat.ts`) on macOS/Linux,
 * `%APPDATA%\\opencode\\plugins\\token-goat.ts` on Windows. opencode resolves
 * its global config/plugin root via `Global.Path.config`
 * (packages/core/src/global.ts), which is `path.join(xdgConfig, "opencode")`
 * using the `xdg-basedir` npm package -- on Windows that package resolves
 * `xdgConfig` to `process.env.APPDATA` (not `~/.config`), so the Windows path
 * really is APPDATA-rooted, not a Codex/Gemini/pi-style dotfile-under-homedir
 * path; on macOS/Linux it honors `XDG_CONFIG_HOME` per the XDG base
 * directory spec, falling back to `~/.config` when unset or blank; verified
 * directly against opencode's real source (not assumed by analogy with the
 * other bridges) rather than trusting the docs' Unix-only
 * "~/.config/opencode/plugins/" wording at face value. Unlike the Windows
 * `APPDATA` case, this override is opencode-specific: Codex, Gemini, and pi's
 * writers are all hardcoded to their own tool's conventions with no env-var
 * override, because none of those tools resolve their config root through
 * `xdg-basedir`.
 *
 * README documents only a global install for opencode (no `--local` variant
 * the way pi has one), so this module wires only the one path.
 *
 * Like pi's extension, opencode auto-discovers any file dropped into its
 * plugins directory at startup -- no registration step, no config file to
 * edit (unlike Codex's `config.toml` or Gemini's `settings.json`). So there is
 * nothing to merge into: {@link installOpencode} always overwrites on a
 * genuine content difference (upgraded template, or a user's local edits)
 * with no `.bak` and no confirmation prompt, and skips the write (reporting
 * `alreadyInstalled: true`) when the file on disk is already byte-identical to
 * the current template -- the same reasoning as {@link installPi} in
 * `./pi_install.js`.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { atomicWriteText, ensureDirSync } from '../util.js'
import { OPENCODE_PLUGIN_SCRIPT } from './opencode.js'

/** Resolves opencode's global plugin directory, matching `Global.Path.config` (see module doc comment). */
function opencodeGlobalConfigDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA']
    if (appData !== undefined && appData.trim() !== '') return appData
    return path.join(os.homedir(), 'AppData', 'Roaming')
  }
  const xdgConfigHome = process.env['XDG_CONFIG_HOME']
  if (xdgConfigHome !== undefined && xdgConfigHome.trim() !== '') return xdgConfigHome
  return path.join(os.homedir(), '.config')
}

export function opencodePluginPath(): string {
  return path.join(opencodeGlobalConfigDir(), 'opencode', 'plugins', 'token-goat.ts')
}

/**
 * Sidecar JSON file, written next to the plugin, carrying the absolute path
 * to the token-goat CLI entry that was running at install time (`process.argv[1]`).
 * The plugin has no per-invocation command line to bake this into the way
 * Codex/Copilot's generated hook commands do (opencode loads it once as a
 * module), so `callHook`'s `resolveEntryPath()` reads this file at runtime
 * instead, to invoke that entry directly via `process.execPath` rather than
 * depending on PATH resolution for a bare `token-goat` lookup (mirrors
 * `piEntrySidecarPath` in `./pi_install.js`).
 */
export function opencodeEntrySidecarPath(): string {
  return path.join(path.dirname(opencodePluginPath()), 'token-goat-entry.json')
}

export interface OpencodeInstallResult {
  readonly pluginPath: string
  /** True when the file on disk was already byte-identical to the current template (no write needed). */
  readonly alreadyInstalled: boolean
}

export function installOpencode(): OpencodeInstallResult {
  const pluginPath = opencodePluginPath()

  let existing: string | undefined
  try {
    existing = fs.readFileSync(pluginPath, 'utf8')
  } catch {
    existing = undefined
  }

  // process.argv[1] is the absolute path to whichever token-goat entry point
  // launched this install run. Written unconditionally (even when the plugin
  // itself is already up to date) so re-running install after
  // moving/upgrading the token-goat install refreshes a stale sidecar too.
  const entryPath = process.argv[1]
  if (entryPath) {
    ensureDirSync(path.dirname(pluginPath))
    atomicWriteText(opencodeEntrySidecarPath(), JSON.stringify({ entryPath }))
  }

  if (existing === OPENCODE_PLUGIN_SCRIPT) {
    return { pluginPath, alreadyInstalled: true }
  }

  ensureDirSync(path.dirname(pluginPath))
  atomicWriteText(pluginPath, OPENCODE_PLUGIN_SCRIPT)
  return { pluginPath, alreadyInstalled: false }
}

export function uninstallOpencode(): boolean {
  const pluginPath = opencodePluginPath()
  try {
    fs.unlinkSync(opencodeEntrySidecarPath())
  } catch {
    // nothing to remove
  }
  try {
    fs.unlinkSync(pluginPath)
    return true
  } catch {
    return false
  }
}

export function isOpencodeInstalled(): boolean {
  return fs.existsSync(opencodePluginPath())
}
