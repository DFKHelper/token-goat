/**
 * A rewrite that replaces what the model reads is built in exactly one place.
 *
 * `rewriteOutput` is the shape that swaps the harness's own tool result for text token-goat wrote.
 * That makes it the point where two obligations land together: the emitted text is now the only
 * copy the model sees, so any redaction in it is what protected that copy, and nothing downstream
 * knows what the rewrite removed, so the emit is the only place that can price it. `emitRewrite`
 * does both. Five sites hand-built the object literal instead, and each omission was a silence
 * rather than an error: the compound-bash path booked no redaction count at all even though its
 * filter pipeline was redacting, because the only other producer that could have booked it is the
 * disk cache, which receives text already cleaned by `bash_output_cache` and so counts zero.
 *
 * Provenance: HAND-DERIVED. The secret is written here and the expectation is its absence from the
 * emitted text, computed without reference to any matcher in `src/`. The structural case is a
 * source scan. The fixture puts the secret on the FIRST line deliberately: an earlier draft buried
 * it between two blocks of noise, the compressor's head/tail elision dropped that middle, and the
 * test then passed whether or not any redaction ran at all.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { HookEvent } from '../src/hook_registry.js'

vi.mock('../src/stats.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const real = original['recordStat'] as (...args: unknown[]) => void
  return { ...original, recordStat: vi.fn((...args: unknown[]) => real(...args)) }
})

import { postBashHandler } from '../src/hooks_bash.js'
import { recordStat } from '../src/stats.js'
import { makeHookEvent } from './helpers/hook-event.js'

/** The files allowed to name this shape: the one constructor, and the type declaration it satisfies. */
const CONSTRUCTION_ALLOWED = new Set(['src/hooks_common.ts', 'src/types.ts'])

/** The literal credential, written here rather than read back out of the pattern that catches it. */
const SECRET = 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY'

function makePostBashEvent(command: string, output: string): HookEvent {
  return makeHookEvent({
    eventName: 'post_tool_use',
    toolName: 'Bash',
    toolInput: { command },
    sessionId: 'rewrite-pin-session',
    agentId: undefined,
    raw: { tool_name: 'Bash', tool_input: { command }, tool_response: output },
  })
}

function statCalls(kind: string): unknown[][] {
  const calls = (recordStat as unknown as { mock: { calls: unknown[][] } }).mock.calls
  return calls.filter((c) => c[0] === kind)
}

/** Long enough to clear the size floor and compress well, with the credential on the first line so the compressor's elision cannot remove it and make the assertion vacuous. */
function outputWithSecret(): string {
  return `AWS_SECRET_ACCESS_KEY=${SECRET}\n` + 'downloading chunk from the artifact mirror, retrying shortly\n'.repeat(3000)
}

describe('rewriteOutput construction', () => {
  beforeEach(() => {
    ;(recordStat as unknown as { mockClear: () => void }).mockClear()
  })

  it('happens only in hooks_common, so no site can emit without accounting for what it emitted', () => {
    // Structural half. Every defect this file covers was invisible for the same reason: a
    // hand-built literal type-checks perfectly, and what it omits (a redaction count, a stat, the
    // right divisor) produces silence rather than an error. Matching `hookType:` and not
    // `hookType ===` keeps comparisons and the bridges' string handling out of it.
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.ts')) {
          const rel = path.relative(process.cwd(), full).split(path.sep).join('/')
          if (CONSTRUCTION_ALLOWED.has(rel)) continue
          for (const [i, line] of fs.readFileSync(full, 'utf8').split('\n').entries()) {
            if (/hookType\s*:\s*'rewriteOutput'/.test(line)) offenders.push(`${rel}:${i + 1}`)
          }
        }
      }
    }
    walk(path.join(process.cwd(), 'src'))
    expect(offenders, 'each of these builds a rewriteOutput by hand: call emitRewrite in src/hooks_common.ts instead, which counts, prices and constructs the emit in one place').toEqual([])
  })

  it('never hands the model a raw credential in the body it composed', async () => {
    const result = await postBashHandler(makePostBashEvent('grep chunk build.log | sort', outputWithSecret()))

    expect(result.hookType, 'the fixture must be large and repetitive enough to trigger the rewrite, or this asserts nothing').toBe('rewriteOutput')
    const emitted = (result as { updatedOutput: string }).updatedOutput
    expect(emitted, 'this body replaces what the model sees, so a secret surviving in it reaches the model in full').not.toContain(SECRET)
    expect(emitted, 'and the line itself must still be present, or the assertion above passes by deletion').toContain('AWS_SECRET_ACCESS_KEY=')
  })

  it('books the redaction that protected that body, which nothing used to book', async () => {
    await postBashHandler(makePostBashEvent('grep chunk other.log | sort', outputWithSecret()))

    // The cache copy is redacted by bash_output_cache before disk_cache's own pass runs, so
    // disk_cache finds nothing left to strip and counts zero. This emit is the only place the
    // protection applied to the model's copy can be counted, and before it routed through
    // emitRewrite it counted nothing.
    const calls = statCalls('secret_redacted')
    expect(calls.length, 'one redaction of one output must produce exactly one count').toBe(1)
    expect(calls[0]?.[2], 'the count is the number of placeholders, and the fixture carries one secret').toBe(1)
    // A count is not a token saving; this callsite is one of the producers the count-kind scan names.
    expect(calls[0]?.[1]).toBe(0)
  })
})
