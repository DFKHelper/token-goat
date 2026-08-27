import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { HookEvent } from '../src/hook_registry.js'

vi.mock('../src/stats.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const real = original['recordStat'] as (...args: unknown[]) => void
  return { ...original, recordStat: vi.fn((...args: unknown[]) => real(...args)) }
})

import { postBashHandler } from '../src/hooks_bash.js'
import { recordStat } from '../src/stats.js'
import { makeHookEvent } from './helpers/hook-event.js'

function makePostBashEvent(command: string, output: string): HookEvent {
  return makeHookEvent({
    eventName: 'post_tool_use',
    toolName: 'Bash',
    toolInput: { command },
    sessionId: 'compound-savings-session',
    agentId: undefined,
    raw: { tool_name: 'Bash', tool_input: { command }, tool_response: output },
  })
}

/** Every `bash_compress:generic` call the mocked recordStat saw, as [bytesSaved, tokensSaved] pairs. */
function genericSavings(): Array<[number, number]> {
  const calls = (recordStat as unknown as { mock: { calls: unknown[][] } }).mock.calls
  return calls
    .filter((c) => c[0] === 'bash_compress:generic')
    .map((c) => [c[1] as number, c[2] as number])
}

describe('compound-output compression savings accounting', () => {
  beforeEach(() => {
    ;(recordStat as unknown as { mockClear: () => void }).mockClear()
  })

  // The rewrite this path ships is the filter body PLUS the filter's own trailing marker PLUS a
  // `full output: bash-output <id> --full` recall pointer. The recorded saving must be measured
  // against that emitted body, not against the filter's marker-less `bytesSaved`, which credits
  // the run for bytes the model still receives.
  it('records exactly the bytes removed from what the model actually receives', async () => {
    const dup = 'this is a repeated noisy progress line that dedupes away\n'.repeat(3000)
    const result = await postBashHandler(makePostBashEvent('grep pattern app.log | sort', dup))
    expect(result.hookType).toBe('rewriteOutput')
    if (result.hookType !== 'rewriteOutput') return
    const emitted = Buffer.byteLength(result.updatedOutput, 'utf-8')
    const original = Buffer.byteLength(dup, 'utf-8')
    const expectedBytes = original - emitted
    expect(genericSavings()).toEqual([[expectedBytes, Math.max(1, Math.floor(expectedBytes / 3) + 1)]])
  })

  // Control for the over-fix direction: the saving must still be the real (large) reduction, not
  // some degenerate small number, so a fix that under-credits fails here too.
  it('still credits the bulk of a highly compressible output', async () => {
    const dup = 'another repeated noisy progress line that dedupes away\n'.repeat(3000)
    const result = await postBashHandler(makePostBashEvent('grep other app.log | sort', dup))
    expect(result.hookType).toBe('rewriteOutput')
    if (result.hookType !== 'rewriteOutput') return
    const original = Buffer.byteLength(dup, 'utf-8')
    const [saved] = genericSavings()[0]!
    expect(saved).toBeGreaterThan(original * 0.9)
    expect(saved).toBeLessThan(original)
  })

  /** Forty distinct filler lines plus `repeats` copies of one line: the generic filter collapses the run, so the reduction scales one line at a time and can be parked on either side of the 100-byte net-benefit floor. */
  function tunedOutput(repeats: number): string {
    const filler = Array.from({ length: 40 }, (_, i) => `distinct line number ${i} with padding text here`).join('\n')
    return filler + '\n' + 'a repeated line xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n'.repeat(repeats)
  }

  // Measured against the built pipeline: at six repeats the emitted body is 2058 bytes against a
  // 2152-byte original, a true reduction of 94 bytes -- under the 100-byte min_net_savings_bytes
  // floor. Pricing only the filter's own marker (and not the recall pointer) let this ship as a
  // rewrite and record a 162-byte saving for it.
  it('declines a rewrite whose true reduction is under the net-benefit floor', async () => {
    const result = await postBashHandler(makePostBashEvent('grep under app.log | sort', tunedOutput(6)))
    expect(result.hookType).toBe('pass')
    expect(genericSavings()).toEqual([])
  })

  // Control one repeat up: 141 bytes truly removed, comfortably over the floor, so the rewrite must
  // still ship. A fix that simply tightened the gate too far would fail here.
  it('still ships a rewrite whose true reduction clears the net-benefit floor', async () => {
    const output = tunedOutput(7)
    const result = await postBashHandler(makePostBashEvent('grep over app.log | sort', output))
    expect(result.hookType).toBe('rewriteOutput')
    if (result.hookType !== 'rewriteOutput') return
    const expectedBytes = Buffer.byteLength(output, 'utf-8') - Buffer.byteLength(result.updatedOutput, 'utf-8')
    expect(expectedBytes).toBeGreaterThanOrEqual(100)
    expect(genericSavings()).toEqual([[expectedBytes, Math.max(1, Math.floor(expectedBytes / 3) + 1)]])
  })
})
