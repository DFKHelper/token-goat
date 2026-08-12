// Regression: runSemantic (src/read_commands.ts) used to be a strict either/or -- if searchSemantic
// (dense vectors) returned even ONE hit, it formatted and returned immediately, never consulting
// searchSymbolsFts (BM25 keyword search) at all. So a query producing one weak dense hit made an
// exact keyword match that BM25 would rank first completely unreachable. This proves the fix: both
// result sets are now always fused (Reciprocal Rank Fusion) and an exact keyword match surfaces
// even when a weak, unrelated dense hit exists.
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

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

describe('runSemantic: RRF fusion closes the dense-nonzero-blocks-fts gap', () => {
  let root: string

  beforeEach(() => {
    vi.clearAllMocks()
    root = mkdtempSync(join(tmpdir(), 'tg-sem-rrf-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('surfaces an exact BM25 keyword match even when a weak, unrelated dense hit already exists', async () => {
    const weakDenseHit: SearchHit = {
      filePath: join(root, 'src', 'unrelated.ts'),
      startLine: 1,
      endLine: 5,
      kind: 'window',
      distance: 0.9,
      text: 'a weak, barely-related chunk',
    }
    searchSemanticMock.mockResolvedValue([weakDenseHit])
    searchSymbolsFtsMock.mockReturnValue([
      { filePath: join(root, 'src', 'exactMatch.ts'), name: 'validateAuthToken', kind: 'function', lineStart: 1, lineEnd: 3, body: 'function validateAuthToken() {}' },
    ])

    const { text, code } = await runSemantic('validateAuthToken', { projectRoot: root })

    expect(code).toBe(0)
    expect(text).toContain('exactMatch.ts')
    expect(text).toContain('validateAuthToken')
  })
})

describe('runSemantic: graceful single-sided degradation', () => {
  let root: string

  beforeEach(() => {
    vi.clearAllMocks()
    root = mkdtempSync(join(tmpdir(), 'tg-sem-rrf-degrade-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('returns pure-BM25 results, source "fts", when searchSemantic degrades to empty (no embeddings deps/vec0 table)', async () => {
    searchSemanticMock.mockResolvedValue([])
    searchSymbolsFtsMock.mockReturnValue([
      { filePath: join(root, 'src', 'onlyFts.ts'), name: 'onlyFtsFn', kind: 'function', lineStart: 1, lineEnd: 3, body: 'function onlyFtsFn() {}' },
    ])

    const { text, code } = await runSemantic('onlyFtsFn', { projectRoot: root, json: true })

    expect(code).toBe(0)
    const payload = JSON.parse(text) as { source: string; items: Array<{ filePath: string }> }
    expect(payload.source).toBe('fts')
    expect(payload.items.some((i) => i.filePath.includes('onlyFts.ts'))).toBe(true)
  })

  it('returns pure-dense results, source "embeddings", when searchSymbolsFts returns no rows (no FTS matches)', async () => {
    const denseHit: SearchHit = {
      filePath: join(root, 'src', 'onlyDense.ts'),
      startLine: 1,
      endLine: 5,
      kind: 'window',
      distance: 0.1,
      text: 'a real dense-only chunk',
    }
    searchSemanticMock.mockResolvedValue([denseHit])
    searchSymbolsFtsMock.mockReturnValue([])

    const { text, code } = await runSemantic('onlyDenseQuery', { projectRoot: root, json: true })

    expect(code).toBe(0)
    const payload = JSON.parse(text) as { source: string; items: Array<{ filePath: string }> }
    expect(payload.source).toBe('embeddings')
    expect(payload.items.some((i) => i.filePath.includes('onlyDense.ts'))).toBe(true)
  })

  it('reports source "hybrid" when both lists contributed at least one raw hit', async () => {
    const denseHit: SearchHit = {
      filePath: join(root, 'src', 'denseOne.ts'),
      startLine: 1,
      endLine: 5,
      kind: 'window',
      distance: 0.1,
      text: 'a dense chunk',
    }
    searchSemanticMock.mockResolvedValue([denseHit])
    searchSymbolsFtsMock.mockReturnValue([
      { filePath: join(root, 'src', 'ftsOne.ts'), name: 'ftsFn', kind: 'function', lineStart: 1, lineEnd: 3, body: 'function ftsFn() {}' },
    ])

    const { text, code } = await runSemantic('hybridQuery', { projectRoot: root, json: true })

    expect(code).toBe(0)
    const payload = JSON.parse(text) as { source: string }
    expect(payload.source).toBe('hybrid')
  })
})
