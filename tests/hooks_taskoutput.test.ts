import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// Importing relay registers EVERY hook module (including hooks_taskoutput) for its
// side-effects, so runHook dispatches through the real production registry --
// not a test-only handler reference. buildEvent maps a Claude Code payload onto
// a HookEvent exactly as relay() does on stdin.
import { buildEvent } from '../src/relay.js'
import { runHook } from '../src/hook_registry.js'

let tmpHome: string
let prevHome: string | undefined
let sessionId: string

beforeEach(() => {
  prevHome = process.env['TOKEN_GOAT_HOME']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hooks-taskoutput-'))
  process.env['TOKEN_GOAT_HOME'] = tmpHome
  sessionId = `to-${path.basename(tmpHome)}`
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

describe('TaskOutput poll-delta hook (real runHook dispatch)', () => {
  const toolName = 'TaskOutput'
  const taskId = 'task_1'

  // Comfortably above the default bash_compress.cache_min_bytes (512) floor so
  // savings/no-savings assertions are unambiguous.
  const bigChunk = 'x'.repeat(600)

  function postPayload(output: string, input: Record<string, unknown> = { task_id: taskId }): Record<string, unknown> {
    return { tool_name: toolName, tool_input: input, session_id: sessionId, tool_response: { output, status: 'running' } }
  }

  it('passes the first poll through untouched and caches it', async () => {
    const res = await runHook(buildEvent('post_tool_use', postPayload(bigChunk)))
    expect(res.hookType).toBe('pass')
  })

  it('rewrites a repeat poll with more accumulated output to just the delta', async () => {
    const first = await runHook(buildEvent('post_tool_use', postPayload(bigChunk)))
    expect(first.hookType).toBe('pass')

    const delta = 'y'.repeat(600)
    const second = await runHook(buildEvent('post_tool_use', postPayload(bigChunk + delta)))
    expect(second.hookType).toBe('rewriteOutput')
    if (second.hookType === 'rewriteOutput') {
      expect(second.updatedOutput).toContain(delta)
      expect(second.updatedOutput).not.toContain(bigChunk)
      expect(second.updatedOutput).toContain(taskId)
    }
  })

  it('rewrites an unchanged repeat poll to a short no-new-output marker', async () => {
    const first = await runHook(buildEvent('post_tool_use', postPayload(bigChunk)))
    expect(first.hookType).toBe('pass')

    const second = await runHook(buildEvent('post_tool_use', postPayload(bigChunk)))
    expect(second.hookType).toBe('rewriteOutput')
    if (second.hookType === 'rewriteOutput') {
      expect(second.updatedOutput).toContain('unchanged since last poll')
      expect(second.updatedOutput.length).toBeLessThan(bigChunk.length)
    }
  })

  // Proves the shared net-benefit gate (tool_filters/base.ts::isRewriteWorthwhile,
  // resolveMinNetSavingsBytes) is actually wired into this path: cranking the same
  // config key/env var bash_runner already used (TOKEN_GOAT_BASH_MIN_NET_SAVINGS_BYTES)
  // to an impossible floor flips both the unchanged-poll and delta-poll rewrites back
  // to pass, even though cache_min_bytes alone would have let them through.
  it('leaves an otherwise-rewritable unchanged/delta poll untouched when TOKEN_GOAT_BASH_MIN_NET_SAVINGS_BYTES is set impossibly high', async () => {
    const prevFloor = process.env['TOKEN_GOAT_BASH_MIN_NET_SAVINGS_BYTES']
    process.env['TOKEN_GOAT_BASH_MIN_NET_SAVINGS_BYTES'] = '10000000'
    try {
      const first = await runHook(buildEvent('post_tool_use', postPayload(bigChunk)))
      expect(first.hookType).toBe('pass')

      const unchanged = await runHook(buildEvent('post_tool_use', postPayload(bigChunk)))
      expect(unchanged.hookType).toBe('pass')

      const delta = 'y'.repeat(600)
      const withDelta = await runHook(buildEvent('post_tool_use', postPayload(bigChunk + delta)))
      expect(withDelta.hookType).toBe('pass')
    } finally {
      if (prevFloor === undefined) delete process.env['TOKEN_GOAT_BASH_MIN_NET_SAVINGS_BYTES']
      else process.env['TOKEN_GOAT_BASH_MIN_NET_SAVINGS_BYTES'] = prevFloor
    }
  })

  it('passes through an unchanged small poll (below the savings floor)', async () => {
    const small = 'small output'
    const first = await runHook(buildEvent('post_tool_use', postPayload(small)))
    expect(first.hookType).toBe('pass')

    const second = await runHook(buildEvent('post_tool_use', postPayload(small)))
    expect(second.hookType).toBe('pass')
  })

  it('passes through when the new output is not a simple append (buffer reset/rotation)', async () => {
    const first = await runHook(buildEvent('post_tool_use', postPayload(bigChunk)))
    expect(first.hookType).toBe('pass')

    const unrelated = 'z'.repeat(600)
    const second = await runHook(buildEvent('post_tool_use', postPayload(unrelated)))
    expect(second.hookType).toBe('pass')
  })

  it('still recognizes a simple append as a delta even after a secret-shaped token appeared in an earlier poll', async () => {
    // storeBlob() (disk_cache.ts) redacts secret-shaped tokens before persisting a blob, so once
    // this poll's snapshot round-trips through disk, a later poll's getBashOutput() sees the
    // REDACTED text back as `prior.output` while the live tool_response is still the raw text.
    // If the handler diffs raw `output` against that redacted `prior.output` directly, the
    // startsWith() append-check desyncs (mismatched lengths/content at the redacted span) and
    // falls through to the "buffer reset" branch on every subsequent poll -- permanently
    // disabling delta compression for this task the moment a secret-shaped token ever appears,
    // even though the accumulated output really is a simple append each time.
    // Prefix sized well above the notice's own byte cost so the delta rewrite's
    // net savings clear the shared floor (tool_filters/base.ts::isRewriteWorthwhile)
    // once the redacted `AKIA...` line is subtracted out. Lines are varied (not
    // repeated) so this doesn't also trip the first-poll collapseRepeatedLines path.
    const withSecret = `${Array.from({ length: 150 }, (_, i) => `line${i}`).join('\n')}\nAKIA${'1'.repeat(16)}\n`
    const first = await runHook(buildEvent('post_tool_use', postPayload(withSecret)))
    expect(first.hookType).toBe('pass')

    const appended = 'z'.repeat(600)
    const second = await runHook(buildEvent('post_tool_use', postPayload(withSecret + appended)))
    expect(second.hookType).toBe('rewriteOutput')
    if (second.hookType === 'rewriteOutput') {
      expect(second.updatedOutput).toContain('delta since last poll')
      expect(second.updatedOutput).toContain(appended)
    }
  })

  it('does not act on a call with no sessionId', async () => {
    const payload = { tool_name: toolName, tool_input: { task_id: taskId }, tool_response: { output: bigChunk }, session_id: '' }
    const res = await runHook(buildEvent('post_tool_use', payload))
    expect(res.hookType).toBe('pass')

    // Confirm nothing was cached under a real session either -- rerun with a real
    // session id and expect the first-poll pass-through, not a delta rewrite.
    const res2 = await runHook(buildEvent('post_tool_use', postPayload(bigChunk)))
    expect(res2.hookType).toBe('pass')
  })

  it('passes through a call with a missing/malformed task_id field', async () => {
    const missing = await runHook(buildEvent('post_tool_use', postPayload(bigChunk, {})))
    expect(missing.hookType).toBe('pass')

    const malformed = await runHook(buildEvent('post_tool_use', postPayload(bigChunk, { task_id: 42 })))
    expect(malformed.hookType).toBe('pass')
  })

  it('ignores a non-TaskOutput tool entirely', async () => {
    const res = await runHook(
      buildEvent('post_tool_use', {
        tool_name: 'BashOutput',
        tool_input: { bash_id: 'bash_1' },
        tool_response: { output: bigChunk },
        session_id: sessionId,
      }),
    )
    expect(res.hookType).toBe('pass')
  })

  it('passes through on an empty/missing tool result (nothing cached)', async () => {
    const res = await runHook(buildEvent('post_tool_use', postPayload('')))
    expect(res.hookType).toBe('pass')

    const res2 = await runHook(
      buildEvent('post_tool_use', { tool_name: toolName, tool_input: { task_id: taskId }, session_id: sessionId }),
    )
    expect(res2.hookType).toBe('pass')
  })

  it('scopes the poll cache per session -- a different session sees its own first poll', async () => {
    const first = await runHook(buildEvent('post_tool_use', postPayload(bigChunk)))
    expect(first.hookType).toBe('pass')

    const otherSessionPayload = {
      tool_name: toolName,
      tool_input: { task_id: taskId },
      tool_response: { output: bigChunk },
      session_id: `${sessionId}-other`,
    }
    const other = await runHook(buildEvent('post_tool_use', otherSessionPayload))
    expect(other.hookType).toBe('pass')
  })

  it('does not collide with a BashOutput cache entry sharing the same id string', async () => {
    const sharedId = 'shared_id_1'
    const bashPayload = {
      tool_name: 'BashOutput',
      tool_input: { bash_id: sharedId },
      tool_response: { output: bigChunk },
      session_id: sessionId,
    }
    const bashFirst = await runHook(buildEvent('post_tool_use', bashPayload))
    expect(bashFirst.hookType).toBe('pass')

    // A TaskOutput poll with the same id string, same session, should see its own
    // first poll -- not the BashOutput cache entry -- since the two use different
    // cache-id prefixes (bgpoll_ vs taskpoll_).
    const taskFirst = await runHook(buildEvent('post_tool_use', postPayload(bigChunk, { task_id: sharedId })))
    expect(taskFirst.hookType).toBe('pass')
  })

  it('collapses a repeat-storm already present in the very first poll payload', async () => {
    const preamble = 'startup line\n'
    const repeatedWarning = 'WARNING: deprecated flag used\n'.repeat(247)
    const firstOutput = preamble + repeatedWarning

    const first = await runHook(buildEvent('post_tool_use', postPayload(firstOutput)))
    expect(first.hookType).toBe('rewriteOutput')
    if (first.hookType === 'rewriteOutput') {
      expect(first.updatedOutput.length).toBeLessThan(repeatedWarning.length / 4)
      expect(first.updatedOutput).toContain('WARNING: deprecated flag used')
      expect(first.updatedOutput).toMatch(/×2\d\d/)
    }

    // The poll-snapshot cache must still hold the RAW (uncollapsed) first output --
    // not the collapsed copy -- since future delta diffs compare against the real
    // prior output. Confirm by appending more raw output and checking the delta
    // resolves cleanly as a simple append, not a buffer-reset mismatch.
    const moreOutput = 'z'.repeat(600)
    const second = await runHook(buildEvent('post_tool_use', postPayload(firstOutput + moreOutput)))
    expect(second.hookType).toBe('rewriteOutput')
    if (second.hookType === 'rewriteOutput') {
      expect(second.updatedOutput).toContain(moreOutput)
    }
  })

  it('passes the first poll through untouched when there is nothing to collapse', async () => {
    const res = await runHook(buildEvent('post_tool_use', postPayload(bigChunk)))
    expect(res.hookType).toBe('pass')
  })

  it('collapses many repeated consecutive lines within a delta poll payload', async () => {
    const firstOutput = 'preamble line\n'
    const first = await runHook(buildEvent('post_tool_use', postPayload(firstOutput)))
    expect(first.hookType).toBe('pass')

    const repeatedWarning = 'WARNING: deprecated flag used\n'.repeat(247)
    const second = await runHook(buildEvent('post_tool_use', postPayload(firstOutput + repeatedWarning)))
    expect(second.hookType).toBe('rewriteOutput')
    if (second.hookType === 'rewriteOutput') {
      // The collapsed form should be dramatically smaller than 247 raw repeats,
      // while still indicating how many times the line repeated.
      expect(second.updatedOutput.length).toBeLessThan(repeatedWarning.length / 4)
      expect(second.updatedOutput).toContain('WARNING: deprecated flag used')
      expect(second.updatedOutput).toMatch(/×2\d\d/)
    }
  })
})
