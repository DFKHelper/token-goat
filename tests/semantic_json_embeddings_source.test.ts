// Regression: the fts and no-match branches of runSemantic's --json mode had test coverage
// (tests/semantic_json_output.test.ts), but the embeddings-source branch -- the one hit first
// whenever searchSemantic finds a real vector match -- had none. Mocks searchSemantic (same
// pattern as tests/semantic_rerank_order_survives_merge.test.ts) to force the embeddings branch,
// then asserts the JSON envelope matches the fts branch's shape: {source, items, truncated,
// totalCount}, with every item carrying the same keys (name/kind null on this branch, since
// embeddings hits have neither).
import { describe, expect, it, vi } from 'vitest'

import type * as EmbeddingsModule from '../src/embeddings.js'
import type { SearchHit } from '../src/embeddings.js'

const searchSemanticMock = vi.fn()

vi.mock('../src/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof EmbeddingsModule>()
  return {
    ...actual,
    searchSemantic: (...args: Parameters<typeof actual.searchSemantic>) => searchSemanticMock(...args),
  }
})

const { runSemantic } = await import('../src/read_commands.js')

describe('runSemantic --json: embeddings source', () => {
  it('returns a {source, items, truncated, totalCount} envelope with name/kind null on an embeddings hit', async () => {
    const hits: SearchHit[] = [
      { filePath: 'src/auth.ts', startLine: 1, endLine: 10, kind: 'window', distance: 0.12, text: 'export function authenticate(token: string) {}' },
    ]
    searchSemanticMock.mockResolvedValue(hits)

    const { text, code } = await runSemantic('authenticate token', { json: true })

    expect(code).toBe(0)
    const payload = JSON.parse(text) as {
      source: string
      items: Array<{ filePath: string; name: unknown; kind: unknown; distance: number; preview: string }>
      truncated: boolean
      totalCount: number
    }
    expect(payload.source).toBe('embeddings')
    expect(payload.items.length).toBe(1)
    expect(payload.items[0]?.filePath).toBe('src/auth.ts')
    expect(payload.items[0]?.name).toBeNull()
    expect(payload.items[0]?.kind).toBeNull()
    expect(payload.items[0]?.distance).toBe(0.12)
    expect(payload.truncated).toBe(false)
    expect(payload.totalCount).toBe(1)
  })
})
