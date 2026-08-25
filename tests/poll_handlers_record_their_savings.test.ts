/**
 * The BashOutput and TaskOutput poll handlers replace a large tool result with something much
 * smaller -- a suffix delta, a collapsed body, or a short "unchanged" notice -- and until now
 * recorded none of it. Every one of those rewrites is a real token saving that never appeared in
 * `token-goat stats`, so the two loudest poll paths in a long agent run read as if they saved
 * nothing at all.
 *
 * The saving is computed inside `emitRewrite` from the string actually returned, never from a
 * caller-supplied delta, so a recorded number cannot disagree with what the model received. These
 * tests pin that: the recorded bytes must equal originalBytes minus the emitted length, for the
 * literal output the handler returned.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted: spy on recordStat while still calling through, matching tests/redaction_stat_counts_what_is_emitted.test.ts.
vi.mock('../src/stats.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const real = original['recordStat'] as (...args: unknown[]) => void
  return { ...original, recordStat: vi.fn((...args: unknown[]) => real(...args)) }
})

import { buildEvent } from '../src/relay.js'
import { runHook } from '../src/hook_registry.js'
import { recordStat, kindToSource } from '../src/stats.js'

/** Comfortably over the poll handlers' cache_min_bytes floor so the rewrite branches engage. */
const BULK = Array.from({ length: 300 }, (_, i) => `line ${i} of accumulated build output`).join('\n')

let tmpHome: string
let prevHome: string | undefined
let sessionId: string

beforeEach(() => {
  prevHome = process.env['TOKEN_GOAT_HOME']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-savings-'))
  process.env['TOKEN_GOAT_HOME'] = tmpHome
  sessionId = `sv-${path.basename(tmpHome)}`
  vi.mocked(recordStat).mockClear()
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = prevHome
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

function bashPoll(output: string): Record<string, unknown> {
  return { tool_name: 'BashOutput', tool_input: { bash_id: 'bash_1' }, session_id: sessionId, tool_response: { output, status: 'running' } }
}

function taskPoll(output: string): Record<string, unknown> {
  return { tool_name: 'TaskOutput', tool_input: { task_id: 'task_1' }, session_id: sessionId, tool_response: { output, status: 'running' } }
}

/** Every savings call recorded since the last clear, as `[kind, bytesSaved]` pairs. Excludes `secret_redacted`, which counts placeholders rather than bytes. */
function savingsStats(): Array<[unknown, unknown]> {
  return vi
    .mocked(recordStat)
    .mock.calls.filter((c) => c[0] !== 'secret_redacted' && typeof c[1] === 'number' && (c[1] as number) > 0)
    .map((c) => [c[0], c[1]])
}

describe('BashOutput poll rewrites record what they saved', () => {
  it('records the delta branch as originalBytes minus the emitted output', async () => {
    const first = await runHook(buildEvent('post_tool_use', bashPoll(BULK)))
    expect(first.hookType).toBe('pass')

    vi.mocked(recordStat).mockClear()
    const full = `${BULK}\n${BULK}`
    const second = await runHook(buildEvent('post_tool_use', bashPoll(full)))
    expect(second.hookType).toBe('rewriteOutput')
    if (second.hookType !== 'rewriteOutput') return

    const expected = Buffer.byteLength(full, 'utf-8') - Buffer.byteLength(second.updatedOutput, 'utf-8')
    expect(expected, 'the fixture must actually shrink, or this asserts nothing').toBeGreaterThan(1000)
    expect(savingsStats()).toEqual([['bashoutput:delta', expected]])
  })

  it('records the unchanged-notice branch, where nearly the whole output is saved', async () => {
    await runHook(buildEvent('post_tool_use', bashPoll(BULK)))
    vi.mocked(recordStat).mockClear()

    const second = await runHook(buildEvent('post_tool_use', bashPoll(BULK)))
    expect(second.hookType).toBe('rewriteOutput')
    if (second.hookType !== 'rewriteOutput') return

    const expected = Buffer.byteLength(BULK, 'utf-8') - Buffer.byteLength(second.updatedOutput, 'utf-8')
    expect(savingsStats()).toEqual([['bashoutput:unchanged', expected]])
  })
})

describe('TaskOutput poll rewrites record what they saved', () => {
  it('records the collapse branch under a taskoutput kind', async () => {
    const repeated = Array.from({ length: 400 }, () => 'identical progress line').join('\n')
    const only = await runHook(buildEvent('post_tool_use', taskPoll(repeated)))
    expect(only.hookType).toBe('rewriteOutput')
    if (only.hookType !== 'rewriteOutput') return

    const expected = Buffer.byteLength(repeated, 'utf-8') - Buffer.byteLength(only.updatedOutput, 'utf-8')
    expect(savingsStats()).toEqual([['taskoutput:collapse', expected]])
  })
})

describe('the recorded kinds file under the right source', () => {
  it('puts bashoutput savings with bash and taskoutput savings with agent content', () => {
    expect(kindToSource('bashoutput:delta')).toBe(kindToSource('bash_compress:x'))
    expect(kindToSource('taskoutput:collapse')).toBe(kindToSource('agent_report_compact'))
  })

  it('never records a negative saving, so a total that sums these cannot be corrupted', () => {
    for (const [, bytes] of savingsStats()) expect(bytes as number).toBeGreaterThan(0)
  })
})
