/**
 * Deferred hint delivery, for harnesses that run a prompt-submit hook but discard its response.
 *
 * Copilot CLI is the case this exists for. Its `userPromptSubmitted` hook runs token-goat and
 * throws the answer away: the event does read a response body, but only `modifiedPrompt`, and only
 * for SDK-registered hooks -- "Command and HTTP config-file userPromptSubmitted hooks have their
 * output dropped" (https://docs.github.com/en/copilot/reference/hooks-reference). token-goat
 * installs command hooks, so every hint it produced at prompt-submit time reached nothing. The
 * skill-drift nudge and the resident-context hints were computed and discarded on every prompt.
 *
 * So the hint is held here and delivered on the next tool call instead. That is a few hundred
 * milliseconds later in the same turn, and the shape is strictly safer than the alternative:
 * appending guidance after a tool result is additive and visible, where rewriting the prompt would
 * silently change what the user asked for.
 *
 * The channel it lands on is `modifiedResult.textResultForLlm`, not `additionalContext`. That
 * distinction is the whole delivery guarantee and it was not always true here. `additionalContext`
 * is dropped on Copilot's JS path: reading the 1.0.80 bundle, `postToolExecution` (app.js offset
 * 2043150) applies `modifiedResult` in place and never pushes `additionalContext` anywhere,
 * `grep -abo "onAdditionalContext:" app.js` finds no supplier for the callback, and that event's
 * native return payload (offset 1793926) has no `additional_contexts` key, unlike the pre-tool
 * sibling that does. `modifiedResult`, by contrast, is applied in place by that same function. So
 * the `postToolUse` branch in `src/bridges/copilot_cli.ts` appends the queued text to the body it
 * returns, and the hint arrives on the channel the harness reads rather than the one its docs name.
 *
 * What is still open is not the channel but the population: `PROMPT_SUBMIT_CONTEXT_DROPPED` in
 * `src/harness_channels.ts` is empty, because a live test on 1.0.80 showed Copilot's
 * `userPromptSubmitted` context does reach the model despite the documentation saying otherwise.
 * So no harness currently reroutes through here for prompt-submit hints. The pre-compact queue
 * beside it is not empty and does use this path -- see `dropsPreCompactContext`.
 *
 * The per-tool-call price is one memoised `getHarnessName()` read and a `Set.has()`.
 *
 * State lives in a sidecar file beside the session, not inside the session JSON, so no field has
 * to be threaded through that store's serialize/deserialize/validate/merge paths -- a shape where
 * omitting one half disables the feature with nothing failing.
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { sessionSidecarPath } from './session_store.js'
import { ensureDirSync } from './util.js'

/** Sidecar suffix holding text queued for the next tool call. */
const PENDING_SUFFIX = '.pending-context.txt'

/**
 * Largest queued payload retained, in bytes.
 *
 * A hint that outgrows this is not worth the context it would cost to deliver, and an unbounded
 * queue would let a runaway producer write a file that then gets injected whole. Oldest text is
 * dropped rather than newest: the newest hint is the one describing the session's state now.
 */
export const MAX_PENDING_CONTEXT_BYTES = 4_096

/**
 * Queue `text` for delivery on this session's next tool call. Appends, so two hints produced by
 * one prompt both survive. Silently does nothing when the session id is unusable or the write
 * fails -- a hint that cannot be stored is a lost hint, never a failed hook.
 */
export function queuePendingContext(sessionId: string, text: string): void {
  const trimmed = text.trim()
  if (trimmed === '') return
  const target = sessionSidecarPath(sessionId, PENDING_SUFFIX)
  if (target === null) return
  try {
    const existing = readPending(target)
    const merged = existing === null ? trimmed : `${existing}\n${trimmed}`
    // Keep the tail: when the cap forces a choice, the most recent hint is the accurate one.
    const capped =
      merged.length <= MAX_PENDING_CONTEXT_BYTES ? merged : merged.slice(merged.length - MAX_PENDING_CONTEXT_BYTES)
    ensureDirSync(dirname(target))
    writeFileSync(target, capped, 'utf8')
  } catch {
    // Storage is best-effort; see the doc comment above.
  }
}

/**
 * Take everything queued for `sessionId`, or null when nothing is. Deletes as it reads, so a hint
 * is delivered exactly once even though every tool call in the session checks. Deleting before
 * returning is deliberate: a crash between read and delete would otherwise repeat the hint on
 * every subsequent tool call for the rest of the session.
 */
export function drainPendingContext(sessionId: string): string | null {
  const target = sessionSidecarPath(sessionId, PENDING_SUFFIX)
  if (target === null) return null
  const text = readPending(target)
  try {
    rmSync(target, { force: true })
  } catch {
    // Already gone, or unremovable; the text is still returned exactly once from this call.
  }
  return text
}

/** Read a queued payload, or null when the file is absent, unreadable, or empty. */
function readPending(target: string): string | null {
  try {
    const raw = readFileSync(target, 'utf8').trim()
    return raw === '' ? null : raw
  } catch {
    return null
  }
}
