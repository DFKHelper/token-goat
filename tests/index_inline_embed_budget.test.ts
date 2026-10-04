/** `token-goat index` on a real repository: once the foreground embeds have used their time budget, the files still waiting are parsed but left for the background worker, which is started, and the user is told how to wait for them instead. Embedding on the bundled WebAssembly runtime runs at about ten chunks a second, so before this a repository of a few thousand files kept `index` running for hours, and the release smoke test that runs `index .` on this repository never finished. Provenance: HAND-DERIVED. The embedder is replaced by one that takes a fixed time per file, so the expected split is computed from that time and the budget, not read off the command's output. */

import fs from 'node:fs'
import path from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { invalidateConfigCache } from '../src/config.js'
import { canonicalize } from '../src/project.js'
import { indexableDir } from './helpers/temp-config.js'

import type * as ParserModule from '../src/parser.js'
import type * as WorkerLifecycleModule from '../src/worker_lifecycle.js'

const EMBED_MS = 25
const ensureWorkerAlive = vi.fn(() => true)
const indexFileEmbeddings = vi.fn(async () => {
  await new Promise((resolve) => setTimeout(resolve, EMBED_MS))
})

vi.mock('../src/parser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ParserModule>()
  return { ...actual, indexFileEmbeddings }
})

vi.mock('../src/worker_lifecycle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkerLifecycleModule>()
  return { ...actual, ensureWorkerAlive }
})

const { cmdIndex } = await import('../src/cli.js')
const { embeddingsDepsAvailable } = await import('../src/embeddings.js')
const { getDb } = await import('../src/db.js')
const { globalDbPath } = await import('../src/constants.js')

const SOURCE_FILES = 5
// The package.json marker is indexed and embedded too.
const FILE_COUNT = SOURCE_FILES + 1
const SAVED = ['TOKEN_GOAT_EMBEDDINGS_ENABLED', 'TOKEN_GOAT_OFFLINE', 'HTTPS_PROXY'] as const
const prev: Partial<Record<(typeof SAVED)[number], string | undefined>> = {}
let tmp = ''

beforeAll(() => {
  for (const k of SAVED) prev[k] = process.env[k]
  process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
  delete process.env['TOKEN_GOAT_OFFLINE']
  delete process.env['HTTPS_PROXY']
  invalidateConfigCache()
})

afterAll(() => {
  for (const k of SAVED) {
    if (prev[k] === undefined) delete process.env[k]
    else process.env[k] = prev[k]
  }
  invalidateConfigCache()
})

/** A fresh non-git project of FILE_COUNT indexable files, so every run starts with nothing indexed. It sits outside the OS temp dir: the worker never embeds a file there, so `index` embeds a project under it in full whatever the budget (tests/index_temp_project_embeds_inline.test.ts). */
function freshProject(): string {
  const dir = canonicalize(fs.realpathSync.native(indexableDir()))
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"embed-budget-fixture"}\n')
  for (let i = 0; i < SOURCE_FILES; i += 1) fs.writeFileSync(path.join(dir, `mod${i}.ts`), `export function handler${i}(n: number): number {\n  return n + ${i}\n}\n`)
  return dir
}

async function runIndex(opts: { embed?: boolean; embedBudgetMs?: number }): Promise<{ stdout: string; stderr: string }> {
  const outChunks: string[] = []
  const errChunks: string[] = []
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    outChunks.push(String(chunk))
    return true
  })
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    errChunks.push(String(chunk))
    return true
  })
  const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
    errChunks.push(a.map(String).join(' '))
  })
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    outChunks.push(a.map(String).join(' '))
  })
  try {
    await cmdIndex(tmp, { walk: true, ...opts })
  } finally {
    out.mockRestore()
    err.mockRestore()
    warn.mockRestore()
    log.mockRestore()
  }
  return { stdout: outChunks.join(''), stderr: errChunks.join('') }
}

describe('index spends a bounded time embedding in the foreground', () => {
  beforeEach(() => {
    ensureWorkerAlive.mockClear()
    indexFileEmbeddings.mockClear()
    tmp = freshProject()
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('has the embedding dependencies this test needs', () => {
    // Without them every file takes the terminal-marker path and the budget never applies, which would make the tests below pass for the wrong reason.
    expect(embeddingsDepsAvailable(getDb(globalDbPath()))).toBe(true)
  })

  it('parses every file, embeds until the budget is spent, and leaves the rest to the worker', async () => {
    // First embed is free (it loads the model), the second spends one EMBED_MS, the third crosses 40 ms; a late timer can make the second cross it.
    const { stdout, stderr } = await runIndex({ embedBudgetMs: 40 })
    expect(stdout).toContain(`Indexed ${FILE_COUNT} files into the symbol index.`)
    const embedded = indexFileEmbeddings.mock.calls.length
    expect(embedded).toBeGreaterThanOrEqual(2)
    expect(embedded).toBeLessThanOrEqual(3)
    expect(ensureWorkerAlive).toHaveBeenCalled()
    expect(stderr).toContain(`${FILE_COUNT - embedded} files left for the background worker to embed`)
    expect(stderr).toContain('token-goat index --embed')
  })

  it('does not count the first embed, which carries the model load, against the budget', async () => {
    await runIndex({ embedBudgetMs: 0 })
    // A zero budget still embeds one file: the first embed is what tells a slow model load apart from a large repository.
    expect(indexFileEmbeddings).toHaveBeenCalledTimes(1)
    expect(ensureWorkerAlive).toHaveBeenCalled()
  })

  it('embeds every file here with --embed and starts no worker', async () => {
    const { stderr } = await runIndex({ embed: true, embedBudgetMs: 0 })
    expect(indexFileEmbeddings).toHaveBeenCalledTimes(FILE_COUNT)
    expect(ensureWorkerAlive).not.toHaveBeenCalled()
    expect(stderr).not.toContain('left for the background worker')
  })

  it('embeds a small project in full under the default budget', async () => {
    const { stderr } = await runIndex({})
    expect(indexFileEmbeddings).toHaveBeenCalledTimes(FILE_COUNT)
    expect(ensureWorkerAlive).not.toHaveBeenCalled()
    expect(stderr).not.toContain('left for the background worker')
  })
})
