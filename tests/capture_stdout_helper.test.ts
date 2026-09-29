/** Pins tests/helpers/capture-stdout.ts, which 12 test files share. It used to forward every captured chunk to the real stdout, so tests/graph_commands.test.ts put 2.3 MB of `types --json` on the terminal on each run; it also dropped Buffer chunks from the capture while forwarding them. Provenance: HAND-DERIVED. The chunks are made up and the expected capture is their concatenation. */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { captureStdout } from './helpers/capture-stdout.js'

const realWrite = process.stdout.write

afterEach(() => {
  process.stdout.write = realWrite
})

/** Installs a spy as the stdout writer the helper will see as the original, so a forwarded chunk shows up as a spy call instead of on the terminal. */
function spyStdout(): ReturnType<typeof vi.fn> {
  const spy = vi.fn(() => true)
  process.stdout.write = spy as unknown as typeof process.stdout.write
  return spy
}

describe('captureStdout', () => {
  it('captures string and Buffer chunks in order', () => {
    spyStdout()
    const out = captureStdout(() => {
      process.stdout.write('alpha ')
      process.stdout.write(Buffer.from('beta ', 'utf8'))
      process.stdout.write(new Uint8Array([0x67, 0x61, 0x6d, 0x6d, 0x61]))
    })
    expect(out).toBe('alpha beta gamma')
  })

  it('does not forward captured output to the real stdout', () => {
    const spy = spyStdout()
    captureStdout(() => {
      process.stdout.write('quiet\n')
    })
    expect(spy).not.toHaveBeenCalled()
  })

  it('calls a write callback, whichever argument carries it', () => {
    spyStdout()
    const direct = vi.fn()
    const afterEncoding = vi.fn()
    captureStdout(() => {
      process.stdout.write('a', direct)
      process.stdout.write('b', 'utf8', afterEncoding)
    })
    expect(direct).toHaveBeenCalledTimes(1)
    expect(afterEncoding).toHaveBeenCalledTimes(1)
  })

  it('restores the original writer even when the body throws', () => {
    const spy = spyStdout()
    expect(() => captureStdout(() => {
      throw new Error('boom')
    })).toThrow('boom')
    process.stdout.write('after\n')
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
