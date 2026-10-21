import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as InjectionScan from '../src/injection_scan.js'

const fenceCalls = vi.hoisted(() => ({ count: 0 }))

vi.mock('../src/injection_scan.js', async (importOriginal) => {
  const real = await importOriginal<typeof InjectionScan>()
  return { ...real, fenceUntrustedFileContent: (text: string) => { fenceCalls.count += 1; return real.fenceUntrustedFileContent(text) } }
})

import { INLINE_SYMBOL_MAX_BYTES, decideInline, type InlineBody, type InlineInput } from '../src/inline_symbol_answer.js'

// HAND-DERIVED: the fence only adds bytes (it escapes and wraps, never shortens), so a raw body over the cap is over the cap once fenced; the rows count calls to the fence by structure, not by time.
function input(body: InlineBody): InlineInput {
  return { enabled: true, symbol: 'load', candidates: [{ name: 'load', file: 'src/a.py' }], staleness: { 'src/a.py': 'fresh' }, readBody: () => body }
}

describe('decideInline cap check on the raw body', () => {
  beforeEach(() => {
    fenceCalls.count = 0
  })

  it('answers over_cap for a raw body past the cap without fencing it', async () => {
    const text = '</untrusted-file-content '.repeat(Math.ceil(INLINE_SYMBOL_MAX_BYTES / 20))
    expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(INLINE_SYMBOL_MAX_BYTES)
    expect(await decideInline(input({ text, agreesWithIndex: true }))).toEqual({ name: 'over_cap' })
    expect(fenceCalls.count).toBe(0)
  })

  it('still fences a raw body at or under the cap', async () => {
    const text = 'a'.repeat(INLINE_SYMBOL_MAX_BYTES)
    expect(await decideInline(input({ text, agreesWithIndex: true }))).toMatchObject({ inline: text })
    expect(fenceCalls.count).toBe(1)
  })
})
