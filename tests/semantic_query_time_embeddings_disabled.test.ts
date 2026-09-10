// Regression for the query-time half of indexing.embeddings_enabled / TOKEN_GOAT_EMBEDDINGS_ENABLED. The flag
// already gates embedding at index time (parser.ts, worker.ts) and in memory_prune.ts's tryEmbeddingClusters, but
// runSemantic's dense pass called embeddings.js's searchSemantic unconditionally: it only ever consulted
// embeddingModelAvailable() (whether the optional onnxruntime-node runtime is installed), never the config flag.
// On a machine where that runtime IS installed (this dev/CI checkout has it in node_modules), disabling the flag
// did nothing at query time: `semantic` still called searchSemantic, which calls embedTexts, which downloads the
// ~34 MB model on a cold cache -- exactly the download loop 17 hit after deliberately setting the flag to stop it.
// searchSemantic (not embedTexts/embedModel) is the fixture's fetch-entry-point stand-in: it is the one and only
// production call site that leads to embedTexts, so "was this mock ever invoked" is equivalent to "did runSemantic
// ever reach the code path capable of triggering a download" without needing to mock deeper and without ever
// fetching a real model. isAvailable is also mocked to `true` (CAPTURE: this checkout genuinely has
// onnxruntime-node installed under node_modules/onnxruntime-node, verified via a plain directory listing) so the
// test exercises the exact "runtime present, flag off" combination that hid this bug -- with the real isAvailable(),
// a dev machine without the runtime would pass this test even pre-fix, for the wrong reason.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as EmbeddingsModule from '../src/embeddings.js'
import type { SearchHit } from '../src/embeddings.js'
import type { indexFileSync as IndexFileSync } from '../src/parser.js'
import type { normalizePath as NormalizePath } from '../src/paths.js'
import type { runSemantic as RunSemantic } from '../src/read_commands.js'

import { clearModuleCaches } from '../src/reset.js'

const searchSemanticMock = vi.fn()

vi.mock('../src/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof EmbeddingsModule>()
  return {
    ...actual,
    searchSemantic: (...args: Parameters<typeof actual.searchSemantic>) => searchSemanticMock(...args),
    isAvailable: () => true,
  }
})

let indexFileSync: typeof IndexFileSync
let normalizePath: typeof NormalizePath
let runSemantic: typeof RunSemantic

let root: string
let prevEmbedEnv: string | undefined

beforeEach(async () => {
  prevEmbedEnv = process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  clearModuleCaches()
  searchSemanticMock.mockReset()
  ;({ indexFileSync } = await import('../src/parser.js'))
  ;({ normalizePath } = await import('../src/paths.js'))
  ;({ runSemantic } = await import('../src/read_commands.js'))
  root = mkdtempSync(join(tmpdir(), 'tg-sem-embed-gate-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  if (prevEmbedEnv === undefined) delete process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  else process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = prevEmbedEnv
  clearModuleCaches()
})

describe('runSemantic query-time embeddings_enabled gate', () => {
  it('never reaches searchSemantic (and therefore never reaches embedTexts / the model download) when the flag is off, even with the runtime available, and still answers from BM25', async () => {
    process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'false'
    const file = join(root, 'gated.ts')
    writeFileSync(file, 'export function semEmbedGateTermQ7x2() { return 1 }\n')
    indexFileSync(normalizePath(file))

    const { code, text } = await runSemantic('semEmbedGateTermQ7x2', { projectRoot: root })

    expect(searchSemanticMock).not.toHaveBeenCalled()
    expect(code).toBe(0)
    expect(text).toContain('semEmbedGateTermQ7x2')
  })

  it('positive control: still reaches searchSemantic when the flag is on and the runtime is available', async () => {
    process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
    const file = join(root, 'ungated.ts')
    writeFileSync(file, 'export function semEmbedGateTermQ7x3() { return 2 }\n')
    indexFileSync(normalizePath(file))
    searchSemanticMock.mockResolvedValue([] as SearchHit[])

    const { code } = await runSemantic('semEmbedGateTermQ7x3', { projectRoot: root })

    expect(searchSemanticMock).toHaveBeenCalled()
    expect(code).toBe(0)
  })
})
