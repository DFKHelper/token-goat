import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as EmbeddingsModule from '../src/embeddings.js'

// Regression: unlike a parse failure (logged via appendWorkerErrorLog/INDEX_FAILED --
// see logIndexFailure in worker.ts), an embedding failure inside indexFileEmbeddings had no log
// path at all. Compounded by the background daemon running with stdio: 'ignore'
// (startDetachedWorker), a thrown embedding error produced literally zero observable trace
// anywhere. Force the real embeddings.ts::indexFile choke point to throw and drive the real
// makeIndexer -> embedFileSerialized -> indexFileEmbeddings wiring, asserting the failure is now
// recorded in worker-errors.log the same way a parse failure already was.
vi.mock('../src/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof EmbeddingsModule>()
  return {
    ...actual,
    indexFile: vi.fn(async () => {
      throw new Error('embed boom')
    }),
  }
})

import * as fs from 'node:fs'

import { closeDb } from '../src/db.js'
import { fingerprintFile } from '../src/fingerprint.js'
import { makeIndexer } from '../src/worker.js'

describe('makeIndexer embedding-failure logging (regression)', () => {
  let DIR: string
  let prevEmbeddingsEnv: string | undefined

  beforeEach(() => {
    DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-worker-embed-errlog-'))
    prevEmbeddingsEnv = process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
    // tests/setup/isolate-home.ts defaults this to 'false' for the whole suite -- this test
    // needs the real embeddings pipeline actually invoked (and throwing) to exercise the
    // failure-logging path, so it must opt back in explicitly.
    process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
  })

  afterEach(() => {
    closeDb(path.join(DIR, 'global.db'))
    fs.rmSync(DIR, { recursive: true, force: true })
    if (prevEmbeddingsEnv === undefined) {
      delete process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
    } else {
      process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = prevEmbeddingsEnv
    }
  })

  it('records an embedding failure to worker-errors.log instead of swallowing it silently', async () => {
    const f = path.join(DIR, 'embed-fail.ts')
    fs.writeFileSync(f, 'export function x(): number {\n  return 1\n}\n')
    const sha = fingerprintFile(f)
    expect(sha).not.toBeNull()

    const dbPath = path.join(DIR, 'global.db')
    const indexer = makeIndexer(dbPath)
    // makeIndexer's default callback fires the embed off without the caller normally awaiting it
    // -- but it does return the promise so a caller (this test) that wants to observe its
    // settled state can await it explicitly instead of racing it.
    await indexer(f, sha as string)

    const logPath = path.join(DIR, 'worker-errors.log')
    expect(fs.existsSync(logPath)).toBe(true)
    const log = fs.readFileSync(logPath, 'utf8')
    expect(log).toContain('indexFileEmbeddings failed')
    expect(log).toContain(f)
    expect(log).toContain('embed boom')
  })
})
