// The harness delivery cap: a Bash saving may only be credited against what the model would
// actually have received, not against the full command output.
//
// FIXTURE PROVENANCE
// - The 20,000-byte cap is CAPTURE: measured across the recorded Claude Code session corpus
//   (174,678 Bash tool results, 1,935 of them persisted to a file). The smallest output that WAS
//   persisted measured 20,013 bytes; the largest that was NOT measured 19,990. A 23-byte gap with
//   nothing in between fixes the cap at 20,000. No transcript content is reproduced here, only that
//   boundary number.
// - Every expected byte/token figure below is HAND-DERIVED: computed in the test from the emitted
//   string's own length and the stated cap, never read back from the producer's savings formula.
//   A fixture written from token-goat's own accounting would agree with the bug by construction --
//   that is precisely how the over-crediting this file pins went unnoticed.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { HookEvent } from '../src/hook_registry.js'

vi.mock('../src/stats.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const real = original['recordStat'] as (...args: unknown[]) => void
  return { ...original, recordStat: vi.fn((...args: unknown[]) => real(...args)) }
})

import { postBashHandler } from '../src/hooks_bash.js'
import { recordStat } from '../src/stats.js'
import { makeHookEvent } from './helpers/hook-event.js'
import { CLAUDE_CODE_BASH_OUTPUT_CAP_BYTES, bashOutputCapBytes, deliveredOutputBytes } from '../src/delivery_cap.js'

const CAP = 20_000

function makePostBashEvent(command: string, output: string): HookEvent {
  return makeHookEvent({
    eventName: 'post_tool_use',
    toolName: 'Bash',
    toolInput: { command },
    sessionId: 'delivery-cap-session',
    agentId: undefined,
    raw: { tool_name: 'Bash', tool_input: { command }, tool_response: output },
  })
}

function genericSavings(): Array<[number, number]> {
  const calls = (recordStat as unknown as { mock: { calls: unknown[][] } }).mock.calls
  return calls.filter((c) => c[0] === 'bash_compress:generic').map((c) => [c[1] as number, c[2] as number])
}

// The suite inherits CLAUDE_CODE_SESSION_ID when it is run from inside a Claude Code session, so
// detectHarness() answers 'claudecode' locally and something else in CI. Every test here pins the
// harness explicitly rather than letting the ambient environment decide which branch it exercises.
let savedOverride: string | undefined

describe('Bash savings are credited against the harness delivery cap', () => {
  beforeEach(() => {
    ;(recordStat as unknown as { mockClear: () => void }).mockClear()
    savedOverride = process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
    process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'claudecode'
  })
  afterEach(() => {
    if (savedOverride === undefined) delete process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
    else process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = savedOverride
  })

  it('exposes the measured cap as the Claude Code constant', () => {
    expect(CLAUDE_CODE_BASH_OUTPUT_CAP_BYTES).toBe(CAP)
    expect(bashOutputCapBytes('claudecode')).toBe(CAP)
  })

  it('caps an above-cap original at the delivered size', () => {
    expect(deliveredOutputBytes(30_000_000, 'claudecode')).toBe(CAP)
    expect(deliveredOutputBytes(CAP + 1, 'claudecode')).toBe(CAP)
  })

  it('leaves a below-cap original untouched', () => {
    expect(deliveredOutputBytes(19_990, 'claudecode')).toBe(19_990)
    expect(deliveredOutputBytes(CAP, 'claudecode')).toBe(CAP)
  })

  // The cap is Claude Code's measured behaviour, not a universal. Applying it to a harness whose
  // real limit is different would under-credit, which is the same class of error as over-crediting.
  it('does not cap a harness with no measured limit', () => {
    const uncapped = ['codex', 'opencode', 'gemini'] as const
    expect(uncapped.length).toBeGreaterThan(0)
    for (const h of uncapped) {
      expect(bashOutputCapBytes(h)).toBeNull()
      expect(deliveredOutputBytes(30_000_000, h)).toBe(30_000_000)
    }
  })

  // The load-bearing case: an output far above the cap must be credited at cap-minus-emitted, never
  // at original-minus-emitted. Both figures are computed here from the emitted string, independently
  // of the producer.
  it('credits an above-cap command at the delivered size minus what it emitted', async () => {
    const dup = 'this is a repeated noisy progress line that dedupes away\n'.repeat(3000)
    expect(Buffer.byteLength(dup, 'utf-8')).toBeGreaterThan(CAP * 5)
    const result = await postBashHandler(makePostBashEvent('grep pattern app.log | sort', dup))
    expect(result.hookType).toBe('rewriteOutput')
    if (result.hookType !== 'rewriteOutput') return
    const emitted = Buffer.byteLength(result.updatedOutput, 'utf-8')
    expect(emitted).toBeLessThan(CAP)
    const expectedBytes = CAP - emitted
    expect(genericSavings()).toEqual([[expectedBytes, Math.round(expectedBytes / 4)]])
    // Guard the specific over-crediting shape this fix removes, rather than only the exact value:
    // the old figure was the full original minus the emitted body.
    const uncappedFigure = Buffer.byteLength(dup, 'utf-8') - emitted
    expect(genericSavings()[0]![0]).toBeLessThan(uncappedFigure)
  })

  // NON-FIRING GUARD: the cap must not touch ordinary below-cap traffic, which is nearly all of it.
  // Asserts over a non-empty set, with non-emptiness asserted before the loop, and requires each
  // case to book its FULL uncapped saving -- so a fix that clamps everything fails here.
  it('non-firing: leaves every below-cap compression crediting its full original', async () => {
    const cases = [
      'short repeated line that dedupes\n'.repeat(120),
      'another modest repeated progress line\n'.repeat(200),
      'a third below-cap repeated body line\n'.repeat(300),
    ]
    expect(cases.length).toBeGreaterThan(0)
    let asserted = 0
    for (const body of cases) {
      const originalBytes = Buffer.byteLength(body, 'utf-8')
      expect(originalBytes).toBeLessThan(CAP)
      ;(recordStat as unknown as { mockClear: () => void }).mockClear()
      const result = await postBashHandler(makePostBashEvent('grep pattern build.log | sort', body))
      if (result.hookType !== 'rewriteOutput') continue
      const emitted = Buffer.byteLength(result.updatedOutput, 'utf-8')
      const rows = genericSavings()
      expect(rows).toEqual([[originalBytes - emitted, Math.round((originalBytes - emitted) / 4)]])
      asserted += 1
    }
    // A silent skip must never read as a pass: if the fixtures stopped producing rewrites this
    // guard would assert nothing at all, so require that it actually exercised the branch.
    expect(asserted).toBeGreaterThan(0)
  })
})
