/** With the network blocked and no model on the machine, the worker drained 30 files by asking huggingface.co for the tokenizer 30 times in 25 s and logging 60 lines that each said only "fetch failed". The download now records its failure (src/model_download_gate.ts), later embeds wait the hold out, and the worker logs one line per recorded failure, with the reason Node keeps on the error's cause. Why didn't a test catch this: every worker embed test either mocked embeddings.ts or ran with embeddings off (tests/setup/isolate-home.ts), so no test ever let the real embed path reach a network that refused it. These cases drive the production default path (drainOnce with no injected indexer, the real embed chain, the real pinned download) with only the global fetch replaced. PROVENANCE: the refused fetch is shaped from a CAPTURE on node v24.12.0 (NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:9 makes fetch reject with TypeError('fetch failed') whose cause is an Error with code ECONNREFUSED and message "connect ECONNREFUSED 127.0.0.1:9"). The fixture source files and counts are HAND-DERIVED. */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cmdIndex } from '../src/cli.js'
import { _resetDataDirCacheForTesting, dataDir, globalDbPath } from '../src/constants.js'
import { closeAllDbs, getDb } from '../src/db.js'
import { appendDirtyQueuePaths, dirtyQueuePathFor } from '../src/dirty_queue.js'
import { querySymbols } from '../src/index_reader.js'
import { MODEL_DOWNLOAD_HOST, lastDownloadFailure, recordDownloadFailure } from '../src/model_download_gate.js'
import { setPinnedRetryDelayForTesting } from '../src/pinned_fetch.js'
import { clearModuleCaches } from '../src/reset.js'
import { drainOnce, pendingEmbeddings } from '../src/worker.js'
import { workerErrorLogPath } from '../src/worker_lifecycle.js'
import { indexableDir } from './helpers/temp-config.js'

const ENV_KEYS = ['TOKEN_GOAT_EMBEDDINGS_ENABLED', 'TOKEN_GOAT_MODEL_CACHE_DIR', 'TOKEN_GOAT_OFFLINE', 'TOKEN_GOAT_REQUIRE_EMBED_MODEL'] as const
const FILES = 30

let saved: Record<string, string | undefined>
let modelFetches: string[]

function refused(): TypeError {
  const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED', errno: -4078, syscall: 'connect', address: '127.0.0.1', port: 9 })
  return new TypeError('fetch failed', { cause })
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  // isolate-home turns embeddings off for the suite; the shipped default is on, and the embed path is what this file is about.
  delete process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  // The machine's shared cache holds the real model; these cases are about a machine that has none.
  delete process.env['TOKEN_GOAT_MODEL_CACHE_DIR']
  delete process.env['TOKEN_GOAT_OFFLINE']
  delete process.env['TOKEN_GOAT_REQUIRE_EMBED_MODEL']
  _resetDataDirCacheForTesting()
  clearModuleCaches()
  fs.rmSync(dirtyQueuePathFor(dataDir()), { force: true })
  fs.rmSync(workerErrorLogPath(dataDir()), { force: true })
  fs.rmSync(path.join(dataDir(), 'models'), { recursive: true, force: true })
  setPinnedRetryDelayForTesting(0)
  modelFetches = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (new URL(url).host === MODEL_DOWNLOAD_HOST) modelFetches.push(url)
      throw refused()
    }),
  )
})

afterEach(async () => {
  await pendingEmbeddings()
  vi.unstubAllGlobals()
  setPinnedRetryDelayForTesting(null)
  closeAllDbs()
  // The failure record lives under the shared data dir; left behind, it would hold downloads for whichever test file this worker runs next.
  fs.rmSync(path.join(dataDir(), 'models'), { recursive: true, force: true })
  for (const key of ENV_KEYS) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  _resetDataDirCacheForTesting()
  clearModuleCaches()
})

function project(prefix: string, count: number): string[] {
  const dir = indexableDir()
  return Array.from({ length: count }, (_, i) => {
    const file = path.join(dir, `${prefix}${i}.ts`)
    fs.writeFileSync(file, `export function ${prefix}${i}(): number {\n  return ${i}\n}\n`)
    return file
  })
}

function errorLogLines(): string[] {
  const log = workerErrorLogPath(dataDir())
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').split('\n').filter((l) => l.trim() !== '') : []
}

function embedShas(files: readonly string[]): unknown[] {
  const rows = getDb(globalDbPath()).prepare('SELECT path, embed_sha FROM files').all() as { path: string; embed_sha: string | null }[]
  const wanted = new Set(files.map((f) => path.basename(f)))
  return rows.filter((r) => wanted.has(path.basename(r.path))).map((r) => r.embed_sha)
}

describe('worker drain with the model download refused', () => {
  it('tries the download once (three attempts), logs one line with the reason, and still indexes every symbol', async () => {
    const files = project('dlRefused', FILES)
    appendDirtyQueuePaths(dataDir(), files)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(drainOnce(dataDir())).toBe(FILES)
    await pendingEmbeddings()
    const banners = warn.mock.calls.filter((c) => String(c[0]).startsWith('Downloading the embedding model'))
    warn.mockRestore()

    // Before the worker checked the hold when an embed starts, the embeds queued behind the failed download each announced a download and were then refused: 24 announcements for one request. What remains is the one embed that made the request: buildExtractorWithRetry in embeddings.ts retries the whole load 3 times, and embed_model.ts announces before downloadPinned checks the hold, so its 2 retries announce and are refused without a request. Both files are hashed into EMBED_FINGERPRINT, where reordering the two would re-embed every index, so the bound is that retry count rather than 1.
    expect(banners.length, banners.join('\n')).toBeGreaterThan(0)
    expect(banners.length, banners.join('\n')).toBeLessThanOrEqual(3)
    expect(modelFetches.length, modelFetches.join('\n')).toBeGreaterThan(0)
    expect(modelFetches.length, modelFetches.join('\n')).toBeLessThanOrEqual(3)
    const lines = errorLogLines()
    expect(lines, lines.join('\n')).toHaveLength(1)
    expect(lines[0]).toContain('ECONNREFUSED 127.0.0.1:9')

    expect(lastDownloadFailure(MODEL_DOWNLOAD_HOST)).toMatchObject({ failures: 1 })
    for (const i of [0, FILES - 1]) expect(querySymbols({ name: `dlRefused${i}` }, globalDbPath())).toHaveLength(1)
    const shas = embedShas(files)
    expect(shas).toHaveLength(FILES)
    expect(shas.every((s) => s === null)).toBe(true)
  })

  it('does not try again while the failure holds: a later drain indexes without a request or a log line', async () => {
    recordDownloadFailure(`https://${MODEL_DOWNLOAD_HOST}/x`, 'fetch failed (connect ECONNREFUSED 127.0.0.1:9)')
    const files = project('dlHeld', 3)
    appendDirtyQueuePaths(dataDir(), files)

    expect(drainOnce(dataDir())).toBe(3)
    await pendingEmbeddings()

    expect(modelFetches).toEqual([])
    expect(errorLogLines()).toEqual([])
    expect(querySymbols({ name: 'dlHeld1' }, globalDbPath())).toHaveLength(1)
    expect(embedShas(files).every((s) => s === null)).toBe(true)

    // The same files again, parsed already and still unembedded: nothing can be done for them while the hold lasts, so the drain reports none indexed rather than counting an embed that will not run.
    appendDirtyQueuePaths(dataDir(), files)
    expect(drainOnce(dataDir())).toBe(0)
    await pendingEmbeddings()
    expect(modelFetches).toEqual([])
  })
})

describe('index with the model download held', () => {
  it('indexes symbols and skips the embed step, leaving embed_sha unset for the worker to fill later', async () => {
    recordDownloadFailure(`https://${MODEL_DOWNLOAD_HOST}/x`, 'fetch failed (connect ECONNREFUSED 127.0.0.1:9)')
    const files = project('idxHeld', 3)

    await cmdIndex(path.dirname(files[0] as string), { walk: true })

    expect(modelFetches).toEqual([])
    expect(querySymbols({ name: 'idxHeld2' }, globalDbPath())).toHaveLength(1)
    expect(embedShas(files).every((s) => s === null)).toBe(true)
  })
})
