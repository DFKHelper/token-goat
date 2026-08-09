// Regression: the fts and no-match branches of runSemantic's --json mode had test coverage
// (tests/semantic_json_output.test.ts), but the embeddings-source branch -- the one hit first
// whenever searchSemantic finds a real vector match -- had none. Mocks searchSemantic (same
// pattern as tests/semantic_rerank_order_survives_merge.test.ts) to force the embeddings branch,
// then asserts the JSON envelope matches the fts branch's shape: {source, items, truncated,
// totalCount}, with every item carrying the same keys (name/kind null on this branch, since
// embeddings hits have neither).
import * as path from 'node:path'
import * as os from 'node:os'

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

  // --json path-spelling: `filePath` used to echo searchSemantic's raw row verbatim, while the
  // plain-text branch already renders `toDisplayPath(rootDir, ...)`. Positive: an absolute
  // in-project hit renders root-relative. Negative control: an absolute out-of-project hit stays
  // absolute, unmangled -- proves the fix renders through toDisplayPath's own root-membership
  // check rather than blindly stripping a prefix from every row.
  it('renders an absolute in-project filePath root-relative, and leaves an absolute out-of-project filePath absolute', async () => {
    const inProjectAbs = path.join(process.cwd(), 'src', 'auth.ts')
    const outOfProjectAbs = path.join(os.tmpdir(), 'tg-semantic-outside-project-fixture', 'far.ts')
    const hits: SearchHit[] = [
      { filePath: inProjectAbs, startLine: 1, endLine: 10, kind: 'window', distance: 0.1, text: 'export function authenticate(token: string) {}' },
      { filePath: outOfProjectAbs, startLine: 1, endLine: 5, kind: 'window', distance: 0.2, text: 'export function farFn() {}' },
    ]
    searchSemanticMock.mockResolvedValue(hits)

    const { text, code } = await runSemantic('authenticate token far', { json: true })

    expect(code).toBe(0)
    const payload = JSON.parse(text) as { items: Array<{ filePath: string }> }
    expect(payload.items.some((i) => i.filePath === 'src/auth.ts')).toBe(true)
    expect(payload.items.some((i) => i.filePath === outOfProjectAbs)).toBe(true)
  })
})
