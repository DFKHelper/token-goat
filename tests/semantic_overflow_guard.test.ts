// Regression guard: runSemantic (src/read_commands.ts) returned `blocks.join('\n\n')` directly
// with no guardText(...) wrapping, unlike symbol/read/section/skeleton/outline, which all route
// their final text output through guardText/emitGuarded (see the "overflow guard applies to
// symbol/refs/skeleton/outline (#5)" suite in tests/read_commands.test.ts, whose pattern this
// mirrors). A large `semantic` result set could therefore blow past
// config.overflow_guard.max_tokens with no truncation marker, unlike every other surgical-read
// command.
//
// searchSemantic itself needs a real sqlite-vec-backed DB plus the embedding model to exercise
// end-to-end (expensive to fixture), so this test mocks searchSemantic to return a large
// candidate set while using the real runSemantic/guardText/mergeNearbyHits — exercising the
// actual overflow-guard wiring, not an isolated unit test of guardText alone.
import { describe, expect, it, vi, beforeEach } from 'vitest'

import type * as EmbeddingsModule from '../src/embeddings.js'
import type { SearchHit } from '../src/embeddings.js'
import { loadConfig } from '../src/config.js'

vi.mock('../src/config.js', () => ({
  loadConfig: vi.fn(),
}))

const searchSemanticMock = vi.fn()

vi.mock('../src/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof EmbeddingsModule>()
  return {
    ...actual,
    searchSemantic: (...args: Parameters<typeof actual.searchSemantic>) => searchSemanticMock(...args),
  }
})

const { runSemantic } = await import('../src/read_commands.js')

const mockLoadConfig = vi.mocked(loadConfig)

function hit(filePath: string, startLine: number, endLine: number, distance: number, text: string): SearchHit {
  return { filePath, startLine, endLine, kind: 'window', distance, text }
}

describe('semantic command output is capped by the overflow guard (#5 follow-up)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoadConfig.mockReturnValue({
      overflow_guard: { enabled: true, max_tokens: 20 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
  })

  it('caps runSemantic output when the real embedding-search path returns a large hit set', async () => {
    // Hits far enough apart (500-line gaps) that mergeNearbyHits never merges them, so the
    // rendered block count -- and the resulting text size -- stays large.
    const bigText = 'x'.repeat(500)
    const hits: SearchHit[] = Array.from({ length: 50 }, (_, i) =>
      hit('big.ts', i * 500 + 1, i * 500 + 10, i * 0.001, bigText),
    )
    searchSemanticMock.mockResolvedValue(hits)

    const { text, code } = await runSemantic('big query', { limit: 50 })

    expect(code).toBe(0)
    expect(text).toContain('output capped at ~20 tokens')
    expect(text).not.toContain('x'.repeat(500))
  })

  it('uses a semantic-tailored remediation hint, not the symbol command\'s "file.py::Class.method" hint (regression: guardText was called with the wrong command label)', async () => {
    const bigText = 'x'.repeat(500)
    const hits: SearchHit[] = Array.from({ length: 50 }, (_, i) =>
      hit('big.ts', i * 500 + 1, i * 500 + 10, i * 0.001, bigText),
    )
    searchSemanticMock.mockResolvedValue(hits)

    const { text } = await runSemantic('big query', { limit: 50 })

    expect(text).not.toContain('file.py::Class.method')
    expect(text).toContain('--limit')
  })
})

describe('semantic command scopes searchSemantic to the current project (regression: cross-project leakage)', () => {
  // global.db is a single machine-wide index shared across every project ever indexed
  // (constants.ts). runSemantic used to call searchSemantic with no project-root argument at
  // all, so results silently mixed in chunks from unrelated projects sharing the same index.
  it('passes process.cwd() as the rootDir (6th) argument to searchSemantic', async () => {
    searchSemanticMock.mockResolvedValue([])

    await runSemantic('any query', {})

    const call = searchSemanticMock.mock.calls[0]
    expect(call?.[5]).toBe(process.cwd())
  })
})
