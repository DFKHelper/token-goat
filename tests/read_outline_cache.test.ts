import { beforeEach, describe, expect, it } from 'vitest'
import type { SymbolEntry } from '../src/parser_types.js'
import {
  clearOutlineListingCache,
  getOutlineListingCache,
  setOutlineListingCache,
  type OutlineListingCacheValue,
} from '../src/read_outline_cache.js'

function listing(name: string, body = 'export function run() {}'): OutlineListingCacheValue {
  const symbol: SymbolEntry = {
    filePath: `${name}.ts`,
    name,
    kind: 'function',
    lineStart: 1,
    lineEnd: 1,
    body,
    docstring: '',
    parent: '',
  }
  return {
    resolved: `${name}.ts`,
    displayRoot: undefined,
    filtered: [symbol],
    preFilterCount: 1,
    refCounts: undefined,
    fullSourceBytes: body.length,
    symbolsTruncated: false,
    trueSymbolCount: undefined,
    totalLines: 1,
  }
}

beforeEach(clearOutlineListingCache)

describe('outline listing cache', () => {
  it('returns copies so callers cannot mutate the cached listing', () => {
    setOutlineListingCache('source-a', listing('run'))

    const first = getOutlineListingCache('source-a')
    const second = getOutlineListingCache('source-a')

    expect(first).toEqual(second)
    expect(first).not.toBe(second)
    expect(first?.filtered).not.toBe(second?.filtered)
    first?.filtered.pop()
    expect(getOutlineListingCache('source-a')?.filtered).toHaveLength(1)
  })

  it('evicts the least recently used entry when its fixed entry budget is exceeded', () => {
    for (let i = 0; i < 16; i++) setOutlineListingCache(`source-${i}`, listing(`name-${i}`))
    getOutlineListingCache('source-0')
    setOutlineListingCache('source-16', listing('name-16'))

    expect(getOutlineListingCache('source-0')).toBeDefined()
    expect(getOutlineListingCache('source-1')).toBeUndefined()
    expect(getOutlineListingCache('source-16')).toBeDefined()
  })

  it('does not retain an individual listing that exceeds the byte budget', () => {
    setOutlineListingCache('large', listing('large', 'x'.repeat(60_000)))

    expect(getOutlineListingCache('large')).toBeUndefined()
  })
})
