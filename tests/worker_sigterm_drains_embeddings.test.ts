/**
 * The detached worker daemon's SIGTERM handler must give an in-flight embedding a real chance to
 * finish before the process exits, bounded so a wedged embedding can never block a replacement
 * daemon from starting.
 *
 * `pendingEmbeddings()` (tracks every embed call dispatched via `embedFileSerialized`, itself fed
 * by `makeIndexer`'s real default indexer) had zero callers anywhere in `src/` before this fix --
 * `runDetachedWorkerDaemon`'s SIGTERM handler called `process.exit(0)` immediately, so a daemon
 * replaced mid-batch (see `claimWorkerPidFile`'s reclaim path) or stopped via `worker stop` while an
 * embedding was still running dropped that call's result silently: `symbol`/`read` stayed correct
 * (parse rows commit synchronously, before embedding is even dispatched), but the vectors `semantic`
 * depends on for that file's content never landed. `sigtermDrainDeadline` (extracted from the
 * handler so it can be driven directly here, bounded rather than the handler's fixed 5s in
 * production) now races `pendingEmbeddings()` against a caller-supplied timeout.
 *
 * Driven through the REAL default indexer path: `makeIndexer(dbPath)` with no injected index
 * callback dispatches the real `embedFileSerialized`, which is what actually populates
 * `inFlightEmbeddings`/`pendingEmbeddings()` in production -- this test never touches that map
 * directly. The embedding BACKEND is the one thing stubbed (`setPipelineFnForTesting`, same seam
 * `tests/embed_oversize_threshold_regate.test.ts` uses), controlled here to resolve after a known
 * delay so the race has a deterministic, non-flaky outcome instead of a real network model fetch.
 *
 * Provenance: HAND-DERIVED timing fixture (a fake pipeline with a caller-chosen delay), asserted
 * against wall-clock bounds computed from that same delay, not against the implementation's own
 * constants.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs } from '../src/db.js'
import { DEFAULT_DIM, setPipelineFnForTesting } from '../src/embeddings.js'
import { getFileEntry } from '../src/index_reader.js'
import { indexFileSync } from '../src/parser.js'
import { fingerprintFile } from '../src/fingerprint.js'
import { makeIndexer, pendingEmbeddings, sigtermDrainDeadline } from '../src/worker.js'
import { clearModuleCaches } from '../src/reset.js'

let DIR: string
let dbPath: string
let filePath: string
let prevEmbeddingsEnv: string | undefined

/** Resolves after `ms`, so the embed call this drives has a controllable, known duration. */
function delayedPipeline(ms: number): unknown {
  return async () =>
    async (text: string) => {
      await new Promise((resolve) => setTimeout(resolve, ms))
      return { data: Float32Array.from({ length: DEFAULT_DIM }, (_, i) => ((text.length + i) % 17) / 1700) }
    }
}

beforeEach(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-sigterm-drain-'))
  dbPath = path.join(DIR, 'global.db')
  filePath = path.join(DIR, 'widget.ts')
  // Long enough to clear embeddings.ts's MIN_CHUNK_CHARS (50): a chunk under that floor is
  // filtered before ever reaching the pipeline, which would make every case below pass because
  // nothing was ever dispatched, not because the drain logic under test worked.
  fs.writeFileSync(
    filePath,
    'export function widget(): number {\n  // padding so this chunk clears MIN_CHUNK_CHARS and the fake pipeline actually runs\n  return 1\n}\n',
  )
  prevEmbeddingsEnv = process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
  // clearModuleCaches() also resets _pipelineFnOverride to null (see embeddings.ts's own
  // registerReset), so it must run BEFORE each test's own setPipelineFnForTesting call, not after.
  clearModuleCaches()
})

afterEach(() => {
  setPipelineFnForTesting(null)
  if (prevEmbeddingsEnv === undefined) delete process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  else process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = prevEmbeddingsEnv
  closeAllDbs()
  fs.rmSync(DIR, { recursive: true, force: true })
})

/** Seeds a real files row (indexFileSync) and dispatches the real default embedder for it via makeIndexer, returning the sha dispatched with. */
function dispatchRealEmbed(): string {
  indexFileSync(filePath, dbPath)
  const sha = fingerprintFile(filePath)
  expect(sha, 'fingerprintFile could not hash the fixture').not.toBeNull()
  makeIndexer(dbPath)(filePath, sha as string)
  return sha as string
}

describe('sigtermDrainDeadline', () => {
  it('calibration: an embed dispatched through the real default indexer is actually tracked by pendingEmbeddings', async () => {
    setPipelineFnForTesting(delayedPipeline(30) as never)
    dispatchRealEmbed()
    // If this resolves instantly, the dispatched call was never tracked and every case below
    // would pass for the wrong reason (racing against nothing).
    const start = Date.now()
    await pendingEmbeddings()
    expect(Date.now() - start, 'pendingEmbeddings resolved before the tracked embed call did').toBeGreaterThanOrEqual(20)
  })

  it('waits for a real in-flight embedding to finish before the deadline elapses, and the row shows a completed embed', async () => {
    setPipelineFnForTesting(delayedPipeline(100) as never)
    const sha = dispatchRealEmbed()

    await sigtermDrainDeadline(3000)

    const entry = getFileEntry(filePath, dbPath)
    expect(
      entry?.embedSha,
      'sigtermDrainDeadline returned before the in-flight embed committed its row',
    ).toBe(sha)
  })

  it('does not wait past its own timeout for an embed that never finishes', async () => {
    setPipelineFnForTesting((async () => async () => new Promise(() => {
      // never resolves
    })) as never)
    dispatchRealEmbed()

    const start = Date.now()
    await sigtermDrainDeadline(80)
    const elapsed = Date.now() - start
    expect(elapsed, 'sigtermDrainDeadline waited far longer than its own bound for a call that will never settle').toBeLessThan(1000)
  })
})
