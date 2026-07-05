// Regression guard: `cmdSemantic` (src/cli.ts) used to call
// `mergeNearbyHits(await searchSemantic(db, query, n))`, so mergeNearbyHits only ever saw an
// already-truncated set of `n` raw hits. A nearby pair of hits that should have merged into one
// combined result could have one member cut by that pre-merge truncation, so the merge that
// should have happened never did -- and even when both survived, the final count could end up
// below the user's requested `n`, since merging only ever shrinks an already-capped set.
//
// The fix over-fetches a larger candidate set from searchSemantic (the same OVER_FETCH_FACTOR /
// MAX_OVER_FETCH ratio searchSemantic already uses internally for its own ANN over-fetch),
// merges nearby hits first, and only then truncates to the user's requested --limit.
//
// searchSemantic itself needs a real sqlite-vec-backed DB plus the embedding model to exercise
// end-to-end (expensive to fixture), so this test mocks searchSemantic to return a fixed
// candidate set while using the real mergeNearbyHits/OVER_FETCH_FACTOR/MAX_OVER_FETCH and the
// real cli.ts::cmdSemantic (via the exported run()) -- verifying the actual call-order fix,
// not just mergeNearbyHits in isolation.
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

const { run } = await import('../src/cli.js')

function hit(startLine: number, endLine: number, distance: number, text: string): SearchHit {
  return { filePath: 'src/auth.ts', startLine, endLine, kind: 'window', distance, text }
}

async function runCli(argv: string[]): Promise<{ code: number | string | undefined; stdout: string }> {
  const prev = process.exitCode
  process.exitCode = 0
  const chunks: string[] = []
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk))
    return true
  })
  try {
    await run(['node', 'token-goat', ...argv])
    return { code: process.exitCode, stdout: chunks.join('') }
  } finally {
    spy.mockRestore()
    process.exitCode = prev
  }
}

describe('semantic command: over-fetch before merge, merge before truncate (regression)', () => {
  it('over-fetches past --limit and merges a nearby pair that pre-fix truncation would have split apart', async () => {
    // Best-first (as rerankHits would return): chunk A (closest), chunk B (second-closest but far
    // away in the file), chunk C (third-closest but only 4 lines below chunk A -- within the
    // default proximity of 20, so A and C should merge into a single combined hit).
    const hits: SearchHit[] = [
      hit(1, 10, 0.1, 'chunk A'),
      hit(500, 510, 0.15, 'chunk B'),
      hit(15, 25, 0.2, 'chunk C'),
    ]
    searchSemanticMock.mockResolvedValue(hits)

    const { code, stdout } = await runCli(['semantic', 'auth query', '--limit', '2'])

    expect(code).toBe(0)
    // searchSemantic must be asked to over-fetch beyond the requested --limit of 2 (pre-fix, this
    // was called with topK=2 directly, which is not > 2).
    const requestedTopK = searchSemanticMock.mock.calls[0]?.[2]
    expect(requestedTopK).toBeGreaterThan(2)
    // Chunk A and chunk C merged into one combined block spanning lines 1-25, instead of chunk A
    // surviving alone (unmerged) because chunk C got truncated away before merging ever ran.
    expect(stdout).toContain('src/auth.ts:1-25')
    expect(stdout).not.toContain('src/auth.ts:1-10')
  })
})
