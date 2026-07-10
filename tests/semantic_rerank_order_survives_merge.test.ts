// Regression guard: searchSemantic (src/embeddings.ts) computes a rerank score via
// rerankHits (raw distance - verbatim-token boost + generated-path penalty) and sorts hits by
// it, but historically never attached that score back onto the hit object -- only the local
// `adjusted` variable inside rerankHits ever saw it. runSemantic (src/read_commands.ts) then
// passed searchSemantic's output through mergeNearbyHits, which re-sorted the merged set purely
// by each hit's raw `.distance`, silently discarding the rerank order: the verbatim-token boost
// and generated-path penalty were computed but never actually influenced the real `semantic`
// command's output ranking.
//
// The fix stamps `adjustedDistance` (the rerank score) onto each hit rerankHits returns, and
// mergeNearbyHits now sorts by `adjustedDistance` when present (falling back to raw `distance`
// for hits that never went through rerankHits), carrying it through merges by taking the min
// adjustedDistance among merged hits.
//
// searchSemantic itself needs a real sqlite-vec-backed DB plus the embedding model to exercise
// end-to-end (expensive to fixture), so this test mocks searchSemantic to return a fixed
// candidate set already carrying the adjustedDistance a real rerankHits call would have
// produced -- while using the real mergeNearbyHits and the real cli.ts::cmdSemantic (via the
// exported run()), so it drives the actual `semantic` command call chain a user would hit, not
// an isolated unit test of rerankHits alone.
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

function hit(
  filePath: string,
  startLine: number,
  endLine: number,
  distance: number,
  adjustedDistance: number,
  text: string,
): SearchHit {
  return { filePath, startLine, endLine, kind: 'window', distance, adjustedDistance, text }
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

describe('semantic command: rerank order (verbatim boost / generated-path penalty) survives mergeNearbyHits', () => {
  it('ranks a farther-but-verbatim/project-source hit above a closer-but-generated-path hit', async () => {
    // Chunk A: raw distance is the closest of the two, but it lives under dist/ (a generated
    // path), so a real rerankHits call would have pushed it down with the generated-path
    // penalty (+0.5) -- adjustedDistance 0.60.
    // Chunk B: raw distance is farther, but it's genuine project source containing the query's
    // verbatim tokens, so a real rerankHits call would have pulled it up with the verbatim-token
    // boost -- adjustedDistance 0.10.
    // Pre-fix (sort by raw distance): A (0.10) ranks ahead of B (0.30) -- the rerank is lost.
    // Post-fix (sort by adjustedDistance): B (0.10) ranks ahead of A (0.60) -- rerank survives.
    const hits: SearchHit[] = [
      hit('dist/bundle.js', 1, 10, 0.1, 0.6, 'minified generated chunk A'),
      hit('src/auth.ts', 1, 10, 0.3, 0.1, 'export function authenticate(token: string) {}'),
    ]
    searchSemanticMock.mockResolvedValue(hits)

    const { code, stdout } = await runCli(['semantic', 'authenticate token', '--limit', '2'])

    expect(code).toBe(0)
    const authIdx = stdout.indexOf('src/auth.ts')
    const bundleIdx = stdout.indexOf('dist/bundle.js')
    expect(authIdx).toBeGreaterThanOrEqual(0)
    expect(bundleIdx).toBeGreaterThanOrEqual(0)
    expect(authIdx).toBeLessThan(bundleIdx)
  })
})
