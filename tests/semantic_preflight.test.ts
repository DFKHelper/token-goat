import { afterEach, describe, expect, it } from 'vitest'
import { checkEmbeddingPreflight } from '../src/embed_model.js'
import { runSemantic } from '../src/read_semantic.js'

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
    // The dev tree installs onnxruntime-node (a devDependency), and embed_runtime.ts prefers it whenever it resolves, so this is the runtime the line names here. HAND-DERIVED from package.json devDependencies and chooseRuntime().
    expect(res.text).toMatch(/ONNX runtime \(onnxruntime-node\): (available \(\d+\.\d+\.\d+\)|unavailable)/)
  })

  it('runSemantic --preflight --json returns valid json with status fields', async () => {
    const res = await runSemantic('', { preflight: true, json: true })
    const parsed = JSON.parse(res.text)
    expect(parsed).toHaveProperty('status')
    expect(parsed).toHaveProperty('available')
    expect(parsed).toHaveProperty('configEnabled')
    expect(parsed).toHaveProperty('runtimeAvailable')
    // Which build runs the model, and on the WebAssembly one whether its binary is on disk yet; null on the native binding, which has none.
    expect(['onnxruntime-node', 'onnxruntime-web']).toContain(parsed.runtime)
    expect(parsed.runtimeBinaryPresent === null || typeof parsed.runtimeBinaryPresent === 'boolean').toBe(true)
    expect(parsed.runtimeBinaryPresent === null).toBe(parsed.runtime === 'onnxruntime-node')
  })
})
