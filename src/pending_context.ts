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
import { stripUnsafeSuggestions } from './hint_suggestion_guard.js'
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
 * Queue `text` for delivery on the next tool call made under `stateKey`. Appends, so two hints produced by one prompt both survive. Silently does nothing when the key is unusable or the write fails -- a hint that cannot be stored is a lost hint, never a failed hook.
 *
 * The key is `sessionStateKey(event)`, never a bare session id: a subagent shares its parent's session id and makes tool calls of its own, so a queue keyed on the id alone let the first child tool call read and consume a manifest queued for the parent's compaction, and the parent -- the one that compacted and lost the context -- got nothing. The composite key is the one `session_store.ts` already understands: `sessionFileStem` splits on `:agent:` and hashes the agent half, so parent and child land on different sidecars.
 */
export function queuePendingContext(stateKey: string, text: string): void {
  const trimmed = text.trim()
  if (trimmed === '') return
  const target = sessionSidecarPath(stateKey, PENDING_SUFFIX)
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
 * Read everything queued under `stateKey`, or null when nothing is, without consuming it.
 *
 * Peek rather than take, because reading is not delivering. The handler that reads this queue is registered advisory, and `runHook` returns the first non-advisory non-pass result it sees and drops the advisory one it was holding alongside it. Consuming at read time therefore deleted a queued compaction manifest on any tool call where another handler also had something to say -- `postBashHandler`'s compression and delta branches are the common case -- and the manifest was gone for the rest of the session with nothing failing and the hint still counted as emitted. Pair every peek with {@link commitPendingContext} against the text that actually got emitted.
 */
export function peekPendingContext(stateKey: string): string | null {
  const target = sessionSidecarPath(stateKey, PENDING_SUFFIX)
  return target === null ? null : readPending(target)
}

/**
 * Clear the queue for `stateKey`, but only when `delivered` actually carries the queued text.
 *
 * Delivery is proven from the string about to be serialized rather than assumed from the fact that the reading handler ran, so a peek whose result lost the turn leaves the text queued for the next tool call instead of dropping it. When it did land, this clear is what keeps a one-shot hint one-shot.
 *
 * `delivered` is compared against the queued text put through the same suggestion guard the relay applies on its way out, because the relay sanitizes AFTER the handler returns and BEFORE this runs. A queued block naming an unsafe `token-goat ...` span therefore arrives here rewritten, a raw substring test fails on text that plainly was delivered, and the sidecar is never cleared -- so the same block is re-emitted on every subsequent tool call for the rest of the session, each time counted as a fresh emission. The manifest's own safe-to-discard section embeds this session's cached commands, so the trigger is ordinary content, not a crafted one. The guard is idempotent, which is what lets it stand in for identity here: comparing two canonical forms answers "did this text go out" without either side needing to know who rewrote it.
 */
export function commitPendingContext(stateKey: string, delivered: string | null): void {
  if (delivered === null || delivered === '') return
  const target = sessionSidecarPath(stateKey, PENDING_SUFFIX)
  if (target === null) return
  const queued = readPending(target)
  if (queued === null) return
  if (!delivered.includes(queued) && !delivered.includes(stripUnsafeSuggestions(queued))) return
  try {
    rmSync(target, { force: true })
  } catch {
    // Already gone, or unremovable; a repeated hint is the cost here, never a blocked tool call.
  }
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
