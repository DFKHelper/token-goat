/**
 * Content-class token estimation.
 *
 * Provenance: HAND-DERIVED for the arithmetic -- every expected number below is computed from the input and the published ratio, never read back out of the function under test. The two class ratios themselves are CAPTURE (tiktoken over 120 repository files, recorded in src/token_estimate.ts) and their ranges are already pinned by tests/compress_text_token_accounting.test.ts, so they are not re-asserted here.
 */
import { describe, expect, it } from 'vitest'

import { BYTES_PER_TOKEN, GUARD_MARGIN, classifyContent, creditDivisor, guardDivisor } from '../src/token_estimate.js'
import { estimateTokensFromLength } from '../src/overflow_guard.js'
import { savedTokensFromBytes } from '../src/stats.js'

/** A real base64url payload: 64 distinct characters, no whitespace. Built from the alphabet rather than pasted so the shape is visible, and repeated so the sample clears the classifier's minimum. */
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.repeat(16)

describe('content class divisors', () => {
  it('reproduces the two divisors this repository has always used, so nothing is re-priced by the class split', () => {
    // 4.0 for a credit and 3.0 for a guard are the numbers savedTokensFromBytes and estimateTokensFromLength divided by before content classes existed. GUARD_MARGIN is what keeps them related instead of independently editable.
    expect(creditDivisor()).toBe(4.0)
    expect(guardDivisor()).toBe(3.0)
    expect(guardDivisor()).toBe(creditDivisor() * GUARD_MARGIN)
  })

  it('keeps a guard above its own credit inside every class, which is the whole point of the margin', () => {
    for (const cls of ['text', 'dense'] as const) {
      for (const bytes of [200, 1200, 98765]) {
        expect(savedTokensFromBytes(bytes, cls), `${cls} at ${bytes} bytes`).toBeLessThan(estimateTokensFromLength(bytes, cls))
      }
    }
  })

  it('prices a dense payload roughly 2.8x a text one, which is the spread the flat divisor was losing', () => {
    // 1200 / 1.45 = 827.6 -> 828 by hand, against 1200 / 4 = 300.
    expect(savedTokensFromBytes(1200, 'dense')).toBe(828)
    expect(savedTokensFromBytes(1200, 'text')).toBe(300)
    expect(BYTES_PER_TOKEN.text / BYTES_PER_TOKEN.dense).toBeCloseTo(2.76, 2)
  })
})

describe('classifyContent', () => {
  it('calls a base64url payload dense', () => {
    expect(classifyContent(BASE64URL)).toBe('dense')
  })

  it('calls a hex dump dense', () => {
    expect(classifyContent('deadbeef0123456789abcdef'.repeat(20))).toBe('dense')
  })

  it('calls source text text, however long', () => {
    expect(classifyContent('export function widget(): number {\n  return 42\n}\n'.repeat(40))).toBe('text')
  })

  it('does not call a long uniform run dense, since a tokenizer merges a repeat rather than splitting it', () => {
    // The alphabet and whitespace tests alone both pass here. Without the distinct-character floor this priced 300 bytes of one letter at 276 tokens.
    expect(classifyContent('a'.repeat(3000))).toBe('text')
  })

  it('does not call minified punctuation-heavy source dense, and under-prices it rather than guessing', () => {
    expect(classifyContent('{"a":1,"b":[2,3],"c":{"d":"e"}},'.repeat(30))).toBe('text')
  })

  it('needs enough of a sample to call anything dense, so a hash inside a sentence stays a sentence', () => {
    expect(classifyContent('the commit is 9f2a4c1e8b7d6f3a and it landed yesterday')).toBe('text')
  })

  it('reaches the guard estimator through the text-holding overload, which is the only caller that can see the class', async () => {
    const { estimateTokens } = await import('../src/overflow_guard.js')
    // Same length, different class: the dense one must cost materially more than the source one.
    const source = 'export const widget = 42;\n'.repeat(20)
    const payload = BASE64URL.slice(0, source.length)
    expect(payload.length).toBe(source.length)
    expect(estimateTokens(payload)).toBeGreaterThan(estimateTokens(source) * 2)
  })
})
