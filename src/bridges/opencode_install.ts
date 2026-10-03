/** opencode install / uninstall writer. `token-goat install --opencode` drops a TypeScript plugin file for opencode in addition to the base Claude Code install (see README's "opencode users" section: "The `--opencode` flag patches Claude Code and drops a TypeScript bridge plugin into opencode's plugins directory -- one command, no separate base install"). This module only ever touches the one plugin file path below, plus the copy an older token-goat left at the wrong Windows path -- the base Claude Code writer in `../install.ts` is unaffected and is always run separately by the caller, exactly like `../bridges/codex_install.ts`'s `installCodex` and `../bridges/pi_install.ts`'s `installPi`. Single install target: `$XDG_CONFIG_HOME/opencode/plugins/token-goat.ts`, falling back to `~/.config/opencode/plugins/token-goat.ts` when it is unset or blank, on every platform including Windows. opencode resolves its global config/plugin root via `Global.Path.config` (packages/core/src/global.ts), which is `path.join(xdgConfig, "opencode")` using the `xdg-basedir` npm package, and that package has no Windows case: it reads `XDG_CONFIG_HOME` or falls back to `~/.config` everywhere. CAPTURE (Windows 11, opencode 1.18.16, `opencode debug paths`): `config C:\Users\<user>\.config\opencode` with no override and with APPDATA pointed elsewhere, `config <tmp>\xc\opencode` with XDG_CONFIG_HOME=<tmp>\xc. Earlier releases wrote the Windows plugin under `%APPDATA%\opencode\plugins\`, which opencode never loads, so install and uninstall remove that copy on Windows ({@link legacyWindowsPluginPath}). The `XDG_CONFIG_HOME` override is opencode-specific: Codex, Gemini, and pi's writers are all hardcoded to their own tool's conventions with no env-var override, because none of those tools resolve their config root through `xdg-basedir`. README documents only a global install for opencode (no `--local` variant the way pi has one), so this module wires only the one path. Like pi's extension, opencode auto-discovers any file dropped into its plugins directory at startup -- no registration step, no config file to edit (unlike Codex's `config.toml` or Gemini's `settings.json`). So there is nothing to merge into: {@link installOpencode} always overwrites on a genuine content difference (upgraded template, or a user's local edits) with no `.bak` and no confirmation prompt, and skips the write (reporting `alreadyInstalled: true`) when the file on disk is already byte-identical to the current template -- the same reasoning as {@link installPi} in `./pi_install.js`. */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { recordCreatedBy, removeCreatedTree } from './created_configs.js'
import { installSingleFilePlugin, uninstallSingleFilePlugin } from '../util.js'
import { OPENCODE_PLUGIN_SCRIPT } from './opencode.js'

/** Resolves opencode's global config directory, matching `Global.Path.config` (see module doc comment). */
function opencodeGlobalConfigDir(): string {
  const xdgConfigHome = process.env['XDG_CONFIG_HOME']
  if (xdgConfigHome !== undefined && xdgConfigHome.trim() !== '') return xdgConfigHome
  return path.join(os.homedir(), '.config')
}

export function opencodePluginPath(): string {
  return path.join(opencodeGlobalConfigDir(), 'opencode', 'plugins', 'token-goat.ts')
}

/** Sidecar JSON file, written next to the plugin, carrying the absolute path to the token-goat CLI entry that was running at install time (`process.argv[1]`). The plugin has no per-invocation command line to bake this into the way Codex/Copilot's generated hook commands do (opencode loads it once as a module), so `callHook`'s `resolveEntryPath()` reads this file at runtime instead, to invoke that entry directly via `process.execPath` rather than depending on PATH resolution for a bare `token-goat` lookup (mirrors `piEntrySidecarPath` in `./pi_install.js`). */
export function opencodeEntrySidecarPath(): string {
  return path.join(path.dirname(opencodePluginPath()), 'token-goat-entry.json')
}

/** Where an older token-goat wrote the plugin on Windows, on the mistaken belief that xdg-basedir maps to %APPDATA% there. Null off Windows, where nothing was ever written to this location. */
function legacyWindowsPluginPath(): string | null {
  if (process.platform !== 'win32') return null
  const appData = process.env['APPDATA']
  const root = appData !== undefined && appData.trim() !== '' ? appData : path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(root, 'opencode', 'plugins', 'token-goat.ts')
}

/** Removes the plugin and sidecar an older token-goat left under %APPDATA% on Windows; true when the plugin was there. */
function removeLegacyWindowsPlugin(): boolean {
  const legacy = legacyWindowsPluginPath()
  if (legacy === null) return false
  return uninstallSingleFilePlugin(legacy, path.join(path.dirname(legacy), 'token-goat-entry.json'))
}

export interface OpencodeInstallResult {
  readonly pluginPath: string
  /** True when the file on disk was already byte-identical to the current template (no write needed). */
  readonly alreadyInstalled: boolean
}

export function installOpencode(): OpencodeInstallResult {
  const pluginPath = opencodePluginPath()
  const { alreadyInstalled } = recordCreatedBy([pluginPath, opencodeEntrySidecarPath()], () => installSingleFilePlugin(pluginPath, opencodeEntrySidecarPath(), OPENCODE_PLUGIN_SCRIPT))
  removeLegacyWindowsPlugin()
  return { pluginPath, alreadyInstalled }
}

export function uninstallOpencode(): boolean {
  const removedLegacy = removeLegacyWindowsPlugin()
  const removed = uninstallSingleFilePlugin(opencodePluginPath(), opencodeEntrySidecarPath())
  removeCreatedTree([opencodePluginPath(), opencodeEntrySidecarPath()])
  return removed || removedLegacy
}

export function isOpencodeInstalled(): boolean {
  return fs.existsSync(opencodePluginPath())
}
