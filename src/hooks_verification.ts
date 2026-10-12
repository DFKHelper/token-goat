/** The eager half of the verification bookkeeping: a keyword gate and the registrations. The code behind them (verification_state.ts, hooks_stop.ts) loads on first use, because the hook entry parses every eager byte on each tool call and only a test, lint, typecheck or build command, a failed call, or a stop needs it. */

import { registerHook, type HookEvent } from './hook_registry.js'
import type { HookOutput } from './types.js'
import { unwrapCompressCommand } from './hooks_bash_commands.js'
import { getToolInput, getToolName, passOutput } from './hooks_common.js'

/** Every test, lint, typecheck and build command verification_state.ts accepts carries one of these words, so a command without one can skip the load. A superset on purpose: tests/hooks_stop.test.ts pins that it never misses a command isVerificationCommand accepts. */
const VERIFICATION_WORD = /test|jest|lint|check|build|compile|verify|tsc|ruff|clippy|mypy|pyright|\bvet\b/i

/** True when `command` might be a verification command; a cheap test for the hot path, never a verdict. */
export function mayBeVerificationCommand(command: string): boolean {
  return VERIFICATION_WORD.test(command)
}

registerHook('stop', async (event) => (await import('./hooks_stop.js')).stopHandler(event), { advisory: true })

/** Records a failed Bash check. Registered by hooks_tool_failure.ts just before its own handler: a non-pass answer from that one (the repeated-failure notice) ends the run, so this must come first, and sharing the file is what fixes the order. hooks_tool_failure.ts is imported here only inside the handler, so this module never imports it statically. */
export async function noteFailedVerificationHandler(event: HookEvent): Promise<HookOutput> {
  const executed = getToolInput(event)['command']
  // A command the pre-hook rewrote into a `token-goat compress` wrapper arrives as that wrapper; the check is the command inside it.
  const command = typeof executed === 'string' ? (unwrapCompressCommand(executed) ?? executed) : null
  if (getToolName(event)?.toLowerCase() === 'bash' && command !== null && mayBeVerificationCommand(command)) {
    const [failure, verification] = await Promise.all([import('./hooks_tool_failure.js'), import('./verification_state.js')])
    const errorText = failure.extractFailureText(event.raw)
    if (errorText !== '') verification.noteFailedVerificationRun(command, errorText, event.raw['is_interrupt'] === true)
  }
  return passOutput()
}
