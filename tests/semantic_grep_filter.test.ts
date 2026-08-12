// Regression coverage for `semantic --grep <pattern>`: the only surgical-read query command
// that previously had no path filter at all, unlike its siblings (refs/callers/dead/skeleton/
// outline/exports/types --grep). Mirrors those siblings' convention exactly: filter on the FILE
// PATH AS RENDERED (toDisplayPath), regex falling back to literal substring, applied BEFORE the
// `--limit` slice in BOTH result branches (embeddings and the FTS fallback), and a dedicated
// "filtered to empty" notice distinct from a genuinely empty index/search.
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it, vi, beforeEach } from 'vitest'

import type * as EmbeddingsModule from '../src/embeddings.js'
import type { SearchHit } from '../src/embeddings.js'
import type * as IndexReaderModule from '../src/index_reader.js'

const searchSemanticMock = vi.fn()
const searchSymbolsFtsMock = vi.fn()

vi.mock('../src/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof EmbeddingsModule>()
  return {
    ...actual,
    searchSemantic: (...args: Parameters<typeof actual.searchSemantic>) => searchSemanticMock(...args),
  }
})

vi.mock('../src/index_reader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof IndexReaderModule>()
  return {
    ...actual,
    searchSymbolsFts: (...args: Parameters<typeof actual.searchSymbolsFts>) => searchSymbolsFtsMock(...args),
  }
})

const { runSemantic } = await import('../src/read_commands.js')
const { OVER_FETCH_FACTOR, MAX_OVER_FETCH } = await import('../src/embeddings.js')

function hit(filePath: string, startLine: number, endLine: number, distance: number, text = 'x'.repeat(20)): SearchHit {
  return { filePath, startLine, endLine, kind: 'window', distance, text }
}

describe('runSemantic --grep (embeddings branch)', () => {
  let root: string

  beforeEach(() => {
    vi.clearAllMocks()
    // runSemantic now always fuses in the BM25 list alongside the dense one (RRF), so every test in this describe block that doesn't care about FTS needs a default non-undefined return.
    searchSymbolsFtsMock.mockReturnValue([])
    root = mkdtempSync(join(tmpdir(), 'tg-sem-grep-emb-'))
  })

  it('filters to hits whose RENDERED path matches an anchored regex, dropping non-matching hits', async () => {
    const srcFile = join(root, 'src', 'a.ts')
    const testFile = join(root, 'tests', 'b.ts')
    searchSemanticMock.mockResolvedValue([
      hit(srcFile, 1, 5, 0.1),
      hit(testFile, 600, 605, 0.2),
    ])

    const { text, code } = await runSemantic('q', { projectRoot: root, grep: '^src/' })

    expect(code).toBe(0)
    expect(text).toContain('src/a.ts')
    expect(text).not.toContain('tests/b.ts')
    expect(text).not.toContain('b.ts')
  })

  it('falls back to a literal substring match when the pattern does not compile as regex', async () => {
    const srcFile = join(root, 'src', 'weird(name.ts')
    const otherFile = join(root, 'src', 'other.ts')
    searchSemanticMock.mockResolvedValue([
      hit(srcFile, 1, 5, 0.1),
      hit(otherFile, 600, 605, 0.2),
    ])

    // '(' with no closing paren is invalid regex -- must fall back to literal substring.
    const { text, code } = await runSemantic('q', { projectRoot: root, grep: 'weird(name' })

    expect(code).toBe(0)
    expect(text).toContain('weird(name.ts')
    expect(text).not.toContain('other.ts')
  })

  it('filters before slicing to --limit: a low-ranked matching hit still surfaces even though it would fall outside the unfiltered top-N', async () => {
    // 4 top-ranked (lowest distance) hits under tests/, 1 low-ranked hit under src/. With
    // --limit 1 and no filter-before-slice, `.slice(0, 1)` would keep only the first tests/ hit
    // and the src/ hit would never even reach the grep filter.
    const hits: SearchHit[] = [
      hit(join(root, 'tests', 't0.ts'), 1, 5, 0.01),
      hit(join(root, 'tests', 't1.ts'), 600, 605, 0.02),
      hit(join(root, 'tests', 't2.ts'), 1200, 1205, 0.03),
      hit(join(root, 'tests', 't3.ts'), 1800, 1805, 0.04),
      hit(join(root, 'src', 'lowRanked.ts'), 2400, 2405, 0.99),
    ]
    searchSemanticMock.mockResolvedValue(hits)
    // Pinned so a regression that slices before filtering fails on THIS test's own assertion.
    // Without it, the embeddings branch empties out, execution falls through to the FTS
    // fallback, and the unconfigured mock returns undefined -- the test still goes red, but on
    // an incidental TypeError inside the fallback rather than on the filter-before-slice claim
    // it exists to make, so it would not actually prove the ordering.
    searchSymbolsFtsMock.mockReturnValue([])

    const { text, code } = await runSemantic('q', { projectRoot: root, grep: '^src/', limit: 1 })

    expect(code).toBe(0)
    expect(text).toContain('src/lowRanked.ts')
    // The four better-ranked tests/ hits must be absent: they lose to the filter, not to the slice.
    expect(text).not.toContain('tests/t0.ts')
  })

  it('renders a filtered-to-empty notice, distinguishable from a genuinely empty search, when --grep matches none of the real hits (text and --json)', async () => {
    searchSemanticMock.mockResolvedValue([hit(join(root, 'tests', 'only.ts'), 1, 5, 0.1)])
    searchSymbolsFtsMock.mockReturnValue([])

    const textResult = await runSemantic('q', { projectRoot: root, grep: '^src/' })
    expect(textResult.code).toBe(0)
    expect(textResult.text).toContain('filtered out by --grep')
    expect(textResult.text).not.toContain('no matches for')

    const jsonResult = await runSemantic('q', { projectRoot: root, grep: '^src/', json: true })
    expect(jsonResult.code).toBe(0)
    const payload = JSON.parse(jsonResult.text) as { grepFilteredToEmpty?: boolean; indexEmpty?: boolean; items: unknown[] }
    expect(payload.grepFilteredToEmpty).toBe(true)
    expect(payload.indexEmpty).toBeUndefined()
    expect(payload.items).toEqual([])
  })

  it('leaves default (no --grep) output unchanged', async () => {
    searchSemanticMock.mockResolvedValue([hit(join(root, 'src', 'a.ts'), 1, 5, 0.1)])

    const { text, code } = await runSemantic('q', { projectRoot: root })
    expect(code).toBe(0)
    expect(text).toContain('a.ts')
  })
})

describe('runSemantic --grep (FTS fallback branch)', () => {
  let root: string

  beforeEach(() => {
    vi.clearAllMocks()
    searchSemanticMock.mockResolvedValue([])
    root = mkdtempSync(join(tmpdir(), 'tg-sem-grep-fts-'))
  })

  it('filters to hits whose RENDERED path matches an anchored regex, dropping non-matching hits', async () => {
    searchSymbolsFtsMock.mockReturnValue([
      { filePath: join(root, 'src', 'a.ts'), name: 'fnA', kind: 'function', lineStart: 1, lineEnd: 3, body: 'body a' },
      { filePath: join(root, 'tests', 'b.ts'), name: 'fnB', kind: 'function', lineStart: 1, lineEnd: 3, body: 'body b' },
    ])

    const { text, code } = await runSemantic('q', { projectRoot: root, grep: '^src/' })

    expect(code).toBe(0)
    expect(text).toContain('fnA')
    expect(text).not.toContain('fnB')
  })

  it('falls back to a literal substring match when the pattern does not compile as regex', async () => {
    searchSymbolsFtsMock.mockReturnValue([
      { filePath: join(root, 'src', 'weird(name.ts'), name: 'fnA', kind: 'function', lineStart: 1, lineEnd: 3, body: 'body a' },
      { filePath: join(root, 'src', 'other.ts'), name: 'fnB', kind: 'function', lineStart: 1, lineEnd: 3, body: 'body b' },
    ])

    const { text, code } = await runSemantic('q', { projectRoot: root, grep: 'weird(name' })

    expect(code).toBe(0)
    expect(text).toContain('fnA')
    expect(text).not.toContain('fnB')
  })

  it('over-fetches at the DB level, filters, then slices to --limit, instead of filtering an already-`limit`-capped result set', async () => {
    const { text, code } = await runSemantic('q', { projectRoot: root, grep: '^src/', limit: 1 })
    void text
    void code

    // searchSymbolsFts caps results with a SQL LIMIT, so filtering its output after the fact
    // for a small `--limit` would silently under-fetch: it must be called with an over-fetched
    // candidate size, not the raw requested limit.
    expect(searchSymbolsFtsMock).toHaveBeenCalledTimes(1)
    const calledLimit = searchSymbolsFtsMock.mock.calls[0]?.[1]
    expect(calledLimit).toBe(Math.min(MAX_OVER_FETCH, 1 * OVER_FETCH_FACTOR))
    expect(calledLimit).toBeGreaterThan(1)
  })

  it('filters before slicing to --limit: a low-ranked matching hit still surfaces even though it would fall outside the unfiltered top-N', async () => {
    const rows = [
      { filePath: join(root, 'tests', 't0.ts'), name: 'fnT0', kind: 'function', lineStart: 1, lineEnd: 3, body: 'x' },
      { filePath: join(root, 'tests', 't1.ts'), name: 'fnT1', kind: 'function', lineStart: 1, lineEnd: 3, body: 'x' },
      { filePath: join(root, 'tests', 't2.ts'), name: 'fnT2', kind: 'function', lineStart: 1, lineEnd: 3, body: 'x' },
      { filePath: join(root, 'src', 'lowRanked.ts'), name: 'fnLow', kind: 'function', lineStart: 1, lineEnd: 3, body: 'x' },
    ]
    searchSymbolsFtsMock.mockReturnValue(rows)

    const { text, code } = await runSemantic('q', { projectRoot: root, grep: '^src/', limit: 1 })

    expect(code).toBe(0)
    expect(text).toContain('fnLow')
  })

  // Regression note: this used to assert a byte-identical, non-over-fetched call when --grep was unset -- since runSemantic now ALWAYS fuses the BM25 list with the dense list (RRF), rather than gating BM25 on the dense branch returning zero hits, searchSymbolsFts must always be over-fetched, because the fusion rank needs real candidate breadth and not just enough to fill --limit, regardless of whether a filter is present.
  it('over-fetches the searchSymbolsFts call even when --grep is unset (fusion always needs breadth, not just enough to fill --limit)', async () => {
    searchSymbolsFtsMock.mockReturnValue([])

    await runSemantic('q', { projectRoot: root, limit: 7 })

    expect(searchSymbolsFtsMock).toHaveBeenCalledTimes(1)
    const call = searchSymbolsFtsMock.mock.calls[0]
    expect(call?.[1]).toBe(Math.min(MAX_OVER_FETCH, 7 * OVER_FETCH_FACTOR))
    expect(call?.[1]).toBeGreaterThan(7)
  })

  it('renders a filtered-to-empty notice, distinguishable from a genuinely empty search, when --grep matches none of the real hits (text and --json)', async () => {
    searchSymbolsFtsMock.mockReturnValue([
      { filePath: join(root, 'tests', 'only.ts'), name: 'fnOnly', kind: 'function', lineStart: 1, lineEnd: 3, body: 'x' },
    ])

    const textResult = await runSemantic('q', { projectRoot: root, grep: '^src/' })
    expect(textResult.code).toBe(0)
    expect(textResult.text).toContain('filtered out by --grep')
    expect(textResult.text).not.toContain('no matches for')

    const jsonResult = await runSemantic('q', { projectRoot: root, grep: '^src/', json: true })
    expect(jsonResult.code).toBe(0)
    const payload = JSON.parse(jsonResult.text) as { grepFilteredToEmpty?: boolean; indexEmpty?: boolean; items: unknown[] }
    expect(payload.grepFilteredToEmpty).toBe(true)
    expect(payload.indexEmpty).toBeUndefined()
    expect(payload.items).toEqual([])
  })

  it('a genuinely empty search (no --grep) still reports "no matches", not the grep-filtered-to-empty notice', async () => {
    searchSymbolsFtsMock.mockReturnValue([])

    const { text, code } = await runSemantic('nonexistent query term', { projectRoot: root })

    expect(code).toBe(1)
    expect(text).toContain('no matches for')
    expect(text).not.toContain('filtered out by --grep')
  })

  it('leaves default (no --grep) output unchanged', async () => {
    searchSymbolsFtsMock.mockReturnValue([
      { filePath: join(root, 'src', 'a.ts'), name: 'fnA', kind: 'function', lineStart: 1, lineEnd: 3, body: 'x' },
    ])

    const { text, code } = await runSemantic('q', { projectRoot: root })
    expect(code).toBe(0)
    expect(text).toContain('fnA')
  })
})
