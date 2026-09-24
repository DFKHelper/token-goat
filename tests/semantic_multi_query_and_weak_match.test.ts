// `semantic` took one query per call, so an agent with three questions paid three model round trips and three embedding-model loads; it now takes several, each answered by its own runSemantic call under a header naming it. Separately, nearest-neighbour search always returns something, so a page of unrelated chunks printed exactly like a page of answers: runSemantic now says when its best surviving dense hit is weak.
//
// searchSemantic is mocked (same pattern as tests/cli_semantic_merge_composition.test.ts) so each query's dense distance is exact, and the real cli.ts is driven through run() so the argument wiring is what is tested.
//
// PROVENANCE: HAND-DERIVED for the hits and distances (0.300 is inside, 0.950 outside, the weak band chosen in read_commands.ts from a capture of this repo's index: real questions 0.565-0.800, nonsense 0.863-1.043). FORMAT-DERIVED for the single-query block pinned below, read off runSemantic's dense-row render line (`# N. path:start-end (distance D.DDD)` then the preview) in src/read_commands.ts at HEAD 55796265.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

// Tokens no indexed symbol carries, so the keyword half contributes nothing and every block is the dense hit alone.
const STRONG = 'mqprobestrong7k'
const WEAK = 'mqprobeweak7k'

const DENSE: Record<string, SearchHit[]> = {
  [STRONG]: [{ filePath: 'src/strong_probe.ts', startLine: 1, endLine: 4, kind: 'window', distance: 0.3, text: 'strong probe body' }],
  [WEAK]: [{ filePath: 'src/weak_probe.ts', startLine: 7, endLine: 9, kind: 'window', distance: 0.95, text: 'weak probe body' }],
}

async function runCli(argv: string[]): Promise<{ code: number | string | undefined; stdout: string; stderr: string; warnings: string[] }> {
  const prev = process.exitCode
  process.exitCode = 0
  const outChunks: string[] = []
  const errChunks: string[] = []
  const warnings: string[] = []
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    outChunks.push(String(chunk))
    return true
  })
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    errChunks.push(String(chunk))
    return true
  })
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '))
  })
  try {
    await run(['node', 'token-goat', ...argv])
    return { code: process.exitCode, stdout: outChunks.join(''), stderr: errChunks.join(''), warnings }
  } finally {
    outSpy.mockRestore()
    errSpy.mockRestore()
    warnSpy.mockRestore()
    process.exitCode = prev
  }
}

let prevEmbedEnv: string | undefined

beforeEach(() => {
  // isolate-home.ts turns embeddings off for the suite, which would stop runSemantic before it reached the mock.
  prevEmbedEnv = process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
  searchSemanticMock.mockReset()
  searchSemanticMock.mockImplementation((_db: unknown, query: string) => Promise.resolve(DENSE[query] ?? []))
})

afterEach(() => {
  if (prevEmbedEnv === undefined) delete process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  else process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = prevEmbedEnv
})

const STRONG_BLOCK = '# 1. src/strong_probe.ts:1-4 (distance 0.300)\nstrong probe body'
const WEAK_BLOCK = '# 1. src/weak_probe.ts:7-9 (distance 0.950)\nweak probe body'

describe('semantic with several queries', () => {
  it('leaves a single query exactly as it rendered before, with no header line', async () => {
    const { code, stdout } = await runCli(['semantic', STRONG])
    expect(code).toBe(0)
    expect(stdout).toBe(`${STRONG_BLOCK}\n`)
  })

  it('answers each query in its own headed block, in argument order', async () => {
    const { code, stdout } = await runCli(['semantic', WEAK, STRONG])
    expect(code).toBe(0)
    expect(stdout).toBe(`'${WEAK}':\n${WEAK_BLOCK}\n\n'${STRONG}':\n${STRONG_BLOCK}\n`)
    expect(searchSemanticMock.mock.calls.map((c) => c[1])).toEqual([WEAK, STRONG])
  })

  it('returns a JSON array of per-query objects, each what the single-query call returns plus its query', async () => {
    const single = JSON.parse((await runCli(['semantic', STRONG, '--json'])).stdout) as Record<string, unknown>
    const { code, stdout } = await runCli(['semantic', STRONG, WEAK, '--json'])
    expect(code).toBe(0)
    const entries = JSON.parse(stdout) as Array<Record<string, unknown>>
    expect(entries.map((e) => e['query'])).toEqual([STRONG, WEAK])
    expect({ ...entries[0], query: undefined }).toEqual({ ...single, query: undefined })
  })

  it('rejects --preflight alongside several queries instead of silently running none of them', async () => {
    const { code, stderr } = await runCli(['semantic', STRONG, WEAK, '--preflight'])
    expect(code).toBe(1)
    expect(stderr).toContain('--preflight checks the embedding setup and runs no query')
    expect(searchSemanticMock).not.toHaveBeenCalled()
  })
})

describe('semantic says when its closest match is weak', () => {
  it('warns on stderr, naming the query and the distance, when the best dense hit is far', async () => {
    const { code, stdout, warnings } = await runCli(['semantic', WEAK])
    expect(code).toBe(0)
    // The notice goes to stderr, never into the result text a caller parses.
    expect(stdout).toBe(`${WEAK_BLOCK}\n`)
    const notice = warnings.filter((w) => w.includes('found nothing close'))
    expect(notice).toHaveLength(1)
    expect(notice[0]).toContain(`'${WEAK}'`)
    expect(notice[0]).toContain('closest was 0.950')
    expect(notice[0]).toContain('token-goat symbol --grep')
  })

  it('stays silent when the best dense hit is close', async () => {
    const { warnings } = await runCli(['semantic', STRONG])
    expect(warnings.filter((w) => w.includes('found nothing close'))).toEqual([])
  })

  it('carries the notice as a JSON field instead of stderr prose under --json', async () => {
    const weak = await runCli(['semantic', WEAK, '--json'])
    const payload = JSON.parse(weak.stdout) as { lowConfidence?: { closestDistance: number; threshold: number } }
    expect(payload.lowConfidence?.closestDistance).toBe(0.95)
    expect(payload.lowConfidence?.threshold).toBeLessThan(0.95)
    expect(weak.warnings.filter((w) => w.includes('found nothing close'))).toEqual([])
    const strong = JSON.parse((await runCli(['semantic', STRONG, '--json'])).stdout) as Record<string, unknown>
    expect(strong).not.toHaveProperty('lowConfidence')
  })
})
