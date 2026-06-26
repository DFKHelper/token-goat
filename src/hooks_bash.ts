/**
 * pre_tool_use hook for the Bash tool.
 *
 * When a build tool command (cargo, go, mvn, make, etc.) is about to run and
 * its output is already cached in the session bash-output store, inject a recall
 * hint so the model can inspect cached output instead of re-running the command.
 */

import type { HookEvent } from './hook_registry.js'
import { registerHook } from './hook_registry.js'
import { contextOutput, passOutput } from './hooks_common.js'
import type { HookOutput } from './types.js'
import { getBashOutputId } from './session.js'
import { fingerprintContent } from './fingerprint.js'
import { isBuildCommand } from './hints/lang_patterns.js'

/** Extract the command string from a Bash tool_input. */
function extractCommand(event: HookEvent): string | undefined {
  const cmd = event.toolInput['command']
  return typeof cmd === 'string' && cmd.trim() !== '' ? cmd.trim() : undefined
}

/** True when the command is a TypeScript compiler invocation. */
function isTscCommand(cmd: string): boolean {
  return /^\s*tsc(\s|$)/i.test(cmd)
}

/** True when the command is a JS/TS dev server (vite dev, next dev, nuxt dev). */
function isDevServerCommand(cmd: string): boolean {
  return /^\s*(vite\s+dev|next\s+dev|nuxt\s+dev)\b/i.test(cmd)
}

/**
 * Build the recall hint text for a cached build command output.
 *
 * Returns a hint tailored to the command type (tsc, dev server, or generic).
 */
function buildRecallHint(cmd: string, outputId: string): string {
  const cmdPreview = cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd
  if (isTscCommand(cmd)) {
    return (
      'Output from a prior `' + cmdPreview + '` run is cached. ' +
      'Use `token-goat bash-output ' + outputId + ' --grep "error TS"` to filter TypeScript errors, ' +
      'or `--grep "Cannot find"` for missing module errors.'
    )
  }
  if (isDevServerCommand(cmd)) {
    return (
      'Dev server output cached (`' + cmdPreview + '`). ' +
      'Use `token-goat bash-output ' + outputId + ' --tail 20` to see the latest output, ' +
      'or `--grep "error\\|warn"` to filter issues.'
    )
  }
  return (
    'Output from a prior `' + cmdPreview + '` run is cached. ' +
    'Use `token-goat bash-output ' + outputId + '` (or `--tail 50`, `--grep ERROR`) ' +
    'to re-inspect it without re-running.'
  )
}

/**
 * pre_tool_use handler for the Bash tool.
 *
 * Emits a recall hint when the command is a known build tool and its output
 * was already captured this session. Passes through for all other commands.
 */
export function preBashHandler(event: HookEvent): HookOutput {
  const cmd = extractCommand(event)
  if (cmd === undefined) return passOutput()

  if (!isBuildCommand(cmd)) return passOutput()

  // Derive the same command hash used by the session store.
  const cmdHash = fingerprintContent(cmd).slice(0, 16)
  const outputId = getBashOutputId(cmdHash)
  if (outputId === null) return passOutput()

  return contextOutput(buildRecallHint(cmd, outputId))
}

registerHook('pre_tool_use', preBashHandler, { toolName: 'Bash' })
