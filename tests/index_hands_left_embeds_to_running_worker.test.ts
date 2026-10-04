/** `token-goat index` hands every file it leaves unembedded to the background worker even when that worker is already running, and the worker embeds them without being restarted. Past its inline embedding budget, and while only the worker may download the model, `index` parses a file and leaves its `embed_sha` NULL for the worker. It left them to the worker's backlog sweep, which walks the index once per worker start, so a worker an earlier hook had started was done with that walk before `index` began and every file left behind stayed out of `semantic` until the worker next restarted: dogfooded on the 2.9.30 build, 1,448 of 2,001 files were still unembedded three minutes after `index` returned, with the worker running the whole time. Driven on the real default wiring, `cmdIndex` and `runWorkerLoop` with its own drain and indexer and no injected callback; only the embedding backend is stubbed (`setPipelineFnForTesting`), as tests/worker_embed_backlog_survives_a_stop.test.ts does. Provenance: HAND-DERIVED. The fixture is six small files this test writes, and how many of them are left follows from the zero budget passed in (the first embed is never charged to it) or from the deferral, not from the command's output. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cmdIndex } from '../src/cli.js'
import { invalidateConfigCache } from '../src/config.js'
import { dataDir, globalDbPath } from '../src/constants.js'
import { closeAllDbs, getDb } from '../src/db.js'
import { DEFAULT_DIM, embeddingsDepsAvailable, setPipelineFnForTesting } from '../src/embeddings.js'
import { nodeFetchHonoursEnvProxy, PROXY_VARS } from '../src/env_proxy.js'
import { getFileEntry } from '../src/index_reader.js'
import { resolveIndexPath } from '../src/paths.js'
import { pendingEmbeddings, runWorkerLoop } from '../src/worker.js'
import { indexableDir } from './helpers/temp-config.js'

const SOURCE_FILES = 5
// The package.json marker is indexed and embedded too.
const NAMES = ['package.json', ...Array.from({ length: SOURCE_FILES }, (_, i) => `mod${i}.ts`)]
// The model cache is cleared so the model reads as not downloaded, which is what lets the proxy case below defer; the stubbed backend never needs it.
const SAVED = ['TOKEN_GOAT_EMBEDDINGS_ENABLED', 'TOKEN_GOAT_OFFLINE', 'TOKEN_GOAT_MODEL_CACHE_DIR', 'NODE_USE_ENV_PROXY', ...PROXY_VARS] as const
const prev: Partial<Record<(typeof SAVED)[number], string | undefined>> = {}
let stopWorker: (() => Promise<void>) | null = null

beforeEach(() => {
  for (const k of SAVED) {
    prev[k] = process.env[k]
    delete process.env[k]
  }
  // The suite forces embeddings off (tests/setup/isolate-home.ts); nothing is left for the worker with them off.
  process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
  invalidateConfigCache()
  setPipelineFnForTesting(
    (async () => async (text: string) => ({
      data: Float32Array.from({ length: DEFAULT_DIM }, (_, i) => ((text.length + i) % 17) / 1700),
    })) as never,
  )
})

afterEach(async () => {
  await stopWorker?.()
  stopWorker = null
  setPipelineFnForTesting(null)
  for (const k of SAVED) {
    if (prev[k] === undefined) delete process.env[k]
    else process.env[k] = prev[k]
  }
  invalidateConfigCache()
  closeAllDbs()
})

/** A project of its own repository, outside the OS temp dir: the dirty queue and the backlog sweep both pass over a path under it. */
function freshProject(): string {
  const dir = indexableDir()
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"left-for-worker-fixture"}\n')
  for (let i = 0; i < SOURCE_FILES; i += 1) fs.writeFileSync(path.join(dir, `mod${i}.ts`), `export function handler${i}(n: number): number {\n  return n + ${i}\n}\n`)
  for (const args of [['init'], ['add', '-A']]) spawnSync('git', args, { cwd: dir, encoding: 'utf-8' })
  return dir
}

/** Run the real worker loop on this test file's data dir, the way a worker some earlier hook started is running, and return once it has idled through two cycles: its backlog walk has then crossed an index that owed it nothing, as a long-running worker's has. */
async function startRunningWorker(): Promise<void> {
  // The walk only runs once the index exists, so it is created before the loop's first cycle looks.
  getDb(globalDbPath())
  let checks = 0
  let stopping = false
  const loop = runWorkerLoop(dataDir(), 10, () => {
    checks += 1
    return stopping
  })
  stopWorker = async () => {
    stopping = true
    await loop
    await pendingEmbeddings()
  }
  // The loop asks twice a cycle, once before its drain and once before its sleep.
  await vi.waitFor(() => expect(checks).toBeGreaterThanOrEqual(4), { timeout: 10_000, interval: 10 })
}

async function runIndex(root: string, opts: { embedBudgetMs?: number }): Promise<string> {
  const errChunks: string[] = []
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    errChunks.push(String(chunk))
    return true
  })
  const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
    errChunks.push(a.map(String).join(' '))
  })
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  try {
    await cmdIndex(root, { walk: true, ...opts })
  } finally {
    out.mockRestore()
    err.mockRestore()
    warn.mockRestore()
    log.mockRestore()
  }
  return errChunks.join('')
}

/** The fixture files whose stored embedding is not of their current content. */
function unembedded(root: string): string[] {
  return NAMES.filter((name) => {
    const entry = getFileEntry(resolveIndexPath(path.join(root, name)), globalDbPath())
    return entry === null || entry.sha === '' || entry.embedSha !== entry.sha
  })
}

describe('index hands the files it leaves unembedded to a worker that is already running', () => {
  it('has the embedding dependencies this test needs', () => {
    // Without them every file takes the terminal-marker path and nothing is left for the worker, which would make the tests below pass for the wrong reason.
    expect(embeddingsDepsAvailable(getDb(globalDbPath()))).toBe(true)
  })

  it('embeds the files left past the inline embedding budget', async () => {
    const root = freshProject()
    await startRunningWorker()
    const stderr = await runIndex(root, { embedBudgetMs: 0 })
    // Calibration: one file was embedded here and the rest really were left for the worker.
    expect(stderr).toContain(`${NAMES.length - 1} files left for the background worker to embed`)
    await vi.waitFor(() => expect(unembedded(root)).toEqual([]), { timeout: 10_000, interval: 25 })
  })

  it.skipIf(!nodeFetchHonoursEnvProxy())('embeds the files whose model download was left to the worker', async () => {
    const root = freshProject()
    // A proxy this process's fetch would go around and the worker's goes through, so `index` defers the download and every embed behind it to the worker. Nothing is fetched: the backend is stubbed.
    process.env['HTTPS_PROXY'] = 'http://127.0.0.1:9'
    await startRunningWorker()
    const stderr = await runIndex(root, {})
    // Calibration: nothing was embedded here.
    expect(stderr).toContain(`${NAMES.length} files not embedded yet`)
    await vi.waitFor(() => expect(unembedded(root)).toEqual([]), { timeout: 10_000, interval: 25 })
  })
})
