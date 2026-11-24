import { describe, expect, it } from 'vitest'

import { computeLexicalOverlapBoost, refineSemanticWindow } from '../src/semantic_window.js'

describe('semantic result refinement', () => {
  it('gives a bounded lexical boost to split identifier matches', () => {
    const boost = computeLexicalOverlapBoost('userName lookup', 'userName', 'function userName()', 'resolves a profile')
    expect(boost).toBeGreaterThan(0)
    expect(boost).toBeLessThanOrEqual(0.006)
    expect(computeLexicalOverlapBoost('nothing matches', 'userName', '', '')).toBe(0)
  })

  it('returns the densest contiguous three-line preview without changing source bounds', () => {
    const body = ['neutral words', 'unrelated content', 'token verification auth', 'token verification identity', 'more filler'].join('\n')
    expect(refineSemanticWindow(body, 40, 'token verification')).toEqual({
      text: ['unrelated content', 'token verification auth', 'token verification identity'].join('\n'),
      windowStartLine: 41,
      windowEndLine: 43,
    })
  })

  it('keeps the complete redacted body when it already fits the line window', () => {
    expect(refineSemanticWindow('first line\nsecond line', 9, 'missing query')).toEqual({
      text: 'first line\nsecond line',
      windowStartLine: 9,
      windowEndLine: 10,
    })
  })
})
