/** `post_tool_use` side of the failure-recovery pairs (recovery_pairs.ts): a successful Bash command may close a pending pair, and an edit tool drops every pending pair. Both handlers are advisory and always pass. They live in their own module, imported ahead of hooks_edit and hooks_bash_post in relay.ts, because a non-advisory handler that answers first ends the dispatch loop and these would never see the call. Codex reports a Bash result as a bare string with no exit code, installs no failure event, and sends no hook at all for a failed apply_patch (registry.rs runs PostToolUse only when `success`, and an exec result always logs as success), so no recovery pair or edit near-miss is possible there; only the missing-path suggestion is, through {@link textPathMiss}, which VS Code (no failure event either) shares. */

import { detectHarness } from './bridges/registry.js'
import { registerHook, type HookEvent } from './hook_registry.js'
import { unwrapCompressCommand } from './hooks_bash_commands.js'
import { extractExitCode } from './hooks_bash_post.js'
import { contextOutput, extractToolResultText, getToolInput, passOutput } from './hooks_common.js'
import type { HookOutput } from './types.js'

export async function recoveryBashHandler(event: HookEvent): Promise<HookOutput> {
  const executed = getToolInput(event)['command']
  const exit = extractExitCode(event.raw)
  // A nonzero exit reaching post_tool_use (hosts that report one there) is a failure, not a success to learn from.
  if (typeof executed === 'string' && (exit === null || exit === 0)) {
    const { recoveryAfterSuccess } = await import('./recovery_pairs.js')
    recoveryAfterSuccess(event, unwrapCompressCommand(executed) ?? executed)
  }
  return passOutput()
}

export async function recoveryEditHandler(event: HookEvent): Promise<HookOutput> {
  const { recoveryAfterEdit } = await import('./recovery_pairs.js')
  recoveryAfterEdit(event)
  return passOutput()
}

/** Codex has no failure event, but it sends every `exec_command` result as a PostToolUse whose `tool_response` is the command's output as a bare string (openai/codex ddb33e34b278, codex-rs/core/src/tools/context.rs ExecCommandToolOutput::post_tool_use_response). VS Code is the same shape: its PostToolUse runs only after a tool returned a result (a tool that throws becomes an `ERROR while calling tool` message and no hook, extensions/copilot/dist/extension.js 1.140.0, function sqi and its caller), and passes `tool_response` as the joined text of that result, so a terminal command that printed an error reaches it as a string. So only the missing-path suggestion (path_miss.ts) can be answered on those two: the text is matched for the shell's `No such file or directory` and the path looked up as it is after a reported failure. */
export async function textPathMiss(event: HookEvent): Promise<HookOutput> {
  if (!['codex', 'vscode'].includes(detectHarness()) || typeof event.raw['tool_response'] !== 'string') return passOutput()
  const text = extractToolResultText(event.raw)
  if (!/No such file or directory/i.test(text)) return passOutput()
  const { pathMissAfterFailure } = await import('./path_miss.js')
  const line = pathMissAfterFailure(event, { toolName: 'Bash', errorText: text })
  return line === null ? passOutput() : contextOutput(line)
}

registerHook('post_tool_use', recoveryBashHandler, { toolName: 'Bash', advisory: true, followsMatcher: true })
registerHook('post_tool_use', textPathMiss, { toolName: 'Bash', advisory: true, followsMatcher: true })
for (const toolName of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch']) registerHook('post_tool_use', recoveryEditHandler, { toolName, advisory: true, followsMatcher: true })
