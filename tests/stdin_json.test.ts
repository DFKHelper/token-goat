/** `readStdinJson`'s timeout is an IDLE timeout, not a deadline on the whole read. It used to be armed once in the promise constructor and never rescheduled, so it was an absolute deadline: a payload that streamed steadily for longer than the timeout was thrown away mid-delivery even though stdin was never idle. That capped the accepted payload at whatever fits through the pipe in five seconds rather than at MAX_STDIN_BYTES, the 64 MB the module deliberately allows -- and `relay` turns the rejection into an empty payload, so the hook exited 0 with valid `{}` on stdout and read-dedup, image shrinking and the dirty-queue enqueue all silently stopped for that call. */
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'

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
    // 6 chunks 80 ms apart is 480 ms of streaming against a 200 ms timeout: comfortably past an absolute deadline, and comfortably inside an idle one at every individual gap.
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
    // The fix must not become "no timeout at all" -- a sender that stalls mid-payload has to still be given up on, or a hung upstream stalls the tool call indefinitely.
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

describe('readStdinJson before the first byte', () => {
  it('waits past one idle window for a first chunk that arrives late', async () => {
    // HAND-DERIVED: the 100 ms idle window elapses twice over before the first chunk; the pre-first-byte window is wider (4x), so a late first delivery from a starved process still parses.
    const fake = useFakeStdin()
    const pending = readStdinJson(100)
    await wait(250)
    fake.end('{"late":true}')
    await expect(pending).resolves.toEqual({ late: true })
  })

  it('gives up on a pipe that stays open and silent, so a hook with no payload does not hang', async () => {
    // HAND-DERIVED: the parent holds the child's stdin open and writes nothing; the child must reject within its widened first-byte window (4 x 100 ms), far inside the 30 s cap below.
    const moduleUrl = pathToFileURL(join(process.cwd(), 'src', 'stdin_json.ts')).href
    const child = [
      `const { readStdinJson } = await import(${JSON.stringify(moduleUrl)})`,
      "readStdinJson(100).then(() => console.log('resolved'), (e) => console.log('rejected', e.message))",
    ].join('\n')
    const proc = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', child], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    // The child's own stdin stays open, so it would idle until the cap; the verdict line is the evidence, so stop it as soon as it is printed.
    proc.stdout.on('data', (d: Buffer) => {
      out += d.toString()
      if (out.includes('\n')) proc.kill()
    })
    const cap = setTimeout(() => proc.kill(), 30_000)
    await new Promise((r) => proc.on('close', r))
    clearTimeout(cap)
    expect(out.trim()).toMatch(/^rejected .*timed out waiting for stdin/)
  }, 60_000)
})

describe('readStdinJson in a process starved past its idle window', () => {
  // A PassThrough cannot show this: its data arrives on a microtask, before any timer could fire. Only a real pipe makes the payload wait for the event loop's poll phase, which runs after its timers.
  it('reads a payload already in the pipe instead of timing out on it', () => {
    // HAND-DERIVED: the child arms a 100 ms idle window and then holds its event loop for 400 ms, the shape a hook process takes on a machine too busy to schedule it; the payload was written and the pipe closed at spawn, so stdin was never idle from the sender's side.
    const moduleUrl = pathToFileURL(join(process.cwd(), 'src', 'stdin_json.ts')).href
    const child = [
      `const { readStdinJson } = await import(${JSON.stringify(moduleUrl)})`,
      'const pending = readStdinJson(100)',
      'const end = Date.now() + 400',
      'while (Date.now() < end) {}',
      "pending.then((v) => console.log('resolved', JSON.stringify(v)), (e) => console.log('rejected', e.message))",
    ].join('\n')
    const res = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', child], { input: '{"ok":1}', cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 })
    expect(res.stdout.trim(), res.stderr).toBe('resolved {"ok":1}')
  }, 90_000)
})

describe('readStdinJson when the pipe delivers after the idle timer fires', () => {
  // HAND-DERIVED: a Windows pipe read lands several loop turns after the poll that sees it start (a thread-pool wait, then the read), so the bytes arrive after the idle timer and after its first setImmediate. Here the fake delivers on the second immediate after a timer due inside the same blocked stretch, which the old one-deferral verdict rejected before the bytes came.
  it('reads a payload that lands two loop turns after the idle timer fired', async () => {
    const fake = useFakeStdin()
    const pending = readStdinJson(100, undefined, 1)
    setTimeout(() => setImmediate(() => setImmediate(() => fake.end('{"late":2}'))), 150)
    const end = Date.now() + 250
    while (Date.now() < end) {
      // hold the event loop past the idle window, as a starved process does
    }
    await expect(pending).resolves.toEqual({ late: 2 })
  })

  // HAND-DERIVED: a complete JSON object is buffered and the sender's EOF has not been seen; the stream stays open past the idle window, as a starved process sees it. The document is whole, so it is the payload.
  it('accepts a complete object left waiting on the EOF', async () => {
    const fake = useFakeStdin()
    const pending = readStdinJson(100)
    fake.write('{"whole":true}')
    await expect(pending).resolves.toEqual({ whole: true })
  })

  // HAND-DERIVED: a prefix that parses is not a document; only an object or array counts, so a truncated number still times out.
  it('does not take a scalar left waiting on the EOF as the payload', async () => {
    const fake = useFakeStdin()
    const pending = readStdinJson(100)
    fake.write('12')
    await expect(pending).rejects.toThrow(/timed out waiting for stdin/)
  })
})
