// `semantic --warm` with no query is the documented foreground warm-up command, but cli.ts let it through to runSemantic('', { warm }), which ran a search for '' and ended "no matches for ''" with exit 1. The warm-up itself is stubbed here (checkSemanticReadiness is mocked) so no model is downloaded or loaded; searchSemantic is mocked to prove no search runs.
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as EmbedPreflightModule from '../src/embed_preflight.js'
import type * as EmbeddingsModule from '../src/embeddings.js'
import type { EmbeddingPreflightResult } from '../src/embed_model.js'

const readinessMock = vi.fn()
const searchSemanticMock = vi.fn()

vi.mock('../src/embed_preflight.js', async (importOriginal) => {
  const actual = await importOriginal<typeof EmbedPreflightModule>()
  return { ...actual, checkSemanticReadiness: (...args: Parameters<typeof actual.checkSemanticReadiness>) => readinessMock(...args) }
})

vi.mock('../src/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof EmbeddingsModule>()
  return { ...actual, searchSemantic: (...args: unknown[]) => searchSemanticMock(...args) }
})

const { runSemantic } = await import('../src/read_semantic.js')

// HAND-DERIVED: every field of EmbeddingPreflightResult (src/embed_model.ts), filled with the values a warmed, fully embedded project reports.
function readyResult(overrides: Partial<EmbeddingPreflightResult> = {}): EmbeddingPreflightResult {
  return {
    status: 'ready',
    available: true,
    message: 'Semantic search is ready.',
    summary: 'Semantic search is ready.',
    modelName: 'test-model',
    runtime: 'onnxruntime-node',
    runtimeVersion: '1.0.0',
    runtimeAvailable: true,
    runtimeBinaryPresent: null,
    configEnabled: true,
    modelFilesPresent: true,
    modelWarmed: true,
    modelDir: '/models/test',
    indexedFiles: 4,
    embeddedFiles: 4,
    coveragePercent: 100,
    ...overrides,
  }
}

beforeEach(() => {
  readinessMock.mockReset()
  searchSemanticMock.mockReset()
})

describe('semantic --warm without a query', () => {
  it('warms the model, reports readiness and exits 0 without searching', async () => {
    readinessMock.mockResolvedValue(readyResult())
    const res = await runSemantic('', { warm: true })
    expect(readinessMock).toHaveBeenCalledWith(expect.objectContaining({ warm: true }))
    expect(res.code).toBe(0)
    expect(res.text).toContain('Semantic embedding status: READY')
    expect(res.text).toContain('In-memory session: ready / warmed')
    expect(res.text).not.toContain('no matches')
    expect(searchSemanticMock).not.toHaveBeenCalled()
  })

  it('answers --json with the readiness object, not a search envelope', async () => {
    readinessMock.mockResolvedValue(readyResult())
    const res = await runSemantic('', { warm: true, json: true })
    const parsed = JSON.parse(res.text) as Record<string, unknown>
    expect(res.code).toBe(0)
    expect(parsed['status']).toBe('ready')
    expect(parsed).not.toHaveProperty('items')
    expect(parsed).not.toHaveProperty('source')
  })

  it('exits 1 when the warm-up leaves the model unusable, naming the action', async () => {
    readinessMock.mockResolvedValue(readyResult({ status: 'missing_model_files', available: false, modelFilesPresent: false, modelWarmed: false, summary: 'model missing', actionRequired: 'Run the download' }))
    const res = await runSemantic('', { warm: true })
    expect(res.code).toBe(1)
    expect(res.text).toContain('MISSING_MODEL_FILES')
    expect(res.text).toContain('Action: Run the download')
    expect(searchSemanticMock).not.toHaveBeenCalled()
  })

  it('still runs the search when a query comes with --warm', async () => {
    readinessMock.mockResolvedValue(readyResult())
    const res = await runSemantic('refresh a credential', { warm: true })
    expect(res.text).toContain('no matches for "refresh a credential"')
    expect(res.text).not.toContain('Semantic embedding status')
  })
})
