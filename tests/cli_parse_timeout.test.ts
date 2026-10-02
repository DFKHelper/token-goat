import { describe, expect, it } from 'vitest'

import { parseTimeout } from '../src/cli.js'

// Provenance: CAPTURE setTimeout(fn, 3000000 * 1000) on Node 22 fires immediately with TimeoutOverflowWarning; the maximum delay is 2147483647 ms (Node docs, timers), so the largest safe whole-second value is 2147483.
describe('parseTimeout', () => {
  it('clamps a value whose millisecond form overflows setTimeout', () => {
    expect(parseTimeout('3000000', 120)).toBe(2147483)
    expect(parseTimeout('99999999999', 120)).toBe(2147483)
  })

  it('keeps ordinary values and the existing fallbacks', () => {
    expect(parseTimeout('300', 120)).toBe(300)
    expect(parseTimeout('2147483', 120)).toBe(2147483)
    expect(parseTimeout('0', 120)).toBe(120)
    expect(parseTimeout('abc', 120)).toBe(120)
    expect(parseTimeout(undefined, 120)).toBe(120)
  })
})
