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
 * So the hint is held here and delivered on the next tool call instead, via `postToolUse`'s
 * `additionalContext`. That is a few hundred milliseconds later in the same turn, and the shape is
 * strictly safer than the alternative: appending guidance after a tool result is additive and
 * visible, where rewriting the prompt would silently change what the user asked for.
 *
 * The delivery channel, however, is NOT confirmed to work on the one harness this was built for.
 * The original rationale here quoted Copilot's hooks reference -- "Additional guidance appended to
 * textResultForLlm so the model sees it after the tool output on the same turn" -- and that page
 * is not reliable: the same page also says `userPromptSubmitted` output is dropped, which a live
 * test on 1.0.80 disproved for `additionalContext`. Reading the 1.0.80 bundle instead:
 * `postToolExecution` (app.js offset 2043150) applies `modifiedResult` in place but never pushes
 * `additionalContext` anywhere, `grep -abo "onAdditionalContext:" app.js` finds no supplier for the
 * callback, and the event's native return payload (offset 1793926) has no `additional_contexts`
 * key, unlike the pre-tool sibling that does. The residual is that native
 * `hookProcessorPostToolUse` might fold the context into the `toolResultJson` it hands back; that
 * was not verified in either direction. See the `postToolUse` branch in
 * `src/bridges/copilot_cli.ts` for the full evidence.
 *
 * This module is kept anyway. It is nearly free -- `getHarnessName()` is memoised, so the per-tool
 * -call price is one cached read and an empty `Set.has()` -- it is correct on any harness that does
 * honor the field, and it is the ready-made delivery half if Copilot's channel is confirmed or
 * fixed later. What must not happen is anyone reading this file and believing the hints are known
 * to arrive on Copilot today. They are not.
 *
 * State lives in a sidecar file beside the session, not inside the session JSON, so no field has
 * to be threaded through that store's serialize/deserialize/validate/merge paths -- a shape where
 * omitting one half disables the feature with nothing failing.
 */

import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { sessionSidecarPath } from './session_store.js'

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
    mkdirSync(dirname(target), { recursive: true })
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
