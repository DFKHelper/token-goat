/**
 * Which paths a pre_tool_use handler may open on VS Code.
 *
 * VS Code runs a PreToolUse hook before it asks the user to approve the call, so a path the model chose must not make token-goat touch anything the user has not been asked about. A UNC or device path (`\\server\share`, `//server/share`, `\\?\`, `\\.\`) is declined outright: on Windows even a stat of a UNC path opens an SMB connection to that host. Anything else must sit inside the workspace folder VS Code runs the hook in. The lexical check runs first and touches no file; only a path already inside the workspace by name is then resolved through symlinks by isInsideRoot, so a link cannot lead out of it.
 *
 * The workspace is whatever cwd the harness supplied, and only that. With no workspace folder open VS Code resolves no cwd and starts the hook in the user's home directory, so hooks_cli.ts deliberately leaves the key absent rather than filling it from process.cwd(): a filled value would be $HOME, and adopting it as the root would open the whole home directory to a hook that runs before the user approves the call. Absent is the state the `workspace === undefined` branch above exists to catch.
 *
 * Every pre_tool_use handler a VS Code tool reaches that stats or reads its path calls vscodePathDeclined first; tests/vscode_pre_handler_path_gate.test.ts sweeps the live registry so a new one cannot skip it, and tests/vscode_folderless_cwd_gate.test.ts covers the no-folder case through the real normalizePayload.
 */
import * as path from 'node:path'

import type { HookEvent } from './hook_registry.js'
import { VSCODE_TOOL_NAME_KEY } from './hooks_cli.js'
import { getCwd } from './hooks_common.js'
import { isInsideRoot } from './project.js'
import { foldPath } from './util.js'

/** Whether `filePath` may be opened by a hook running in `workspace` on VS Code. */
export function vscodePathAllowed(filePath: string, workspace: string | undefined): boolean {
  if (/^[\\/]{2}/.test(filePath)) return false
  if (workspace === undefined || /^[\\/]{2}/.test(workspace)) return false
  const resolvedRoot = path.resolve(workspace)
  const resolvedTarget = path.resolve(workspace, filePath)
  const root = foldPath(resolvedRoot.replace(/\\/g, '/'))
  const target = foldPath(resolvedTarget.replace(/\\/g, '/'))
  if (target !== root && !target.startsWith(root.endsWith('/') ? root : root + '/')) return false
  return isInsideRoot(resolvedTarget, resolvedRoot)
}

/** True when `event` came from VS Code and `target` is a path its hooks must leave alone; false on every other harness and when there is no path. */
export function vscodePathDeclined(event: HookEvent, target: string | undefined): boolean {
  if (target === undefined) return false
  if (event.raw['_tg_harness'] !== 'vscode' && event.raw[VSCODE_TOOL_NAME_KEY] === undefined) return false
  return !vscodePathAllowed(target, getCwd(event))
}
