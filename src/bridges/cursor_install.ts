/**
 * Cursor MCP-server installer.
 *
 * Cursor 3.19.7's own `~/.cursor/hooks.json` is a real, first-class local hook
 * file (unlike Zed, which has none at all -- see `./zed_install.ts`'s header).
 * token-goat still never writes to it, deliberately, for two independent
 * reasons confirmed against the installed 3.19.7 bundle
 * (`resources/app/out/vs/workbench/workbench.desktop.main.js`):
 *
 * 1. Cursor already imports Claude Code's hooks by default. `initialize()`
 *    loads both `~/.cursor/hooks.json` and `~/.claude/settings.json`, and
 *    `isClaudeCodeHooksEnabled(){ return this.thirdPartyExtensibilityObservable
 *    .get() ?? !0 }` backed by a stored default of `thirdPartyExtensibilityEnabled:
 *    Hh(!0)` -- i.e. the import is ON by default, no user action needed. Claude's
 *    PascalCase step names are translated to Cursor's camelCase ones by a fixed
 *    table (`K5i` in the same bundle) before the transformed config is stored, so
 *    a hook token-goat has already written into `~/.claude/settings.json` via the
 *    ordinary `token-goat install` (Claude Code) default reaches Cursor with zero
 *    extra work. token-goat writing a *second*, independently-maintained copy
 *    into `~/.cursor/hooks.json` would only add risk: Cursor's own dedupe
 *    (`_getHookKey`) matches on the raw, untransformed command string, so the
 *    moment the two writers' command text differs by so much as a flag or a
 *    trailing space, every hook fires twice. Relying on two producers staying
 *    byte-identical forever is exactly the brittleness Cursor's own dedupe
 *    author left unaddressed; not writing a second copy removes the failure
 *    mode entirely rather than hoping the strings never drift.
 * 2. `~/.cursor/hooks.json` is not always token-goat's file to touch: on this
 *    machine it is a real 6257-byte file already owned and maintained by a
 *    third-party tool (Orca), registering 8 events against its own shim. A
 *    naive install here would destroy real user configuration. Never depending
 *    on write access to this file removes that hazard structurally, rather than
 *    relying on a merge routine to always get it right.
 *
 * So "Cursor support" here means registering token-goat as an MCP server only,
 * in Cursor's own `~/.cursor/mcp.json` (project: `<project-root>/.cursor/mcp.json`,
 * both paths confirmed live in the same bundle: `joinPath(Hs,".cursor","mcp.json")`,
 * ``${e.projectPath}/.cursor/mcp.json``). This file has no relationship at all to
 * Claude Code's hook or MCP config, so it carries none of the double-fire risk
 * above. There is deliberately no `cursor` `HarnessName` (`./types.ts`) and no
 * `BRIDGE_CAPABILITY_MATRIX` row (`../bridges_status.ts`): both track *hook*
 * parity, and token-goat writes zero hook events for Cursor -- the same
 * reasoning `./zed_install.ts`'s header gives for Zed, though for a different
 * underlying reason (Zed has no hooks API at all; Cursor has one but
 * token-goat deliberately never writes to it).
 *
 * Per-entry shape: Cursor's own JSON schema for `mcp.json`, extracted from the
 * same bundle, is `oneOf` two variants with `additionalProperties:!1` on each:
 * the stdio variant lists only `{command, args, env}` -- there is no `type`
 * field in its property list, unlike VS Code/Visual Studio's `servers` entries
 * (`./mcp_servers_json.ts`'s `managedServer()`, which always includes
 * `type: 'stdio'`). Writing that VS Code shape verbatim into a strict
 * `additionalProperties:false` schema risks Cursor rejecting the whole entry, so
 * this file defines its own entry shape (`command` + `args` only) rather than
 * reusing `managedServer()`/`isManagedServer()`, while still reusing every
 * root-key-agnostic helper in `./mcp_servers_json.ts` (`readServersJson`,
 * `serversOf`, `setTokenGoatServer`, `dropEmptyServers`, `hasManagedServer`)
 * with `rootKey: 'mcpServers'`, confirmed as the schema's actual root property
 * name (`properties:{mcpServers:zto}`) rather than VS Code's `servers`.
 *
 * No shim script is needed (unlike `./zed_install.ts`): Cursor's schema takes a
 * `command` string plus a separate `args` array, spawned without a shell (the
 * same argv-style invocation VS Code and Visual Studio already use via
 * `managedServer()`), not a single shell-executed command line the way Zed's
 * `context_servers` entries are.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { recordCreatedConfig, removeCreatedBackups, takeCreatedConfig } from './created_configs.js'
import { bundledCliPath, dropEmptyServers, hasManagedServer, readServersJson, serversOf, setTokenGoatServer } from './mcp_servers_json.js'
import { projectScopeRoot, withInstallScope } from './project_scope_guard.js'
import { atomicWriteText, backupFile } from '../util.js'

const MCP_SERVERS_KEY = 'mcpServers'
const TOKEN_GOAT_ENTRY_KEY = 'token-goat'

/** Scope selector shared by every Cursor path helper below, mirroring `VscodeScopeOptions`. */
export interface CursorScopeOptions {
  /** When true, target the project-scoped `<project>/.cursor/mcp.json` instead of the user-scoped `~/.cursor/mcp.json`. */
  readonly project?: boolean
  /** Only meaningful with `project: true`; defaults to `process.cwd()`. */
  readonly projectRoot?: string
}

/** Cursor's user config directory: `~/.cursor` on every platform (confirmed live: Cursor resolves it via `pathService.userHome()`, not an OS-specific `APPDATA`/`XDG` split the way VS Code and Zed do). */
function cursorUserConfigDir(): string {
  return path.join(os.homedir(), '.cursor')
}

/** Absolute path to Cursor's `mcp.json` for the requested scope; defaults to user scope. */
export function cursorMcpPath(opts: CursorScopeOptions = {}): string {
  if (opts.project === true) {
    return path.join(opts.projectRoot ?? process.cwd(), '.cursor', 'mcp.json')
  }
  return path.join(cursorUserConfigDir(), 'mcp.json')
}

/** The `mcpServers.token-goat` entry token-goat writes: `command` + `args` only, per this file's header docblock -- Cursor's schema has no `type` field and rejects unknown properties. */
export function cursorManagedServer(): { command: string; args: [string, string] } {
  return { command: process.execPath, args: [bundledCliPath(), 'mcp-serve'] }
}

/** True for an entry token-goat wrote: `command` is our own Node binary, `args` is exactly `[<...>/token-goat.mjs, 'mcp-serve']`. */
export function isCursorManagedServer(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  const args = entry['args']
  return (
    entry['command'] === process.execPath &&
    Array.isArray(args) &&
    args.length === 2 &&
    typeof args[0] === 'string' &&
    path.basename(args[0]).toLowerCase() === 'token-goat.mjs' &&
    args[1] === 'mcp-serve'
  )
}

/** Outcome of an {@link installCursor} call. */
export interface CursorInstallResult {
  readonly mcpPath: string
  /** True when the `mcp.json` entry was already up to date (no write needed). */
  readonly alreadyInstalled: boolean
  /** Which scope was actually written: 'project' (`--project`) or 'user' (default). */
  readonly scope: 'project' | 'user'
}

/**
 * Install the Cursor MCP integration: merges `mcpServers.token-goat` into
 * `mcp.json`, preserving every other key, comment, and formatting choice
 * already there (via `setTokenGoatServer`'s JSONC-preserving edit). Idempotent:
 * a second call reports `alreadyInstalled: true` and does not duplicate the
 * entry. Never touches `hooks.json` -- see this file's header.
 *
 * Throws before any write if `mcp.json` exists but fails to parse, or if it
 * already holds an `mcpServers.token-goat` entry this bridge did not write
 * (mirrors `installZed`'s and `installVscode`'s cross-entry-ownership guard):
 * a real user file that may already have content is never silently clobbered.
 */
export function installCursor(opts: CursorScopeOptions = {}): CursorInstallResult {
  return withInstallScope(projectScopeRoot(opts), () => installCursorScoped(opts))
}

function installCursorScoped(opts: CursorScopeOptions): CursorInstallResult {
  const scope: 'project' | 'user' = opts.project === true ? 'project' : 'user'
  const mcpPath = cursorMcpPath(opts)

  const fileExisted = fs.existsSync(mcpPath)
  const config = readServersJson(mcpPath, 'Cursor')
  const current = serversOf(config, mcpPath, 'Cursor', MCP_SERVERS_KEY)[TOKEN_GOAT_ENTRY_KEY]
  if (current !== undefined && !isCursorManagedServer(current)) {
    throw new Error(`Cursor mcp.json already has a "${TOKEN_GOAT_ENTRY_KEY}" MCP server entry token-goat did not write, at ${mcpPath}; remove it manually first`)
  }

  const desired = cursorManagedServer()
  const nextText = setTokenGoatServer(config.text, desired, MCP_SERVERS_KEY)
  const alreadyInstalled = config.text === nextText
  if (!alreadyInstalled) {
    fs.mkdirSync(path.dirname(mcpPath), { recursive: true })
    if (!fileExisted) recordCreatedConfig(mcpPath)
    backupFile(mcpPath)
    atomicWriteText(mcpPath, nextText)
  }

  return { mcpPath, alreadyInstalled, scope }
}

/**
 * Remove the Cursor MCP integration: drops `mcpServers.token-goat` (and the
 * now-empty `mcpServers` object, if it was the last entry) from `mcp.json`,
 * deleting `mcp.json` itself only if token-goat created it AND it now holds
 * nothing else (mirrors `../bridges/zed_install.ts`'s `uninstallZed`). Returns
 * true when an entry was present and removed; false when nothing was
 * installed (no write occurs in that case). Never touches `hooks.json`.
 */
export function uninstallCursor(opts: CursorScopeOptions = {}): boolean {
  return withInstallScope(projectScopeRoot(opts), () => uninstallCursorScoped(opts))
}

function uninstallCursorScoped(opts: CursorScopeOptions): boolean {
  const mcpPath = cursorMcpPath(opts)
  if (!fs.existsSync(mcpPath)) return false

  const config = readServersJson(mcpPath, 'Cursor')
  if (!isCursorManagedServer(serversOf(config, mcpPath, 'Cursor', MCP_SERVERS_KEY)[TOKEN_GOAT_ENTRY_KEY])) return false

  const next = dropEmptyServers(setTokenGoatServer(config.text, undefined, MCP_SERVERS_KEY), MCP_SERVERS_KEY)
  if (/^\s*\{\s*\}\s*$/.test(next) && takeCreatedConfig(mcpPath)) {
    fs.rmSync(mcpPath, { force: true })
  } else {
    backupFile(mcpPath)
    atomicWriteText(mcpPath, next)
  }
  // The timestamped backups this bridge made for mcpPath are token-goat's own litter, so a full uninstall takes them with it.
  removeCreatedBackups(mcpPath)
  return true
}

/** Whether `mcp.json` for the given scope currently holds a token-goat-managed MCP server entry. */
export function isCursorInstalled(opts: CursorScopeOptions = {}): boolean {
  return hasManagedServer(cursorMcpPath(opts), 'Cursor', MCP_SERVERS_KEY, isCursorManagedServer)
}

/**
 * Reads back the token-goat `mcpServers` entry from `mcpPath`, for
 * `../cli_doctor.ts`'s staleness check -- mirrors `../bridges/zed_install.ts`'s
 * `zedManagedEntry`. Returns `null` when the file is missing, unreadable, or
 * holds no token-goat-managed entry.
 */
export function cursorManagedEntry(mcpPath: string): { command: string } | null {
  if (!fs.existsSync(mcpPath)) return null
  try {
    const entry = serversOf(readServersJson(mcpPath, 'Cursor'), mcpPath, 'Cursor', MCP_SERVERS_KEY)[TOKEN_GOAT_ENTRY_KEY]
    if (!isCursorManagedServer(entry)) return null
    return { command: (entry as { command: string }).command }
  } catch {
    return null
  }
}
