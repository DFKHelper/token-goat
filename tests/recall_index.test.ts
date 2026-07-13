import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'

// bm25() ranking is computed from corpus-wide statistics (avgdl, total row count), not just the
// rows a query's MATCH filter returns -- a nonce-prefixed id is enough to keep two test files'
// rows from ever matching the same query, but NOT enough to keep another file's row *count*
// from shifting a ranking-order assertion's relative scores. Files sharing this worker's process
// can run interleaved (see tests/setup/reset-hint-stats.ts's doc comment for the same class of
// bug in hint_stats), so a nonce alone isn't reliable for the ranking test below. This mock is
// hoisted, so it must be self-contained (no top-level variables referenced before their own
// declaration) -- mirrors the same pattern in tests/hooks_bash.test.ts's configPath() mock.
//
// mkdtempSync (not a bare pid-keyed filename): a pid-only path leaves an orphaned .db file in
// the OS temp dir forever (nothing ever deletes it), and Windows recycles pids quickly enough
// across separate test invocations in one dev session that a later run can reopen an earlier
// run's leftover, already-populated file -- reproduced directly: 14 stale
// tg-recall-index-test-<pid>.db files were found accumulated in %TEMP% after repeated `vitest
// run` invocations, and the ranking test below flaked specifically when a run's pid collided
// with one of them. mkdtempSync's random suffix guarantees a fresh path every process, and the
// exit hook removes it the same way tests/setup/isolate-home.ts cleans up its own temp dirs.
// A `mock`-prefixed name is required here: Vitest hoists `vi.mock()` calls (and any
// `mock`-prefixed const the factory closes over) above the rest of the file's top-level code,
// including regular `const` declarations -- referencing a non-`mock`-prefixed local from inside
// the factory throws "There was an error when mocking a module... make sure there are no top
// level variables inside" at import time, since that variable would still be in its temporal
// dead zone when the hoisted factory first runs.
const mockRecallTestDir = mkdtempSync(join(tmpdir(), 'tg-recall-index-test-'))
process.on('exit', () => {
  try {
    rmSync(mockRecallTestDir, { recursive: true, force: true })
  } catch {
    // best-effort
  }
})

vi.mock('../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    globalDbPath: () => join(mockRecallTestDir, 'global.db'),
  }
})

import {
  indexRecallEntry,
  isRecallCacheType,
  searchRecall,
  resetRecallFtsCacheForTesting,
  clearRecallEntriesForTesting,
} from '../src/recall_index.js'
import { clearModuleCaches } from '../src/reset.js'

// Every seeded entry still uses a randomized nonce prefix, on top of the private db above, so
// assertions search for that nonce rather than "the whole index" and stay robust to any
// leftover rows from an earlier test in this same file.
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
    // Strong match, stored EARLIER: the query term is the whole label and repeated in the
    // content. Regression (recall_index.ts's ftsSearch used to alias cache_recall_fts as `f`
    // and write `WHERE f MATCH ?` -- aliasing an FTS5 virtual table on the left side of MATCH
    // throws `no such column: f` in this project's SQLite build, so ftsSearch threw on every
    // call and searchRecall's catch silently degraded to likeSearch): storing the strong match
    // earlier than the weak one means the LIKE fallback's `ORDER BY stored_at DESC` would rank
    // weak first, disagreeing with a correct bm25-ranked result -- so this test fails loudly on
    // a fallback regression instead of only flaking on insertion-order timing.
    indexRecallEntry('bash', `strong-${n}`, `rankterm-${n}`, `rankterm-${n} rankterm-${n} rankterm-${n} exact focus`, Date.now() - 60_000)
    // Weak match, stored more recently: the query term appears once, buried in a longer,
    // unrelated body.
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
