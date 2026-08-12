// Regression coverage for `semantic --exclude-tests`: `semantic` gained `--grep` but had no way
// to EXCLUDE a path, unlike refs/callers/dead/call-chain/impact, which all carry this flag. The
// gap is not cosmetic -- `--grep` can only ever *select*, and the one regex that would express
// "not a test" (a negative lookahead) silently degrades to a literal substring match whenever
// compileGrepMatcher's regex-compile fallback fires, so there was no reliable way to ask for it.
//
// Mirrors the sibling flags' convention: checked against the STORED path via isTestFile, applied
// BEFORE the `--limit` slice in BOTH result branches (embeddings and the FTS fallback), composing
// with `--grep` (a hit must satisfy both), and a dedicated filtered-to-empty notice that exits 0
// rather than reporting the exit-1 "no matches" a genuinely empty search reports.
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

function row(filePath: string, name: string): { filePath: string; name: string; kind: string; lineStart: number; lineEnd: number; body: string } {
  return { filePath, name, kind: 'function', lineStart: 1, lineEnd: 3, body: 'x' }
}

describe('runSemantic --exclude-tests (embeddings branch)', () => {
  let root: string

  beforeEach(() => {
    vi.clearAllMocks()
    // runSemantic now always fuses in the BM25 list alongside the dense one (RRF), so every test
    // in this describe block that doesn't care about FTS needs a default non-undefined return.
    searchSymbolsFtsMock.mockReturnValue([])
    root = mkdtempSync(join(tmpdir(), 'tg-sem-xt-emb-'))
  })

  it('drops hits in test files and keeps the rest', async () => {
    searchSemanticMock.mockResolvedValue([
      hit(join(root, 'src', 'a.ts'), 1, 5, 0.1),
      hit(join(root, 'tests', 'b.ts'), 600, 605, 0.2),
    ])

    const { text, code } = await runSemantic('q', { projectRoot: root, excludeTests: true })

    expect(code).toBe(0)
    expect(text).toContain('src/a.ts')
    expect(text).not.toContain('b.ts')
  })

  it('recognises a .test./.spec. suffix outside a tests/ directory', async () => {
    searchSemanticMock.mockResolvedValue([
      hit(join(root, 'src', 'a.ts'), 1, 5, 0.1),
      hit(join(root, 'src', 'b.test.ts'), 600, 605, 0.2),
      hit(join(root, 'src', 'c.spec.ts'), 1200, 1205, 0.3),
    ])

    const { text, code } = await runSemantic('q', { projectRoot: root, excludeTests: true })

    expect(code).toBe(0)
    expect(text).toContain('src/a.ts')
    expect(text).not.toContain('b.test.ts')
    expect(text).not.toContain('c.spec.ts')
  })

  it('filters before slicing to --limit: a low-ranked non-test hit still surfaces even though it would fall outside the unfiltered top-N', async () => {
    // 4 top-ranked (lowest distance) hits under tests/, 1 low-ranked hit under src/. With
    // --limit 1 and no filter-before-slice, `.slice(0, 1)` would keep only the first tests/ hit
    // and the src/ hit would never even reach the exclude-tests filter.
    searchSemanticMock.mockResolvedValue([
      hit(join(root, 'tests', 't0.ts'), 1, 5, 0.01),
      hit(join(root, 'tests', 't1.ts'), 600, 605, 0.02),
      hit(join(root, 'tests', 't2.ts'), 1200, 1205, 0.03),
      hit(join(root, 'tests', 't3.ts'), 1800, 1805, 0.04),
      hit(join(root, 'src', 'lowRanked.ts'), 2400, 2405, 0.99),
    ])
    // Pinned for the same reason the sibling --grep test pins it: without it a regression that
    // slices before filtering empties the embeddings branch, execution falls through to the FTS
    // fallback, and the unconfigured mock returns undefined -- the test would still go red, but
    // on an incidental TypeError rather than on the filter-before-slice claim it exists to make.
    searchSymbolsFtsMock.mockReturnValue([])

    const { text, code } = await runSemantic('q', { projectRoot: root, excludeTests: true, limit: 1 })

    expect(code).toBe(0)
    expect(text).toContain('src/lowRanked.ts')
    expect(text).not.toContain('tests/t0.ts')
  })

  it('composes with --grep: a hit must satisfy both filters', async () => {
    searchSemanticMock.mockResolvedValue([
      hit(join(root, 'src', 'keep.ts'), 1, 5, 0.1),
      // Matches --grep '^src/' but is a test file -- excluded by the second filter.
      hit(join(root, 'src', 'dropped.test.ts'), 600, 605, 0.2),
      // Not a test file but fails --grep '^src/'.
      hit(join(root, 'lib', 'other.ts'), 1200, 1205, 0.3),
    ])

    const { text, code } = await runSemantic('q', { projectRoot: root, excludeTests: true, grep: '^src/' })

    expect(code).toBe(0)
    expect(text).toContain('src/keep.ts')
    expect(text).not.toContain('dropped.test.ts')
    expect(text).not.toContain('lib/other.ts')
  })

  it('renders a filtered-to-empty notice, distinguishable from a genuinely empty search, when every hit was a test file (text and --json)', async () => {
    searchSemanticMock.mockResolvedValue([
      hit(join(root, 'tests', 'only.ts'), 1, 5, 0.1),
      hit(join(root, 'tests', 'other.ts'), 600, 605, 0.2),
    ])
    searchSymbolsFtsMock.mockReturnValue([])

    const textResult = await runSemantic('q', { projectRoot: root, excludeTests: true })
    // Exit 0, not the exit-1 a genuinely empty search returns: the store is not empty, the
    // filter emptied the view. Reporting it as "no matches" makes the caller stop looking.
    expect(textResult.code).toBe(0)
    expect(textResult.text).toContain('hidden by --exclude-tests')
    expect(textResult.text).toContain('2 in test files')
    expect(textResult.text).not.toContain('no matches for')

    const jsonResult = await runSemantic('q', { projectRoot: root, excludeTests: true, json: true })
    expect(jsonResult.code).toBe(0)
    const payload = JSON.parse(jsonResult.text) as { excludeTestsFilteredToEmpty?: boolean; indexEmpty?: boolean; hint?: string; items: unknown[] }
    expect(payload.excludeTestsFilteredToEmpty).toBe(true)
    expect(payload.indexEmpty).toBeUndefined()
    expect(payload.items).toEqual([])
    expect(payload.hint).toContain('--exclude-tests')
  })

  it('reports the --grep story first when both filters are set and both would empty the view', async () => {
    // The one hit is BOTH a test file and a --grep miss. --grep is the narrower, more
    // deliberate ask, so its notice takes priority -- matching runRefs's ordering.
    searchSemanticMock.mockResolvedValue([hit(join(root, 'tests', 'only.ts'), 1, 5, 0.1)])
    searchSymbolsFtsMock.mockReturnValue([])

    const { text, code } = await runSemantic('q', { projectRoot: root, excludeTests: true, grep: '^src/' })

    expect(code).toBe(0)
    expect(text).toContain('filtered out by --grep')
    expect(text).not.toContain('hidden by --exclude-tests')
  })

  it('leaves default (no --exclude-tests) output unchanged, still showing test hits', async () => {
    searchSemanticMock.mockResolvedValue([hit(join(root, 'tests', 'b.ts'), 1, 5, 0.1)])

    const { text, code } = await runSemantic('q', { projectRoot: root })

    expect(code).toBe(0)
    expect(text).toContain('tests/b.ts')
  })
})

describe('runSemantic --exclude-tests (FTS fallback branch)', () => {
  let root: string

  beforeEach(() => {
    vi.clearAllMocks()
    searchSemanticMock.mockResolvedValue([])
    root = mkdtempSync(join(tmpdir(), 'tg-sem-xt-fts-'))
  })

  it('drops hits in test files and keeps the rest', async () => {
    searchSymbolsFtsMock.mockReturnValue([
      row(join(root, 'src', 'a.ts'), 'fnA'),
      row(join(root, 'tests', 'b.ts'), 'fnB'),
    ])

    const { text, code } = await runSemantic('q', { projectRoot: root, excludeTests: true })

    expect(code).toBe(0)
    expect(text).toContain('fnA')
    expect(text).not.toContain('fnB')
  })

  it('over-fetches at the DB level when ONLY --exclude-tests is set, with no --grep', async () => {
    searchSymbolsFtsMock.mockReturnValue([])

    await runSemantic('q', { projectRoot: root, excludeTests: true, limit: 1 })

    // searchSymbolsFts caps results with a SQL LIMIT, so filtering its output after the fact for
    // a small --limit would silently under-fetch. The over-fetch used to be gated on --grep
    // alone; --exclude-tests needs it for exactly the same reason, so a regression that left the
    // gate keyed to --grep only would call through with the raw limit and fail here.
    expect(searchSymbolsFtsMock).toHaveBeenCalledTimes(1)
    const calledLimit = searchSymbolsFtsMock.mock.calls[0]?.[1]
    expect(calledLimit).toBe(Math.min(MAX_OVER_FETCH, 1 * OVER_FETCH_FACTOR))
    expect(calledLimit).toBeGreaterThan(1)
  })

  it('filters before slicing to --limit: a low-ranked non-test hit still surfaces even though it would fall outside the unfiltered top-N', async () => {
    searchSymbolsFtsMock.mockReturnValue([
      row(join(root, 'tests', 't0.ts'), 'fnT0'),
      row(join(root, 'tests', 't1.ts'), 'fnT1'),
      row(join(root, 'tests', 't2.ts'), 'fnT2'),
      row(join(root, 'src', 'lowRanked.ts'), 'fnLow'),
    ])

    const { text, code } = await runSemantic('q', { projectRoot: root, excludeTests: true, limit: 1 })

    expect(code).toBe(0)
    expect(text).toContain('fnLow')
    expect(text).not.toContain('fnT0')
  })

  it('renders a filtered-to-empty notice when every FTS hit was a test file', async () => {
    searchSymbolsFtsMock.mockReturnValue([
      row(join(root, 'tests', 'only.ts'), 'fnOnly'),
    ])

    const { text, code } = await runSemantic('q', { projectRoot: root, excludeTests: true })

    expect(code).toBe(0)
    expect(text).toContain('hidden by --exclude-tests')
    expect(text).toContain('1 in test file hidden')
    expect(text).not.toContain('no matches for')
  })

  it('a genuinely empty search (no --exclude-tests) still reports "no matches" and exits 1', async () => {
    searchSymbolsFtsMock.mockReturnValue([])

    const { text, code } = await runSemantic('nonexistent query term', { projectRoot: root })

    expect(code).toBe(1)
    expect(text).toContain('no matches for')
    expect(text).not.toContain('hidden by --exclude-tests')
  })

  it('a genuinely empty search WITH --exclude-tests still reports "no matches" and exits 1, since nothing was suppressed', async () => {
    // The anti-regression half: --exclude-tests must not turn a real empty result into a
    // filtered-to-empty notice. Nothing was hidden, so the old exit-1 message must survive.
    searchSymbolsFtsMock.mockReturnValue([])

    const { text, code } = await runSemantic('nonexistent query term', { projectRoot: root, excludeTests: true })

    expect(code).toBe(1)
    expect(text).toContain('no matches for')
    expect(text).not.toContain('hidden by --exclude-tests')
  })

  // Regression note: this used to assert a byte-identical, non-over-fetched call when neither
  // filter was set. Since runSemantic now ALWAYS fuses the BM25 list with the dense list (RRF),
  // rather than gating BM25 on the dense branch returning zero hits, searchSymbolsFts must always
  // be over-fetched -- the fusion rank needs real candidate breadth regardless of filters.
  it('over-fetches the searchSymbolsFts call even when neither filter is set (fusion always needs breadth, not just enough to fill --limit)', async () => {
    searchSymbolsFtsMock.mockReturnValue([])

    await runSemantic('q', { projectRoot: root, limit: 7 })

    expect(searchSymbolsFtsMock).toHaveBeenCalledTimes(1)
    expect(searchSymbolsFtsMock.mock.calls[0]?.[1]).toBe(Math.min(MAX_OVER_FETCH, 7 * OVER_FETCH_FACTOR))
  })
})
