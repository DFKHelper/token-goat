/**
 * Zed context-server installer.
 *
 * Zed's first-party agent (Zed AI) has no hooks API at all -- confirmed against
 * zed-industries/zed#52688, which is still open and unresolved. `context_servers`
 * (MCP) is the *only* integration surface Zed offers, so "Zed support" here means
 * registering token-goat as an MCP context server in Zed's own `settings.json`,
 * not installing hooks the way `../install.ts` and every other bridge in this
 * directory do. There is deliberately no `zed` `HarnessName` (`./types.ts`) and no
 * `BRIDGE_CAPABILITY_MATRIX` row (`../bridges_status.ts`): both track hook-event
 * parity, and Zed implements zero hook events, the same reasoning
 * `tests/guards/windsurf_never_writes_cascade_hooks.test.ts` documents for
 * Windsurf -- unlike Windsurf, though, Zed does get a real install writer here,
 * because `context_servers` is a genuine, working integration surface, just not
 * a hooks one.
 *
 * `context_servers` entries are NOT the `servers`/`type`/`command`/`args` shape
 * `./mcp_servers_json.ts` already writes for VS Code and Visual Studio. Live
 * process-tree tracing against installed Zed 1.19.2 on Windows (`Get-CimInstance
 * Win32_Process`, since Zed is a native GPUI app no browser-automation tool can
 * drive) showed Zed shell-executing the configured `command` value through
 * PowerShell then cmd.exe -- `Zed.exe -> pwsh.exe -C <command> -> cmd.exe /c
 * "<command>"` -- rather than an argv[0] `CreateProcess` call, and a real
 * connection producing *zero* log output on success (only a broken command logs:
 * `ERROR [project::context_server_store] ... context server failed to start:
 * Context server request timeout`, reproduced twice with different server names
 * as this file's positive control). A working `.cmd` shim wrapping
 * `node.exe <dist/token-goat.mjs> mcp-serve` and set as a bare `command` string
 * was confirmed live: the traced process tree showed a genuinely connected,
 * long-running `node.exe ... mcp-serve` descendant of the real `Zed.exe`,
 * surviving well past both the reliable 10-second failure-timeout control and
 * the configured 30-second timeout with no error logged. Given that, this
 * bridge only ever relies on two keys per the task's own constraint --
 * `command` (the shim's absolute path) and `timeout` -- and never a nested
 * `args` array, which was never confirmed to exist in Zed's schema.
 *
 * The shim is a generated file living inside Zed's own config directory
 * (mirrors `./grok_install.ts`'s `~/.grok/hooks/token-goat-shim.js`), because
 * embedding a full quoted command line as a single shell-executed string is
 * fragile once a path contains spaces -- a wrapper script sidesteps that the
 * same way it does for every other host in this codebase that shells out a
 * `command`-type field.
 *
 * Zed's settings.json path: `%APPDATA%\Zed\settings.json` on Windows, confirmed
 * live (a loud-channel invalid-JSON probe against that exact path, with a
 * silent calibration control at `%LOCALAPPDATA%\Zed\settings.json` proving the
 * probe method itself is not silently vacuous). The macOS/Linux path
 * (`~/.config/zed/settings.json`, honoring `$XDG_CONFIG_HOME`) is FORMAT-DERIVED
 * from Zed's own published docs (https://zed.dev/docs/configuring-zed -- "the
 * configuration file ... is located at `~/.config/zed/settings.json`", Windows
 * separately documented as `%APPDATA%\Zed\settings.json`), not dogfooded: only
 * Windows Zed was installed and testable here.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { recordCreatedConfig, takeCreatedConfig } from './created_configs.js'
import { bundledCliPath, dropEmptyServers, hasManagedServer, readServersJson, serversOf, setTokenGoatServer } from './mcp_servers_json.js'
import { atomicWriteText, writeIfDifferent } from '../util.js'

const CONTEXT_SERVERS_KEY = 'context_servers'
const TOKEN_GOAT_ENTRY_KEY = 'token-goat'

/** How long Zed waits for the context server's `initialize` handshake before logging a timeout and giving up; matches the value dogfooded live above. */
const ZED_TIMEOUT_MS = 30_000

/**
 * Zed's own config directory, mirroring how `./vscode_install.ts` resolves VS
 * Code's: `%APPDATA%\Zed` on Windows (confirmed live), `~/.config/zed`
 * elsewhere (FORMAT-DERIVED from https://zed.dev/docs/configuring-zed, honoring
 * `$XDG_CONFIG_HOME` when set, same as Zed's own Rust `paths` crate does).
 * Reads `process.env['APPDATA']`/`process.env['XDG_CONFIG_HOME']` directly
 * (not hardcoded) so tests and dogfooding can isolate it the same way every
 * other bridge here isolates `HOME`/`APPDATA`/`LOCALAPPDATA`.
 */
function zedConfigDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA']
    const base = appData !== undefined && appData.trim() !== '' ? appData : path.join(os.homedir(), 'AppData', 'Roaming')
    return path.join(base, 'Zed')
  }
  const xdgConfig = process.env['XDG_CONFIG_HOME']
  const base = xdgConfig !== undefined && xdgConfig.trim() !== '' ? xdgConfig : path.join(os.homedir(), '.config')
  return path.join(base, 'zed')
}

/** Absolute path to Zed's `settings.json`. */
export function zedSettingsPath(): string {
  return path.join(zedConfigDir(), 'settings.json')
}

/** Absolute path to the generated shim script Zed's `context_servers.token-goat.command` points at: `.cmd` on Windows (dogfooded), `.sh` elsewhere. */
export function zedShimPath(): string {
  return path.join(zedConfigDir(), process.platform === 'win32' ? 'token-goat-mcp.cmd' : 'token-goat-mcp.sh')
}

/** Builds the shim script content for the current platform, invoking the same absolute Node binary + bundle path `managedServer()` (`./mcp_servers_json.ts`) uses for VS Code/Visual Studio, since Zed's `command` field is a single shell-executed string rather than a `command`+`args` pair. */
function buildShimScript(): string {
  const nodePath = process.execPath
  const cliPath = bundledCliPath()
  if (process.platform === 'win32') {
    return `@echo off\r\n"${nodePath}" "${cliPath}" mcp-serve\r\n`
  }
  return `#!/bin/sh\nexec "${nodePath}" "${cliPath}" mcp-serve\n`
}

/** The `context_servers.token-goat` entry token-goat writes: only `command` and `timeout`, per this file's header docblock. */
export function zedManagedServer(): { command: string; timeout: number } {
  return { command: zedShimPath(), timeout: ZED_TIMEOUT_MS }
}

/** True for an entry token-goat wrote: `command` pointing at our own generated shim path, `timeout` a number. */
export function isZedManagedServer(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return entry['command'] === zedShimPath() && typeof entry['timeout'] === 'number'
}

/** Outcome of an {@link installZed} call. */
export interface ZedInstallResult {
  readonly settingsPath: string
  readonly shimPath: string
  /** True when the shim and the settings.json entry were both already up to date (no write needed). */
  readonly alreadyInstalled: boolean
}

/**
 * Install the Zed MCP context-server integration: writes the generated shim
 * script and merges `context_servers.token-goat` into `settings.json`,
 * preserving every other key, comment, and formatting choice already there
 * (via `setTokenGoatServer`'s JSONC-preserving edit). Idempotent: a second
 * call reports `alreadyInstalled: true` and does not duplicate the entry.
 *
 * Throws before any write if `settings.json` exists but fails to parse, or if
 * it already holds a `context_servers.token-goat` entry this bridge did not
 * write (mirrors `installGemini`'s `GeminiSettingsParseError` guard and
 * `installVscode`'s cross-entry-ownership check) -- a real user file that may
 * already have content is never silently clobbered.
 */
export function installZed(): ZedInstallResult {
  const settingsPath = zedSettingsPath()
  const shimPath = zedShimPath()

  const shimChanged = writeIfDifferent(shimPath, buildShimScript())
  if (process.platform !== 'win32') fs.chmodSync(shimPath, 0o755)

  const fileExisted = fs.existsSync(settingsPath)
  const config = readServersJson(settingsPath, 'Zed')
  const current = serversOf(config, settingsPath, 'Zed', CONTEXT_SERVERS_KEY)[TOKEN_GOAT_ENTRY_KEY]
  if (current !== undefined && !isZedManagedServer(current)) {
    throw new Error(`Zed settings.json already has a "${TOKEN_GOAT_ENTRY_KEY}" context server entry token-goat did not write, at ${settingsPath}; remove it manually first`)
  }

  const desired = zedManagedServer()
  const alreadyInstalled = current !== undefined && !shimChanged
  if (!alreadyInstalled) {
    const nextText = setTokenGoatServer(config.text, desired, CONTEXT_SERVERS_KEY)
    if (!fileExisted) recordCreatedConfig(settingsPath)
    atomicWriteText(settingsPath, nextText)
  }

  return { settingsPath, shimPath, alreadyInstalled }
}

/**
 * Remove the Zed MCP context-server integration: drops
 * `context_servers.token-goat` (and the now-empty `context_servers` object, if
 * it was the last entry) from `settings.json`, deletes `settings.json` itself
 * only if token-goat created it AND it now holds nothing else, and deletes the
 * generated shim script. Returns true when at least one of the entry or the
 * shim was present and removed; false when nothing was installed (no writes
 * occur in that case).
 */
export function uninstallZed(): boolean {
  const settingsPath = zedSettingsPath()
  const shimPath = zedShimPath()

  let entryRemoved = false
  if (fs.existsSync(settingsPath)) {
    const config = readServersJson(settingsPath, 'Zed')
    if (isZedManagedServer(serversOf(config, settingsPath, 'Zed', CONTEXT_SERVERS_KEY)[TOKEN_GOAT_ENTRY_KEY])) {
      const next = dropEmptyServers(setTokenGoatServer(config.text, undefined, CONTEXT_SERVERS_KEY), CONTEXT_SERVERS_KEY)
      if (/^\s*\{\s*\}\s*$/.test(next) && takeCreatedConfig(settingsPath)) {
        fs.rmSync(settingsPath, { force: true })
      } else {
        atomicWriteText(settingsPath, next)
      }
      entryRemoved = true
    }
  }

  const shimRemoved = fs.existsSync(shimPath)
  if (shimRemoved) fs.rmSync(shimPath, { force: true })

  return entryRemoved || shimRemoved
}

/** Whether Zed's `settings.json` currently holds a token-goat-managed `context_servers` entry. */
export function isZedInstalled(): boolean {
  return hasManagedServer(zedSettingsPath(), 'Zed', CONTEXT_SERVERS_KEY, isZedManagedServer)
}

/**
 * Reads back the token-goat `context_servers` entry from `settingsPath`, for `../cli_doctor.ts`'s
 * staleness check -- mirrors `../bridges/visualstudio_install.ts`'s `visualStudioManagedEntry`.
 * Returns `null` when the file is missing, unreadable, or holds no token-goat-managed entry.
 */
export function zedManagedEntry(settingsPath: string): { command: string } | null {
  if (!fs.existsSync(settingsPath)) return null
  try {
    const entry = serversOf(readServersJson(settingsPath, 'Zed'), settingsPath, 'Zed', CONTEXT_SERVERS_KEY)[TOKEN_GOAT_ENTRY_KEY]
    if (!isZedManagedServer(entry)) return null
    return { command: (entry as { command: string }).command }
  } catch {
    return null
  }
}
