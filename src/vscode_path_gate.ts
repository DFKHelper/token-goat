/** Which paths a pre_tool_use handler may open. A PreToolUse hook runs before the user approves the call -- on VS Code always, and on every other harness for any tool the user has not pre-approved -- so a path the model chose must not make token-goat touch anything the user has not been asked about. Two separate rules come out of that, and they have different scopes. The UNC/device rule is harness-independent. A path of the form `\\server\share`, `//server/share`, `\\?\` or `\\.\` is declined on every harness: on Windows even a stat of a UNC path opens an SMB connection to the named host, which is an outbound network call to an address the model picked. Measured on 2026-09-13 through `preReadHandler` on the default harness, a `Read` of `\\10.255.255.1\share\x.txt` took 21.0 s against 21 ms for a local control -- the whole SMB connect timeout, spent before anyone approved anything. Scoping that to VS Code was a bug: nothing about it is VS-Code-specific. The workspace-containment rule stays VS-Code-only, because only there does the harness supply a workspace folder that bounds what the hook may see. Anything else must sit inside the workspace folder VS Code runs the hook in. The lexical check runs first and touches no file; only a path already inside the workspace by name is then resolved through symlinks by isInsideRoot, so a link cannot lead out of it. The workspace is whatever cwd the harness supplied, and only that. With no workspace folder open VS Code resolves no cwd and starts the hook in the user's home directory, so hooks_cli.ts deliberately leaves the key absent rather than filling it from process.cwd(): a filled value would be $HOME, and adopting it as the root would open the whole home directory to a hook that runs before the user approves the call. Absent is the state the `workspace === undefined` branch above exists to catch. Every pre_tool_use handler that stats or reads its path calls preToolPathDeclined first; tests/vscode_pre_handler_path_gate.test.ts sweeps the live registry so a new one cannot skip it, tests/guards/pre_handler_fs_touches_are_gated.test.ts covers the code that sweep cannot see, tests/pre_tool_unc_gate_is_harness_independent.test.ts pins the harness-independent half, and tests/vscode_folderless_cwd_gate.test.ts covers the no-folder case through the real normalizePayload. */
import * as path from 'node:path'

import type { HookEvent } from './hook_registry.js'
import { VSCODE_TOOL_NAME_KEY } from './hooks_cli.js'
import { getCwd } from './hooks_common.js'
import { escapesOntoNetworkThroughLinks, isInsideRoot } from './project.js'
import { isUncOrDevicePath } from './paths.js'
import { foldPathForContainment } from './util.js'

// Re-exported rather than defined here: path_containment.ts needs the same test, to refuse a symlink whose target escapes onto a share before its own walk stats the next segment, and it cannot import this module. The definition moved to paths.ts, at the bottom of the import graph.
export { isUncOrDevicePath }

/** The same question asked of the path Node will actually open, not just of the spelling given. A relative target inherits the working directory, and if that directory is itself on a share then `statSync('x.txt')` reaches the server exactly as `\\host\share\x.txt` would -- the double separator never appears in the string the gate was handed. That is not exotic: a hook started in a project opened over SMB is in precisely that state. `path.resolve` answers it without touching the filesystem, so asking costs nothing. What this does NOT catch is a mapped drive letter: `Z:foo.txt` where `Z:` is a network mapping resolves to `Z:\...\foo.txt`, which is lexically indistinguishable from a local drive, and no synchronous API tells the two apart. That residue is accepted; the mapping is the user's own configuration rather than something the model chose. */
function resolvesToUncPath(target: string, cwd: string | undefined): boolean {
  try {
    return isUncOrDevicePath(path.resolve(cwd ?? process.cwd(), target))
  } catch {
    // A resolve that throws tells us nothing about the network, and failing closed here would refuse ordinary paths on a process whose cwd has been deleted.
    return false
  }
}

/** Whether `filePath` may be opened by a hook running in `workspace` on VS Code. */
export function vscodePathAllowed(filePath: string, workspace: string | undefined): boolean {
  if (isUncOrDevicePath(filePath)) return false
  if (workspace === undefined || isUncOrDevicePath(workspace)) return false
  const resolvedRoot = path.resolve(workspace)
  const resolvedTarget = path.resolve(workspace, filePath)
  const root = foldPathForContainment(resolvedRoot.replace(/\\/g, '/'))
  const target = foldPathForContainment(resolvedTarget.replace(/\\/g, '/'))
  if (target !== root && !target.startsWith(root.endsWith('/') ? root : root + '/')) return false
  return isInsideRoot(resolvedTarget, resolvedRoot)
}

/** Accepted residue: the gate resolves links, then the handler opens the pathname again. A local process that can write inside the workspace can replace an allowed symlink in the window between the two, pointing the handler somewhere the gate never saw. Closing it properly means opening a descriptor here and handing that descriptor to every handler instead of a path, which is a change to each handler's shape rather than to this file. Not closed, and the reason is the size of what is behind the window rather than its difficulty. The attacker already has local code execution as this user, which is strictly more access than the race wins them: a pre-tool handler reads a file to shrink an image or to decide a hint, and the worst outcome is that the substituted file's content reaches the model. The same attacker can simply write that content into a file the user is going to read anyway. The UNC case above is different in kind, and is why it is refused rather than accepted: it needs no local access at all, only a path in a tool call, and it reaches the network. */

/** Whether `event` came from VS Code, where the hook runs ahead of the approval prompt and a workspace folder bounds it. */
function isVscodeEvent(event: HookEvent): boolean {
  return event.raw['_tg_harness'] === 'vscode' || event.raw[VSCODE_TOOL_NAME_KEY] !== undefined
}

/** True when `target` is a path a pre_tool_use handler must leave alone; false when there is no path. The first two clauses read the spelling, and on their own they answer a smaller question than this one is asked: a repository can check in an ordinary-looking directory as a symlink to `\\host\share`, and then a path spelled entirely in local characters stats onto the network. On VS Code the workspace clause caught that already, because containment resolves links before it answers -- but every other harness fell out at `isVscodeEvent` with only the spelling checked, and the harness makes no difference to who is dialled or to the fact that nobody has approved the call yet. So the link walk is the answer on those harnesses. It runs LAST rather than first, and that ordering is load-bearing rather than tidy. The walk `lstat`s each segment of the path -- local, non-following, no network -- but a path VS Code has already refused lexically, for sitting outside the workspace, must not be touched at all: the sweep in `tests/vscode_pre_handler_path_gate.test.ts` asserts on ACCESS, not on the verdict, and a gate that walks a path it is about to refuse has touched it. Every harness reaches exactly one of the two, and neither loses a case: VS Code's containment already resolves links itself. */
export function preToolPathDeclined(event: HookEvent, target: string | undefined): boolean {
  if (target === undefined) return false
  const cwd = getCwd(event)
  if (isUncOrDevicePath(target) || resolvesToUncPath(target, cwd)) return true
  if (isVscodeEvent(event)) return !vscodePathAllowed(target, cwd)
  return escapesOntoNetworkThroughLinks(target, cwd)
}

/** Whether a path this hook parsed OUT OF a command may be touched on disk before the user has approved that command. Every other pre_tool_use handler asks {@link preToolPathDeclined} before its first fs call, because the harness fires the hook before the approval prompt and the path is the model's choice until then -- and on Windows a `statSync` of `\\host\share\...` opens an SMB session, carrying an authentication attempt, to a host a repository named. This handler was outside that discipline for one reason that reads plausible and is wrong: its tool carries a command rather than a path. It carries about twenty paths, extracted from the command, and stats two of them. Answers false rather than throwing: the caller's only use for the size is deciding whether to emit a hint, and declining to measure is the same outcome as measuring and finding nothing. `event === undefined` still refuses a network or device path, including one reached through a link, so a caller that has no event to hand -- a direct unit test of an extractor, or a future one -- loses only the workspace half of the rule, never the network half. */
export function commandPathIsTouchable(filePath: string, event: HookEvent | undefined): boolean {
  if (event === undefined) return !escapesOntoNetworkThroughLinks(filePath)
  return !preToolPathDeclined(event, filePath)
}
