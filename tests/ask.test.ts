import { describe, expect, it } from 'vitest'
import { Slice, cacheKey, buildPrompt, parseTimeoutSecs, DEFAULT_TIMEOUT_SECS } from '../src/ask.js'

describe('Slice', () => {
  it('creates a slice with correct properties', () => {
    const s = new Slice('file.ts', 10, 20, 'code content', 0.5)
    expect(s.fileRel).toBe('file.ts')
    expect(s.startLine).toBe(10)
    expect(s.endLine).toBe(20)
    expect(s.text).toBe('code content')
    expect(s.distance).toBe(0.5)
  })

  it('citation returns correct format', () => {
    const s = new Slice('file.ts', 10, 20, 'text', 0.3)
    const c = s.citation()
    expect(c.file).toBe('file.ts')
    expect(c.start_line).toBe(10)
    expect(c.end_line).toBe(20)
  })

  it('relevancePct calculates correctly', () => {
    const s1 = new Slice('f', 1, 2, 'x', 0.0)
    const s2 = new Slice('f', 1, 2, 'x', 0.5)
    const s3 = new Slice('f', 1, 2, 'x', 1.0)
    expect(s1.relevancePct()).toBe(100)
    expect(s2.relevancePct()).toBe(50)
    expect(s3.relevancePct()).toBe(0)
  })
})

describe('cacheKey', () => {
  it('returns consistent hash for same inputs', () => {
    const slices = [new Slice('f.ts', 1, 10, 'code', 0.1)]
    const k1 = cacheKey('How does this work?', slices, 'claude:haiku')
    const k2 = cacheKey('How does this work?', slices, 'claude:haiku')
    expect(k1).toBe(k2)
  })

  it('differs for different questions', () => {
    const slices = [new Slice('f.ts', 1, 10, 'code', 0.1)]
    const k1 = cacheKey('question one', slices, 'claude:haiku')
    const k2 = cacheKey('question two', slices, 'claude:haiku')
    expect(k1).not.toBe(k2)
  })

  it('differs when content changes', () => {
    const s1 = [new Slice('f.ts', 1, 10, 'code1', 0.1)]
    const s2 = [new Slice('f.ts', 1, 10, 'code2', 0.1)]
    const k1 = cacheKey('q', s1, 'backend')
    const k2 = cacheKey('q', s2, 'backend')
    expect(k1).not.toBe(k2)
  })
})

describe('buildPrompt', () => {
  it('includes question and slices', () => {
    const slices = [
      new Slice('file.ts', 5, 15, 'function foo() { return 42 }', 0.1),
      new Slice('util.ts', 20, 25, 'export const helper = () => 1', 0.2),
    ]
    const prompt = buildPrompt('What does foo do?', slices)
    expect(prompt).toContain('What does foo do?')
    expect(prompt).toContain('file.ts')
    expect(prompt).toContain('function foo')
    expect(prompt).toContain('[1]')
    expect(prompt).toContain('[2]')
  })

  it('includes maxWords constraint', () => {
    const slices = [new Slice('f.ts', 1, 5, 'x', 0.1)]
    const prompt = buildPrompt('q', slices, { maxWords: 50 })
    expect(prompt).toContain('50 words')
  })

  it('formats line ranges correctly', () => {
    const slices = [new Slice('src/main.ts', 100, 150, 'code', 0.1)]
    const prompt = buildPrompt('test', slices)
    expect(prompt).toContain('L:100-150')
  })

  it('handles falsy slices by skipping them in tags', () => {
    const slices = [
      new Slice('file1.ts', 5, 15, 'code1', 0.1),
      null as unknown as Slice,
      new Slice('file2.ts', 20, 25, 'code2', 0.2),
    ]
    const prompt = buildPrompt('test question', slices)
    expect(prompt).toContain('[1]')
    expect(prompt).toContain('file1.ts')
    expect(prompt).toContain('[3]')
    expect(prompt).toContain('file2.ts')
  })
})

describe('parseTimeoutSecs', () => {
  it('returns DEFAULT_TIMEOUT_SECS when env is undefined', () => {
    expect(parseTimeoutSecs(undefined)).toBe(DEFAULT_TIMEOUT_SECS)
  })

  it('returns DEFAULT_TIMEOUT_SECS when env is empty string', () => {
    expect(parseTimeoutSecs('')).toBe(DEFAULT_TIMEOUT_SECS)
  })

  it('returns DEFAULT_TIMEOUT_SECS when env is not a number', () => {
    expect(parseTimeoutSecs('abc')).toBe(DEFAULT_TIMEOUT_SECS)
  })

  it('returns 0 when env is "0" (was broken: 0 || default returned default)', () => {
    expect(parseTimeoutSecs('0')).toBe(0)
  })

  it('returns numeric value for valid integer string', () => {
    expect(parseTimeoutSecs('60')).toBe(60)
  })
})
