/** `post_tool_use` side of the failure-recovery pairs (recovery_pairs.ts): a successful Bash command may close a pending pair, and an edit tool drops every pending pair. Both handlers are advisory and always pass. They live in their own module, imported ahead of hooks_edit and hooks_bash_post in relay.ts, because a non-advisory handler that answers first ends the dispatch loop and these would never see the call. Codex reports a Bash result as a bare string with no exit code and installs no failure event, so no pair is ever opened for it; this module changes nothing there. */

import { registerHook, type HookEvent } from './hook_registry.js'
import { unwrapCompressCommand } from './hooks_bash_commands.js'
import { extractExitCode } from './hooks_bash_post.js'
import { getToolInput, passOutput } from './hooks_common.js'
import { recoveryAfterEdit, recoveryAfterSuccess } from './recovery_pairs.js'
import type { HookOutput } from './types.js'

export function recoveryBashHandler(event: HookEvent): HookOutput {
  const executed = getToolInput(event)['command']
  const exit = extractExitCode(event.raw)
  // A nonzero exit reaching post_tool_use (hosts that report one there) is a failure, not a success to learn from.
  if (typeof executed === 'string' && (exit === null || exit === 0)) recoveryAfterSuccess(event, unwrapCompressCommand(executed) ?? executed)
  return passOutput()
}

export function recoveryEditHandler(event: HookEvent): HookOutput {
  recoveryAfterEdit(event)
  return passOutput()
}

registerHook('post_tool_use', recoveryBashHandler, { toolName: 'Bash', advisory: true, followsMatcher: true })
for (const toolName of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch']) registerHook('post_tool_use', recoveryEditHandler, { toolName, advisory: true, followsMatcher: true })
