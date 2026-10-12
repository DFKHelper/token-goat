/** Proportional guard pricing across the caps. Provenance: HAND-DERIVED -- every expected count is computed from the guard divisors (text 3.0 units per token, wide 0.9) and the input, never read back out of the function under test. The 0.9 rests on the tiktoken measurements in tests/token_estimate.test.ts and tests/fixtures/token_estimate/wide_rate_cpython_cjk.tsv. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { invalidateConfigCache } from '../src/config.js'
import { capListField } from '../src/fence_cap.js'
import { capJsonRows, estimateTokens, trimToBudget } from '../src/overflow_guard.js'
import { guardTokens } from '../src/token_estimate.js'

/** An ASCII filler of exactly `n` characters with word breaks, so it classifies as text. */
const ascii = (n: number): string => 'abcdefghi '.repeat(Math.ceil(n / 10)).slice(0, n)

describe('a mixed line is priced part by part', () => {
  // Budget 200 leaves a 200 - 64 = 136-token body. A line of w wide and a ASCII units costs w / 0.9 + (a + 1) / 3 with its newline.
  it('prices 25 and 35 wide units in 100 alike, with no cliff at 30 percent (fail-on-buggy: a whole-line class gave 4 lines then 1)', () => {
    // 25 wide: 27.78 + 25.33 = 53.1, so 2 lines fit (106.2) and a third (159.3) does not. 35 wide: 38.89 + 22.0 = 60.9, 2 fit (121.8), 3 do not (182.7).
    const quarter = Array.from({ length: 50 }, () => '日'.repeat(25) + ascii(75)).join('\n')
    const third = Array.from({ length: 50 }, () => '日'.repeat(35) + ascii(65)).join('\n')
    expect(trimToBudget(quarter, 200)).toContain('showing 2 of 50 lines')
    expect(trimToBudget(third, 200)).toContain('showing 2 of 50 lines')
  })

  it('keeps the whole-text estimate and the per-line cost on one price', () => {
    // A 50-line text of 30 wide + 70 ASCII is priced 50 * (33.33 + 23.67) = 2850 tokens whole, and 57 a line when trimmed: 136 / 57 keeps 2.
    const text = Array.from({ length: 50 }, () => '日'.repeat(30) + ascii(70)).join('\n')
    expect(estimateTokens(text)).toBeGreaterThan(2700)
    expect(estimateTokens(text)).toBeLessThan(2900)
    const capped = trimToBudget(text, 200)
    expect(capped).toContain('showing 2 of 50 lines')
    const body = capped.slice(0, capped.lastIndexOf('[token-goat:'))
    expect(estimateTokens(body)).toBeLessThanOrEqual(136)
    expect(estimateTokens(body)).toBeGreaterThan(100)
  })
})

describe('a long hash line in English text', () => {
  it('is priced as text, not as a dense payload (fail-on-buggy: dense gave 236 tokens, over the whole body)', () => {
    // A 256-character base64url line costs 257 / 3 = 85.67 as text. Two 7-token lines before it and five after: 14 + 85.67 + 35 = 134.67 <= 136, a sixth makes 141.67. Priced dense (257 / 1.0875 = 236) it would stop after 2 lines.
    const hash = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.repeat(4)
    const english = 'abcdefghij klmnopqrs'
    const lines = [english, english, hash, ...Array.from({ length: 30 }, () => english)]
    expect(trimToBudget(lines.join('\n'), 200)).toContain('showing 8 of 33 lines')
  })
})

describe('CJK --json caps', () => {
  const item = { t: '日'.repeat(30) }

  it('capJsonRows keeps what the budget holds at the wide rate', () => {
    // Each row is {"t":"…"}: 30 wide units (33.33) and 8 others (2.67), plus the 2-unit separator (0.67) = 36.67. Two rows are 73.3 of 100, three 110.
    const { items, truncated, totalCount } = capJsonRows(Array.from({ length: 20 }, () => item), 100)
    expect(items.length).toBe(2)
    expect(truncated).toBe(true)
    expect(totalCount).toBe(20)
  })

  describe('capListField', () => {
    beforeEach(() => {
      process.env['TOKEN_GOAT_OVERFLOW_MAX_TOKENS'] = '1000'
      invalidateConfigCache()
    })
    afterEach(() => {
      delete process.env['TOKEN_GOAT_OVERFLOW_MAX_TOKENS']
      invalidateConfigCache()
    })

    it('holds a CJK listing to max_tokens, where a flat length-over-three cut left it at about three times that', () => {
      // A row prints 38 units of JSON plus a comma: 33.33 + 2.67 + 0.33 = 36.33 tokens, and the envelope (about 40 units) adds roughly 13. 27 rows are 981 + 13 = 994 <= 1000, 28 are 1030.
      const text = capListField({ items: Array.from({ length: 100 }, () => item) }, 'items', (o) => JSON.stringify(o))
      const kept = (JSON.parse(text) as { items: unknown[] }).items.length
      expect(kept).toBeGreaterThanOrEqual(26)
      expect(kept).toBeLessThanOrEqual(27)
      expect(guardTokens(text)).toBeLessThanOrEqual(1000)
    })
  })
})
