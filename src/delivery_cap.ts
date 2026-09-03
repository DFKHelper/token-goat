// Per-harness delivery caps: the ceiling on how much of a tool result the model actually receives.
//
// A compressor that shrinks a 30 MB command output to 8 KB did not spare the model 30 MB of tokens.
// The harness would never have shown it 30 MB. Claude Code truncates a Bash tool result, persists the
// full text to a file, and hands the model the truncated body plus a pointer to that file -- so the
// counterfactual a saving must be measured against is the TRUNCATED size, not the original size.
// Booking the original is the accounting-honesty failure this module exists to prevent: a saving is
// real only in the billing unit, on the branch that actually blocks the cost.

import { detectHarness } from './bridges/index.js'
import type { HarnessName } from './bridges/index.js'

/**
 * Bytes of a Bash tool result Claude Code delivers inline before it truncates.
 *
 * Derived by CAPTURE from the recorded session corpus (174,678 Bash results, 1,935 of them
 * persisted): the smallest output that WAS persisted measured 20,013 bytes and the largest that was
 * NOT measured 19,990 -- a 23-byte gap with nothing in between. Outputs above the cap still deliver
 * ~20,000 bytes inline (p90 20,000, p100 20,046) even when the full text runs past 1 MB, so a
 * rewrite of an oversized output remains net-positive. This constant corrects what gets RECORDED
 * and must never be used to suppress a rewrite.
 */
export const CLAUDE_CODE_BASH_OUTPUT_CAP_BYTES = 20_000

/**
 * Bash-result delivery cap for the given harness, or null when that harness has no measured cap.
 *
 * Deliberately a per-harness lookup rather than a universal constant. Codex, opencode, pi and
 * Copilot each truncate on their own rules, and applying Claude Code's number to them would
 * under-credit -- the same class of error as over-crediting, pointing the other way. A harness
 * absent from this table is credited uncapped until someone measures it.
 */
export function bashOutputCapBytes(harness: HarnessName = detectHarness()): number | null {
  return harness === 'claudecode' ? CLAUDE_CODE_BASH_OUTPUT_CAP_BYTES : null
}

/**
 * The portion of originalBytes the model would actually have received, given the active harness.
 *
 * This is the single definition of the counterfactual every Bash saving is measured against. Both
 * the CLI wrapper path (bash_runner) and the hook rewrite path (hooks_bash) route their recorded
 * figure through it, so the two cannot drift apart.
 */
export function deliveredOutputBytes(originalBytes: number, harness?: HarnessName): number {
  const cap = bashOutputCapBytes(harness)
  if (cap === null) return Math.max(0, originalBytes)
  return Math.max(0, Math.min(originalBytes, cap))
}
