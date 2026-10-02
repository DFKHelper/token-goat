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

  // Provenance: HAND-DERIVED. String(1e21) is '1e+21' in JavaScript, which is how hooks_bash.ts renders a large `timeout_seconds` into `--timeout`, and parseInt stops at the first non-digit, so these read as 1 second.
  it('reads exponent and fractional forms as the number they spell, not their leading digits', () => {
    expect(parseTimeout('1e12', 120)).toBe(2147483)
    expect(parseTimeout(String(1e21), 120)).toBe(2147483)
    expect(parseTimeout('1.5e2', 120)).toBe(150)
    expect(parseTimeout('0.5', 120)).toBe(1)
    expect(parseTimeout('Infinity', 120)).toBe(2147483)
  })

  it('keeps reading a leading number past a trailing unit, and still rejects non-positive values', () => {
    expect(parseTimeout('30s', 120)).toBe(30)
    expect(parseTimeout(' 45 ', 120)).toBe(45)
    expect(parseTimeout('-5', 120)).toBe(120)
    expect(parseTimeout('-1e3', 120)).toBe(120)
  })
})
