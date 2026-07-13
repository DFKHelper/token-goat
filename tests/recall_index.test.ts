import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  indexRecallEntry,
  isRecallCacheType,
  searchRecall,
  resetRecallFtsCacheForTesting,
  clearRecallEntriesForTesting,
} from '../src/recall_index.js'
import { clearModuleCaches } from '../src/reset.js'

// The recall index lives in the shared global.db (see tests/setup/isolate-home.ts: one
// per-worker data dir, not reset between test files), so every seeded entry here uses a
// randomized nonce prefix -- assertions search for that nonce, never for "the whole index",
// so this file's results can never collide with another test file's synthetic entries.
//
// A nonce prefix is enough for MATCH filtering (which rows a query finds) but not for
// bm25() ranking, which SQLite computes from corpus-wide statistics (avgdl, total row count)
// regardless of the query's MATCH filter -- so clearRecallEntriesForTesting() gives every test
// a clean, single-tenant corpus, preventing rows left by other test files sharing this worker
// from shifting a ranking-order assertion's relative scores.
function nonce(): string {
  return `rk${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

beforeEach(() => {
  clearModuleCaches()
  resetRecallFtsCacheForTesting()
  clearRecallEntriesForTesting()
})

afterEach(() => {
  clearModuleCaches()
  resetRecallFtsCacheForTesting()
  clearRecallEntriesForTesting()
})

describe('isRecallCacheType', () => {
  it('accepts the three known cache types', () => {
    expect(isRecallCacheType('bash')).toBe(true)
    expect(isRecallCacheType('web')).toBe(true)
    expect(isRecallCacheType('mcp')).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isRecallCacheType('skill')).toBe(false)
    expect(isRecallCacheType('')).toBe(false)
    expect(isRecallCacheType('Bash')).toBe(false)
  })
})

describe('searchRecall — empty index / empty query', () => {
  it('returns no hits for a query that matches nothing, without throwing', () => {
    const n = nonce()
    expect(() => searchRecall(`no-such-entry-${n}`)).not.toThrow()
    expect(searchRecall(`no-such-entry-${n}`)).toEqual([])
  })

  it('returns no hits for an empty or whitespace-only query', () => {
    expect(searchRecall('')).toEqual([])
    expect(searchRecall('   ')).toEqual([])
  })
})

describe('searchRecall — basic matching', () => {
  it('finds an entry by a term in its content', () => {
    const n = nonce()
    indexRecallEntry('bash', `id-${n}`, `npm test ${n}`, `npm test ${n}\nall tests passed for widget-${n}`, Date.now())

    const hits = searchRecall(`widget-${n}`)
    expect(hits.length).toBe(1)
    expect(hits[0]?.id).toBe(`id-${n}`)
    expect(hits[0]?.cacheType).toBe('bash')
    expect(hits[0]?.snippet).toContain(`widget-${n}`)
  })

  it('finds an entry by a term in its label', () => {
    const n = nonce()
    indexRecallEntry('web', `web-${n}`, `https://example.com/${n}`, `https://example.com/${n}\nsome page body`, Date.now())

    const hits = searchRecall(n)
    expect(hits.some((h) => h.id === `web-${n}`)).toBe(true)
  })

  it('re-indexing the same (cacheType, id) refreshes content instead of duplicating the row', () => {
    const n = nonce()
    indexRecallEntry('bash', `dup-${n}`, 'first label', `first content ${n}`, Date.now())
    indexRecallEntry('bash', `dup-${n}`, 'second label', `second content ${n}`, Date.now())

    const hitsOld = searchRecall(`first content ${n}`)
    expect(hitsOld.filter((h) => h.id === `dup-${n}`)).toEqual([])

    const hitsNew = searchRecall(`second content ${n}`)
    expect(hitsNew.filter((h) => h.id === `dup-${n}`).length).toBe(1)
    expect(hitsNew.find((h) => h.id === `dup-${n}`)?.label).toBe('second label')
  })
})

describe('searchRecall — --type filtering', () => {
  it('scopes results to the requested cache type only', () => {
    const n = nonce()
    indexRecallEntry('bash', `b-${n}`, 'bash label', `shared-token-${n} bash body`, Date.now())
    indexRecallEntry('web', `w-${n}`, 'web label', `shared-token-${n} web body`, Date.now())
    indexRecallEntry('mcp', `m-${n}`, 'mcp label', `shared-token-${n} mcp body`, Date.now())

    const all = searchRecall(`shared-token-${n}`)
    expect(all.length).toBe(3)

    const bashOnly = searchRecall(`shared-token-${n}`, { type: 'bash' })
    expect(bashOnly.length).toBe(1)
    expect(bashOnly[0]?.cacheType).toBe('bash')

    const webOnly = searchRecall(`shared-token-${n}`, { type: 'web' })
    expect(webOnly.length).toBe(1)
    expect(webOnly[0]?.cacheType).toBe('web')

    const mcpOnly = searchRecall(`shared-token-${n}`, { type: 'mcp' })
    expect(mcpOnly.length).toBe(1)
    expect(mcpOnly[0]?.cacheType).toBe('mcp')
  })
})

describe('searchRecall — --limit capping', () => {
  it('never returns more than `limit` hits', () => {
    const n = nonce()
    for (let i = 0; i < 8; i++) {
      indexRecallEntry('bash', `cap-${n}-${i}`, `label ${i}`, `capped-token-${n} entry number ${i}`, Date.now() + i)
    }

    const unbounded = searchRecall(`capped-token-${n}`, { limit: 100 })
    expect(unbounded.length).toBe(8)

    const capped = searchRecall(`capped-token-${n}`, { limit: 3 })
    expect(capped.length).toBe(3)
  })
})

describe('searchRecall — ranking', () => {
  it('ranks an entry with the query term in both label and content above one with a single, incidental mention', () => {
    const n = nonce()
    // BM25's IDF term goes negative (inverting the usual "more mentions ranks higher" intuition)
    // when the query term appears in more than half of the documents in the searched corpus --
    // a real property of BM25, not specific to this index. With only the two documents under
    // test both containing the term, df/N == 1 and that inversion would trigger; a handful of
    // decoy documents that do NOT contain the term keep df/N comfortably below 0.5 so this test
    // exercises the intended, realistic "more relevant occurrences ranks higher" case.
    for (let i = 0; i < 4; i++) {
      indexRecallEntry('bash', `decoy-${n}-${i}`, `decoy label ${i}`, `completely unrelated filler content number ${i} with no query term at all`, Date.now())
    }
    // Strong match: the query term is the whole label and repeated in the content.
    indexRecallEntry('bash', `strong-${n}`, `rankterm-${n}`, `rankterm-${n} rankterm-${n} rankterm-${n} exact focus`, Date.now())
    // Weak match: the query term appears once, buried in a longer, unrelated body.
    indexRecallEntry(
      'bash',
      `weak-${n}`,
      'unrelated label',
      `a long unrelated passage about something else entirely that only mentions rankterm-${n} once in passing among many other words that pad this out`,
      Date.now(),
    )

    const hits = searchRecall(`rankterm-${n}`)
    expect(hits.length).toBe(2)
    expect(hits[0]?.id).toBe(`strong-${n}`)
  })
})
