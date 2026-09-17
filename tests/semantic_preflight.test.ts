import { afterEach, describe, expect, it } from 'vitest'
import { checkEmbeddingPreflight } from '../src/embed_model.js'
import { runSemantic } from '../src/read_commands.js'

describe('checkEmbeddingPreflight', () => {
  const originalEnv = process.env.TOKEN_GOAT_EMBEDDINGS_ENABLED

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.TOKEN_GOAT_EMBEDDINGS_ENABLED = originalEnv
    } else {
      delete process.env.TOKEN_GOAT_EMBEDDINGS_ENABLED
    }
  })

  it('detects when embeddings are disabled via environment variable', async () => {
    process.env.TOKEN_GOAT_EMBEDDINGS_ENABLED = '0'
    const result = await checkEmbeddingPreflight()
    expect(result.status).toBe('disabled')
    expect(result.available).toBe(false)
    expect(result.configEnabled).toBe(false)
    expect(result.message).toContain('Matching on meaning is off')
    expect(result.suggestion).toBeDefined()
  })

  it('populates diagnostic fields when checking preflight', async () => {
    const result = await checkEmbeddingPreflight()
    expect(result.modelName).toBeDefined()
    expect(result.runtimeVersion).toBeDefined()
    expect(typeof result.modelFilesPresent).toBe('boolean')
    expect(typeof result.runtimeAvailable).toBe('boolean')
    expect(typeof result.configEnabled).toBe('boolean')
    expect(typeof result.indexedFiles).toBe('number')
    expect(typeof result.embeddedFiles).toBe('number')
    expect(typeof result.coveragePercent).toBe('number')
  })

  it('runSemantic --preflight returns status report', async () => {
    const res = await runSemantic('', { preflight: true })
    expect(res.text).toContain('Semantic embedding status:')
    expect(res.text).toContain('Config (indexing.embeddings_enabled):')
    expect(res.text).toContain('ONNX runtime (onnxruntime-node):')
  })

  it('runSemantic --preflight --json returns valid json with status fields', async () => {
    const res = await runSemantic('', { preflight: true, json: true })
    const parsed = JSON.parse(res.text)
    expect(parsed).toHaveProperty('status')
    expect(parsed).toHaveProperty('available')
    expect(parsed).toHaveProperty('configEnabled')
    expect(parsed).toHaveProperty('runtimeAvailable')
  })
})
