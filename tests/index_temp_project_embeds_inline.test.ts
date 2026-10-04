/** `token-goat index` on a project under the OS temp dir embeds every file before it returns, because the worker it would otherwise leave them to never takes a path there: the dirty queue drops it and the backlog sweep steps over it (both through isUnderSystemTemp). Before this, past the inline embedding budget `index` printed "N files left for the background worker to embed" for such a project and the files stayed unembedded for good: dogfooded on the 2.9.30 build, 259 of 401 files in a project under %TEMP% were still unembedded minutes later with the worker running. Driven on the real default wiring, `cmdIndex` with its own parser and embedder and no injected callback; only the embedding backend is stubbed (`setPipelineFnForTesting`), as tests/index_hands_left_embeds_to_running_worker.test.ts does. Provenance: HAND-DERIVED. The fixture is six small files this test writes; which of them must be embedded follows from where the project sits and the zero budget passed in (the first embed is never charged to it), not from the command's output. */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cmdIndex } from '../src/cli.js'
import { invalidateConfigCache } from '../src/config.js'
import { globalDbPath } from '../src/constants.js'
import { closeAllDbs, getDb } from '../src/db.js'
import { WARM_COMMAND } from '../src/embed_preflight.js'
import { DEFAULT_DIM, embeddingsDepsAvailable, setPipelineFnForTesting } from '../src/embeddings.js'
import { nodeFetchHonoursEnvProxy, PROXY_VARS } from '../src/env_proxy.js'
import { getFileEntry } from '../src/index_reader.js'
import { resolveIndexPath } from '../src/paths.js'
import { isUnderSystemTemp } from '../src/project.js'
import { indexableDir, tempDir } from './helpers/temp-config.js'

const SOURCE_FILES = 5
// The package.json marker is indexed and embedded too.
const NAMES = ['package.json', ...Array.from({ length: SOURCE_FILES }, (_, i) => `mod${i}.ts`)]
// The model cache is cleared so the model reads as not downloaded, which is what lets the proxy case below defer; the stubbed backend never needs it.
const SAVED = ['TOKEN_GOAT_EMBEDDINGS_ENABLED', 'TOKEN_GOAT_OFFLINE', 'TOKEN_GOAT_MODEL_CACHE_DIR', 'NODE_USE_ENV_PROXY', ...PROXY_VARS] as const
const prev: Partial<Record<(typeof SAVED)[number], string | undefined>> = {}

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

afterEach(() => {
  setPipelineFnForTesting(null)
  for (const k of SAVED) {
    if (prev[k] === undefined) delete process.env[k]
    else process.env[k] = prev[k]
  }
  invalidateConfigCache()
  closeAllDbs()
})

/** A non-git project of NAMES under `dir`. */
function writeProject(dir: string): string {
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"temp-project-embed-fixture"}\n')
  for (let i = 0; i < SOURCE_FILES; i += 1) fs.writeFileSync(path.join(dir, `mod${i}.ts`), `export function handler${i}(n: number): number {\n  return n + ${i}\n}\n`)
  return dir
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

/** The fixture files with at least one stored chunk, which is what `semantic` reads. */
function chunked(root: string): string[] {
  const db = getDb(globalDbPath())
  return NAMES.filter((name) => {
    const row = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE file_path = ?').get(resolveIndexPath(path.join(root, name))) as { n: number }
    return row.n > 0
  })
}

describe('index on a project the worker will not embed', () => {
  it('has the embedding dependencies this test needs', () => {
    // Without them every file takes the terminal-marker path and nothing is left for the worker, which would make the tests below pass for the wrong reason.
    expect(embeddingsDepsAvailable(getDb(globalDbPath()))).toBe(true)
  })

  it('still leaves files past the budget to the worker for a project outside the temp dir', async () => {
    // Calibration: the zero budget really does hand files over where the worker takes them, so the temp-dir case below passing is the location's doing.
    const root = writeProject(indexableDir())
    expect(isUnderSystemTemp(root)).toBe(false)
    const stderr = await runIndex(root, { embedBudgetMs: 0 })
    expect(stderr).toContain(`${NAMES.length - 1} files left for the background worker to embed`)
    expect(unembedded(root)).toHaveLength(NAMES.length - 1)
  })

  it('embeds every file of a project under the temp dir before returning, whatever the budget', async () => {
    const root = writeProject(tempDir())
    expect(isUnderSystemTemp(root)).toBe(true)
    const stderr = await runIndex(root, { embedBudgetMs: 0 })
    expect(stderr).not.toContain('left for the background worker')
    expect(unembedded(root)).toEqual([])
    // The one-line package.json is stamped embedded but yields no chunk; every source file must have one.
    expect(chunked(root)).toEqual(NAMES.slice(1))
  })

  it.skipIf(!nodeFetchHonoursEnvProxy())('does not promise the worker will download and embed for a project under the temp dir', async () => {
    const root = writeProject(tempDir())
    // A proxy this process's fetch would go around, so `index` cannot download the model itself. Nothing is fetched: the backend is stubbed.
    process.env['HTTPS_PROXY'] = 'http://127.0.0.1:9'
    const stderr = await runIndex(root, {})
    expect(stderr).toContain(`${NAMES.length} files not embedded:`)
    expect(stderr).toContain('does not embed files under the system temp directory')
    expect(stderr).toContain(WARM_COMMAND)
    expect(stderr).not.toContain('The background worker downloads it')
  })
})
