/** The worker's default indexer reads the configuration once per drained file. Every loadConfig() opens and fingerprints config.toml and the project's .token-goat.toml, and the indexer callback used to call it three times for a file whose content had not changed (skip check, then the oversize and chunk-count embed gates), which was most of the file opens such a drain made. */
// Fixture provenance: HAND-DERIVED. The indexed file is a one-function TypeScript source written below; the expected count follows from the callback's own contract (one argument-less read per file), not from its output.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import * as config from '../src/config.js'
import { closeAllDbs } from '../src/db.js'
import { fingerprintFile } from '../src/fingerprint.js'
import { normalizePath } from '../src/util.js'
import { makeIndexer } from '../src/worker.js'
import { clearModuleCaches } from '../src/reset.js'

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof config>()
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) }
})

/** Argument-less calls only: those resolve the process's own project and are the ones the callback can share. A rooted loadConfig(configRoot) belongs to the per-project embed policy, which memoizes it per indexer. */
function argumentlessLoadConfigCalls(): number {
  return vi.mocked(config.loadConfig).mock.calls.filter((args) => args.length === 0 || args[0] === undefined).length
}

describe('makeIndexer config reads', () => {
  let dir = ''
  const priorEmbeddings = process.env.TOKEN_GOAT_EMBEDDINGS_ENABLED

  beforeEach(() => {
    clearModuleCaches()
    // Embeddings off, so the first call settles the file completely (a disabled marker in embed_sha) without loading a model, and the second call reaches every gate as a no-op.
    process.env.TOKEN_GOAT_EMBEDDINGS_ENABLED = '0'
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ix-cfg-once-'))
  })

  afterEach(() => {
    if (priorEmbeddings === undefined) delete process.env.TOKEN_GOAT_EMBEDDINGS_ENABLED
    else process.env.TOKEN_GOAT_EMBEDDINGS_ENABLED = priorEmbeddings
    vi.mocked(config.loadConfig).mockClear()
    closeAllDbs()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  it('reads the configuration once for an unchanged file it skips', async () => {
    const file = normalizePath(path.join(dir, 'Widget.ts'))
    fs.writeFileSync(file, 'export function widget(): number {\n  return 1\n}\n')
    const dbPath = path.join(dir, 'idx.db')
    const sha = fingerprintFile(file)
    expect(sha, 'a readable fixture must fingerprint').not.toBeNull()

    const indexer = makeIndexer(dbPath)
    await indexer(file, sha as string)

    vi.mocked(config.loadConfig).mockClear()
    const result = await indexer(file, sha as string)

    expect(result, 'the second call must be the sha-gate no-op, or this measures a reparse instead').toBe(false)
    expect(argumentlessLoadConfigCalls(), 'config reads by the indexer callback for one unchanged file').toBe(1)
  })
})
