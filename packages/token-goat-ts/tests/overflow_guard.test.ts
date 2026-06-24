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
  })
})
