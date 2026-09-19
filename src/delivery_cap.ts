// Per-harness delivery caps: the ceiling on how much of a tool result the model actually receives.
//
// A compressor that shrinks a 30 MB command output to 8 KB did not spare the model 30 MB of tokens.
// The harness would never have shown it 30 MB. Claude Code truncates a Bash tool result, persists the
// full text to a file, and hands the model the truncated body plus a pointer to that file -- so the
// counterfactual a saving must be measured against is the TRUNCATED size, not the original size.
// Booking the original is the accounting-honesty failure this module exists to prevent: a saving is
// real only in the billing unit, on the branch that actually blocks the cost.

import { detectHarness } from './bridges/registry.js'
import type { HarnessName } from './bridges/types.js'

/**
 * Bytes of a Bash tool result Claude Code delivers inline before it persists the rest to disk.
 *
 * Derived by CAPTURE from the recorded session corpus (174,678 Bash results, 1,935 of them
 * persisted): the smallest output that WAS persisted measured 20,013 bytes and the largest that was
 * NOT measured 19,990 -- a 23-byte gap with nothing in between. This is the TRIGGER threshold, not
 * the delivered size: once crossed, the model does not receive up to this many bytes inline, it
 * receives a short `<persisted-output>` preview naming the file (see
 * {@link CLAUDE_CODE_PERSISTED_PREVIEW_BYTES}). A rewrite of an oversized output still remains
 * net-positive against that smaller preview. This constant corrects what gets RECORDED and must
 * never be used to suppress a rewrite.
 */
export const CLAUDE_CODE_BASH_OUTPUT_CAP_BYTES = 20_000

/**
 * Bytes of its own text Claude Code actually shows the model once an over-cap Bash result is
 * persisted, not the full {@link CLAUDE_CODE_BASH_OUTPUT_CAP_BYTES} head. CAPTURE: live-tested
 * against Claude Code 2.1.276 (`claude --print --model haiku --setting-sources ""`, 41-43 KB
 * outputs), whose own wrapper reads "Preview (first 2KB)" literally -- see memory
 * project_persisted_bash_output_hook_sees_20k_head_model_sees_2kb.md. Applies whether the
 * persisted output is the command's own raw text or a token-goat rewrite that kept
 * `persistedOutputPath`, since the harness re-checks the field it is handed either way.
 */
export const CLAUDE_CODE_PERSISTED_PREVIEW_BYTES = 2048

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
 * Cut `text` back so that it plus `reserveBytes` of framing still fits the harness delivery cap.
 *
 * A rewrite that overruns the cap does not merely lose its tail. The harness truncates from the
 * END, which is exactly where a closing fence tag and a recall pointer sit, and it PERSISTS the
 * substitute -- so an over-long rewrite ships an unterminated fence and destroys the only route
 * back to the original. Callers therefore reserve the bytes of everything they intend to wrap
 * around `text` and clip the payload, never the framing.
 *
 * The cut lands on the last complete line so the boundary is one the model can read, which also
 * drops any multi-byte character a byte-wise slice split in half. Returns the text unchanged when
 * the harness has no measured cap or the payload already fits.
 */
export function clipToDeliveryCap(text: string, reserveBytes: number): { text: string; clipped: boolean } {
  const cap = bashOutputCapBytes()
  const room = cap === null ? null : cap - reserveBytes
  if (room === null || room <= 0 || Buffer.byteLength(text, 'utf-8') <= room) return { text, clipped: false }
  const sliced = Buffer.from(text, 'utf-8').subarray(0, room).toString('utf-8')
  const lastNewline = sliced.lastIndexOf('\n')
  return { text: lastNewline > 0 ? sliced.slice(0, lastNewline) : sliced, clipped: true }
}

/**
 * The portion of originalBytes the model would actually have received, given the active harness.
 *
 * This is the single definition of the counterfactual every Bash saving is measured against. Both
 * the CLI wrapper path (bash_runner) and the hook rewrite path (hooks_bash) route their recorded
 * figure through it, so the two cannot drift apart. Crossing the cap does not deliver up to `cap`
 * bytes inline -- Claude Code persists the rest and shows only CLAUDE_CODE_PERSISTED_PREVIEW_BYTES
 * of preview, so crediting the full cap there over-counts what the model actually saw.
 */
export function deliveredOutputBytes(originalBytes: number, harness?: HarnessName): number {
  const cap = bashOutputCapBytes(harness)
  if (cap === null) return Math.max(0, originalBytes)
  if (originalBytes <= cap) return Math.max(0, originalBytes)
  return CLAUDE_CODE_PERSISTED_PREVIEW_BYTES
}
