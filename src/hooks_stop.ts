/** The Stop hook: when the agent ends a turn with source edits that no test, lint, typecheck or build run has covered since, say so once. Advisory only -- it never blocks the stop, so it cannot loop the agent -- and it speaks again only when the picture changes, because Stop fires after every turn and an unchanged reminder is noise. The verdict comes from verification_state.ts, which the subagent report receipt reads too. */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { loadConfig } from './config.js'
import type { HookEvent } from './hook_registry.js'
import { registerHook, sessionStateKey } from './hook_registry.js'
import { nameSubject, quotedArg } from './hint_suggestion_guard.js'
import { dropsStopContext } from './harness_channels.js'
import { contextOutput, passOutput } from './hooks_common.js'
import { sessionSidecarPath } from './session_store.js'
import type { HookOutput } from './types.js'
import { ensureDirSync, isWithinQuietHours } from './util.js'
import { evaluateVerification, type VerificationState } from './verification_state.js'

// Not `.json`: sessionSidecarPath refuses any other file ending in `.json`, because every reader that lists the sessions directory takes one to be a session.
const ADVISED_SUFFIX = '.stop-advised'
const MAX_NAMED_FILES = 5

/** The advisory text for an unverified state, or null when there is nothing to say: no edit is waiting on a verdict and the last verification run did not fail. */
export function stopAdvisoryText(state: VerificationState): string | null {
  const parts: string[] = []
  if (state.editedSinceLastPass.length > 0) {
    const named = state.editedSinceLastPass.slice(0, MAX_NAMED_FILES).map((name) => nameSubject('file', name)).join(', ')
    const more = state.editedSinceLastPass.length - MAX_NAMED_FILES
    parts.push(`edited since the last passing check: ${named}${more > 0 ? ` (+${more} more)` : ''}`)
  }
  if (state.failingUnresolved && state.latestRun !== undefined) parts.push(`the last check failed: ${quotedArg(state.latestRun.command)} (exit ${state.latestRun.exitCode})`)
  else if (state.editedSinceLastPass.length > 0 && state.latestRun !== undefined) parts.push(`last check run: ${quotedArg(state.latestRun.command)}`)
  else if (state.editedSinceLastPass.length > 0) parts.push('no test, lint, typecheck or build was run this session')
  return parts.length === 0 ? null : `token-goat: unverified work before you stop. ${parts.join('; ')}.`
}

function readAdvised(target: string): string {
  try {
    return readFileSync(target, 'utf8')
  } catch {
    return ''
  }
}

/** stop handler: name the unverified edits once per distinct state. Best-effort throughout: a failure to read or remember leaves the stop untouched. */
export function stopHandler(event: HookEvent): HookOutput {
  try {
    // A stop already continued by a hook: never add to the loop.
    if (event.raw['stop_hook_active'] === true) return passOutput()
    const config = loadConfig().hints
    if (!config.stop_verification_advisory || isWithinQuietHours(config.quiet_hours) || dropsStopContext()) return passOutput()
    const key = sessionStateKey(event)
    const state = evaluateVerification(key)
    const text = stopAdvisoryText(state)
    const target = sessionSidecarPath(key, ADVISED_SUFFIX)
    // A verified state remembers the empty signature: the same edit-then-no-check state recurring after a passing check is a new picture and must be said again.
    const signature = text === null ? '' : createHash('sha256').update(text).digest('hex').slice(0, 16)
    if (target !== null) {
      if (readAdvised(target) === signature) return passOutput()
      try {
        ensureDirSync(dirname(target))
        writeFileSync(target, signature, 'utf8')
      } catch {
        // Unable to remember: say it again next time rather than never.
      }
    }
    return text === null ? passOutput() : contextOutput(text)
  } catch {
    return passOutput()
  }
}

registerHook('stop', stopHandler, { advisory: true })
