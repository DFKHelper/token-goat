/**
 * `readStdinJson`'s timeout is an IDLE timeout, not a deadline on the whole read.
 *
 * It used to be armed once in the promise constructor and never rescheduled, so it was an
 * absolute deadline: a payload that streamed steadily for longer than the timeout was thrown
 * away mid-delivery even though stdin was never idle. That capped the accepted payload at
 * whatever fits through the pipe in five seconds rather than at MAX_STDIN_BYTES, the 64 MB the
 * module deliberately allows -- and `relay` turns the rejection into an empty payload, so the
 * hook exited 0 with valid `{}` on stdout and read-dedup, image shrinking and the dirty-queue
 * enqueue all silently stopped for that call.
 */
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it } from 'vitest'

import { readStdinJson } from '../src/stdin_json.js'

const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin')

/** Swap `process.stdin` for a stream this test drives directly. */
function useFakeStdin(): PassThrough {
  const fake = new PassThrough()
  Object.defineProperty(process, 'stdin', { value: fake, configurable: true })
  return fake
}

afterEach(() => {
  if (realStdin !== undefined) Object.defineProperty(process, 'stdin', realStdin)
})

/** Resolve after `ms`, as a plain promise so the test body reads sequentially. */
function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

describe('readStdinJson on a stream that is slow but never idle', () => {
  it('accepts a payload that takes longer than the timeout to arrive', async () => {
    const IDLE_MS = 200
    const CHUNKS = 6
    const GAP_MS = 80
    // 6 chunks 80 ms apart is 480 ms of streaming against a 200 ms timeout: comfortably past an
    // absolute deadline, and comfortably inside an idle one at every individual gap.
    const fake = useFakeStdin()
    const pending = readStdinJson(IDLE_MS)

    const values = Array.from({ length: CHUNKS }, (_, i) => `"v${i}"`)
    fake.write('[')
    for (let i = 0; i < CHUNKS; i++) {
      await wait(GAP_MS)
      fake.write(i === 0 ? values[i] : `,${values[i]}`)
    }
    fake.write(']')
    fake.end()

    await expect(pending).resolves.toEqual(['v0', 'v1', 'v2', 'v3', 'v4', 'v5'])
  })

  it('still rejects a stream that goes quiet for longer than the timeout', async () => {
    // The fix must not become "no timeout at all" -- a sender that stalls mid-payload has to
    // still be given up on, or a hung upstream stalls the tool call indefinitely.
    const fake = useFakeStdin()
    const pending = readStdinJson(150)

    fake.write('{"a":')
    // ...and then nothing. Never ended, so only the timeout can settle this.

    await expect(pending).rejects.toThrow(/timed out waiting for stdin/)
  })

  it('rejects a stream that goes quiet before sending anything at all', async () => {
    useFakeStdin()

    await expect(readStdinJson(120)).rejects.toThrow(/timed out waiting for stdin/)
  })
})
