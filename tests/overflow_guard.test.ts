import { describe, it, expect } from 'vitest'
import { estimateTokens, checkOverflow, trimToBudget } from '../src/overflow_guard.js'

describe('overflow_guard', () => {
  describe('estimateTokens', () => {
    it('estimates ~3 chars per token', () => {
      const text = 'a'.repeat(300)
      const tokens = estimateTokens(text)
      expect(tokens).toBeGreaterThanOrEqual(99)
      expect(tokens).toBeLessThanOrEqual(101)
    })

    it('returns at least 1 token for empty string', () => {
      expect(estimateTokens('')).toBeGreaterThanOrEqual(1)
    })

    it('strips ANSI codes before counting', () => {
      const textWithAnsi = 'a'.repeat(300) + '[31mred[0m'
      const tokens = estimateTokens(textWithAnsi)
      expect(tokens).toBeGreaterThanOrEqual(100)
      expect(tokens).toBeLessThanOrEqual(105)
    })
  })

  describe('checkOverflow', () => {
    it('returns over: true when over budget', () => {
      const result = checkOverflow('a'.repeat(300), 50)
      expect(result.over).toBe(true)
    })

    it('returns over: false when within budget', () => {
      const result = checkOverflow('hello', 10)
      expect(result.over).toBe(false)
    })

    it('includes budget and used tokens', () => {
      const result = checkOverflow('a'.repeat(100), 50)
      expect(result.budget).toBe(50)
      expect(result.used).toBeGreaterThan(0)
    })
  })

  describe('trimToBudget', () => {
    it('returns text unchanged when under budget', () => {
      const text = 'hello world'
      const result = trimToBudget(text, 100)
      expect(result).toBe(text)
    })

    it('truncates and adds marker when over budget', () => {
      const text = 'a'.repeat(1000)
      const result = trimToBudget(text, 50)
      expect(result).not.toBe(text)
      expect(result).toContain('[token-goat: output capped at ~50 tokens')
    })

    it('preserves whole lines when trimming', () => {
      const text = 'line1\nline2\nline3\nline4\nline5'
      const result = trimToBudget(text, 20)
      const lines = result.split('\n')
      for (const line of lines.slice(0, -1)) {
        expect(line).toMatch(/^line\d+$/)
      }
    })

    it('shows line count in marker', () => {
      const text = Array(50).fill('x'.repeat(100)).join('\n')
      const result = trimToBudget(text, 30)
      expect(result).toContain('showing')
      expect(result).toContain('of 50 lines')
    })

    it('includes tailored hint for symbol command', () => {
      const text = 'a'.repeat(1000)
      const result = trimToBudget(text, 50, 'symbol')
      expect(result).toContain('Request a specific method')
    })

    it('includes default hint for unknown command', () => {
      const text = 'a'.repeat(1000)
      const result = trimToBudget(text, 50, 'unknown')
      expect(result).toContain('Narrow your query')
    })

    it('truncates lines with ANSI codes without corrupting codes', () => {
      const ansiLine = '\x1b[31mRed text\x1b[0m' + 'x'.repeat(200)
      const text = ansiLine + '\nmore content'
      const result = trimToBudget(text, 10)
      expect(result).toContain('[token-goat: output capped at ~10 tokens')
      expect(result).not.toContain('\x1b[31m\x1b[')
    })

    it('trims the first oversized ANSI line to visible chars, not raw bytes', () => {
      // Build a line where ANSI escape bytes appear before position charBudget in the raw string.
      // charBudget = (budgetTokens - 64) * 3. With budgetTokens=70 bodyBudget=6 charBudget=18.
      // Raw ANSI prefix '\x1b[31m' (5 bytes) + 'x'.repeat(200). Visible: 200 x's.
      // Pre-fix: ln.slice(0,18) = '\x1b[31mxxxxxxxxxxxxx' (5 ANSI + 13 visible) — dangling open code, wrong length.
      // Post-fix: stripped.slice(0,18) = 'xxxxxxxxxxxxxxxxxx' (18 visible x's) — correct, no ANSI.
      const budgetTokens = 70
      const charBudget = (budgetTokens - 64) * 3 // 18
      const ansiLine = '\x1b[31m' + 'x'.repeat(200)
      const text = ansiLine + '\nmore content'

      const result = trimToBudget(text, budgetTokens)

      // The first kept line must not start with an ANSI escape sequence (no dangling code).
      const firstLine = result.split('\n')[0]!
      // Must not start with an ANSI escape sequence (no dangling code). toBe below proves no ANSI either way.
      expect(firstLine.startsWith('\x1b[')).toBe(false)
      // The visible portion must be exactly charBudget visible characters.
      expect(firstLine).toBe('x'.repeat(charBudget))
    })

    it('ANSI escape bytes do not silently consume visible character budget', () => {
      // A line starting with a long ANSI prefix: if raw-sliced, fewer visible chars fit in the budget.
      // Post-fix the budget is measured on stripped chars, so visible output == charBudget x's.
      const budgetTokens = 70
      const charBudget = (budgetTokens - 64) * 3 // 18
      // Put an 11-byte ANSI sequence at the start so raw slice would lose 10 visible chars vs the budget.
      const ansiPrefix = '\x1b[38;5;200m' // 11 bytes, 0 visible chars
      // Use enough y's that stripped.length > budgetTokens*3 to trigger the overflow path.
      const ansiLine = ansiPrefix + 'y'.repeat(300)
      const text = ansiLine

      const result = trimToBudget(text, budgetTokens)

      const firstLine = result.split('\n')[0]!
      // Must not contain any ANSI escape byte. The toBe below is definitive; this is an extra signal.
      expect(firstLine.includes('\x1b')).toBe(false)
      // Must contain exactly charBudget visible characters.
      expect(firstLine).toBe('y'.repeat(charBudget))
    })
  })
})
