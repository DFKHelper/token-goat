import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearHintTargetCache,
  getHintTargetCandidates,
  setHintTargetCandidates,
} from '../src/hint_target_cache.js'

beforeEach(clearHintTargetCache)

describe('hint target candidate cache', () => {
  it('returns an isolated copy of cached candidates', () => {
    const candidates = [{ name: 'Install', level: 2 }]
    setHintTargetCandidates('same-file', candidates)

    const first = getHintTargetCandidates('same-file')
    const second = getHintTargetCandidates('same-file')

    expect(first).toEqual(candidates)
    expect(first).not.toBe(second)
    expect(first?.[0]).not.toBe(second?.[0])
  })

  it('evicts the least recently used entry when its fixed entry budget is exceeded', () => {
    for (let i = 0; i < 33; i++) setHintTargetCandidates(`file-${i}`, [{ name: `Heading ${i}`, level: 2 }])

    expect(getHintTargetCandidates('file-0')).toBeUndefined()
    expect(getHintTargetCandidates('file-32')).toEqual([{ name: 'Heading 32', level: 2 }])
  })

  it('does not retain an oversized candidate list', () => {
    setHintTargetCandidates('large', [{ name: 'x'.repeat(20_000), level: 1 }])

    expect(getHintTargetCandidates('large')).toBeUndefined()
  })
})
