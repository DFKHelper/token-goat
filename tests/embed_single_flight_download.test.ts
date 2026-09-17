import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ensureModelFiles } from '../src/embed_model.js'
import { runSemantic } from '../src/read_commands.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

describe('Embedding Single-Flight Download & Degraded Search Handling', () => {
  let savedCacheDir: string | undefined

  beforeEach(() => {
    savedCacheDir = process.env['TOKEN_GOAT_MODEL_CACHE_DIR']
    delete process.env['TOKEN_GOAT_MODEL_CACHE_DIR']
  })

  afterEach(() => {
    if (savedCacheDir !== undefined) {
      process.env['TOKEN_GOAT_MODEL_CACHE_DIR'] = savedCacheDir
    } else {
      delete process.env['TOKEN_GOAT_MODEL_CACHE_DIR']
    }
  })

  it('shares single-flight in-progress download promise across concurrent callers', async () => {
    // When ensureModelFiles is called concurrently, they should coalesce onto the same in-flight promise
    const p1 = ensureModelFiles()
    const p2 = ensureModelFiles()
    expect(p1 === p2).toBe(true)
    const [r1, r2] = await Promise.all([p1, p2])
    expect(typeof r1).toBe('string')
    expect(r1).toBe(r2)
  })

  it('reports degraded status cleanly in runSemantic when semantic search is degraded or misses', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-semantic-degraded-'))
    try {
      // Running semantic search in JSON mode on an empty or degraded index
      const res = await runSemantic('arbitrary_test_query_xyz', {
        json: true,
        projectRoot: tmpDir,
      })
      const parsed = JSON.parse(res.text)
      expect(parsed).toHaveProperty('source')
      expect(parsed).toHaveProperty('items')
      expect(Array.isArray(parsed.items)).toBe(true)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
