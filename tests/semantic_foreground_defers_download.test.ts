/** A foreground `semantic` on a machine that names a proxy in HTTPS_PROXY but not NODE_USE_ENV_PROXY, with the model not downloaded yet. Node reads that flag once at startup, so this process's fetch would connect directly, fail, and record a hold that then stops the worker too, whose downloads do go through the proxy (worker_lifecycle.ts starts it with the flag). So the dense half is skipped, the worker is started to do the download, and the user is told why and how to download now. Driven through the real foregroundDownloadDeferred and modelDownloadHeld, with only the proxy variables, the model cache and the two side-effecting calls (the dense search itself, the worker spawn) replaced, so the decision under test is the production one. Provenance: HAND-DERIVED. The inputs (a proxy set, the flag unset, no model files, no failure record) are the conditions foregroundDownloadDeferred documents, and the expected outcome is the behaviour that function's doc comment names; nothing here was read off the code's output. */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { invalidateConfigCache } from '../src/config.js'
import { modelDir } from '../src/embed_model.js'
import { nodeFetchHonoursEnvProxy } from '../src/env_proxy.js'
import { canonicalize } from '../src/project.js'
import { indexableDir } from './helpers/temp-config.js'

import type * as EmbeddingsModule from '../src/embeddings.js'
import type * as ParserModule from '../src/parser.js'
import type * as WorkerLifecycleModule from '../src/worker_lifecycle.js'

const searchSemantic = vi.fn(async () => [])
const ensureWorkerAlive = vi.fn(() => true)
const indexFileEmbeddings = vi.fn(async () => undefined)

vi.mock('../src/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof EmbeddingsModule>()
  // The real one would start the download this test is about; a call at all is the failure.
  return { ...actual, searchSemantic }
})

vi.mock('../src/parser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ParserModule>()
  // Same reason as searchSemantic: `index` embeds through this, and the embed is what would download.
  return { ...actual, indexFileEmbeddings }
})

vi.mock('../src/worker_lifecycle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkerLifecycleModule>()
  return { ...actual, ensureWorkerAlive }
})

const { run } = await import('../src/cli.js')
const { WARM_COMMAND } = await import('../src/embed_preflight.js')
const { downloadFailureRecordPath } = await import('../src/model_download_gate.js')

const TMP = canonicalize(fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-semdefer-'))))
// The worker never embeds a file under the OS temp dir, so `index` hands a deferred embed to it only for a project outside it (tests/index_temp_project_embeds_inline.test.ts).
const INDEXABLE = canonicalize(fs.realpathSync.native(indexableDir()))
const SAVED = ['TOKEN_GOAT_EMBEDDINGS_ENABLED', 'TOKEN_GOAT_MODEL_CACHE_DIR', 'HTTPS_PROXY', 'NODE_USE_ENV_PROXY'] as const
const prev: Partial<Record<(typeof SAVED)[number], string | undefined>> = {}

beforeAll(() => {
  for (const k of SAVED) prev[k] = process.env[k]
  process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
  // The shared cache CI keeps warm would make the model present, which is the one state this test must not be in.
  delete process.env['TOKEN_GOAT_MODEL_CACHE_DIR']
  // A port nothing listens on: nothing here should connect, and if something does it fails at once rather than reaching the internet.
  process.env['HTTPS_PROXY'] = 'http://127.0.0.1:9'
  delete process.env['NODE_USE_ENV_PROXY']
  for (const dir of [TMP, INDEXABLE]) fs.writeFileSync(path.join(dir, 'auth.ts'),'export function refreshCredential(id: string): string {\n  return id\n}\n')
})

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
  for (const k of SAVED) {
    if (prev[k] === undefined) delete process.env[k]
    else process.env[k] = prev[k]
  }
})

/** Run the CLI from inside a fixture directory (the temp-dir one unless told otherwise), collecting what it prints. */
async function runCli(args: string[], dir: string = TMP): Promise<{ warnings: string[]; stderr: string }> {
  const warnings: string[] = []
  const errChunks: string[] = []
  const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
    warnings.push(a.map(String).join(' '))
  })
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    errChunks.push(String(chunk))
    return true
  })
  const exitCode = process.exitCode
  const cwd = process.cwd()
  process.chdir(dir)
  try {
    await run(['node', 'token-goat', ...args])
  } finally {
    process.chdir(cwd)
    warn.mockRestore()
    out.mockRestore()
    err.mockRestore()
    process.exitCode = exitCode
  }
  return { warnings, stderr: errChunks.join('') }
}

describe.skipIf(!nodeFetchHonoursEnvProxy())('semantic with a proxy the process cannot use and no model yet', () => {
  beforeEach(() => {
    searchSemantic.mockClear()
    ensureWorkerAlive.mockClear()
    indexFileEmbeddings.mockClear()
  })

  it('semantic leaves the download to the worker instead of trying it here', async () => {
    const { warnings } = await runCli(['semantic', 'refresh a credential'])
    expect(searchSemantic).not.toHaveBeenCalled()
    expect(ensureWorkerAlive).toHaveBeenCalled()
    const notice = warnings.find((w) => w.includes('background worker downloads it'))
    expect(notice, warnings.join('\n')).toBeDefined()
    expect(notice).toContain(WARM_COMMAND)
    // Deferring is not failing: a hold recorded here would stop the worker's download too.
    expect(fs.existsSync(downloadFailureRecordPath())).toBe(false)
  })

  it('index parses every file, embeds none of them here, and hands the embedding to the worker', async () => {
    const { stderr } = await runCli(['index', '--walk'], INDEXABLE)
    expect(indexFileEmbeddings).not.toHaveBeenCalled()
    expect(ensureWorkerAlive).toHaveBeenCalled()
    expect(stderr).toContain('1 file not embedded yet')
    expect(stderr).toContain(WARM_COMMAND)
    expect(fs.existsSync(downloadFailureRecordPath())).toBe(false)
  })
})

// HAND-DERIVED: TOKEN_GOAT_OFFLINE=1 is the documented env spelling of network.offline (README and capabilities.ts name it); the wording asserted is the contract the task states: name the variable, name the model directory, say the offline-safe commands work, and never promise a background download that offline mode forbids.
describe('index with the model missing and offline mode on', () => {
  beforeEach(() => {
    ensureWorkerAlive.mockClear()
    indexFileEmbeddings.mockClear()
    process.env['TOKEN_GOAT_OFFLINE'] = '1'
    invalidateConfigCache()
  })
  afterEach(() => {
    delete process.env['TOKEN_GOAT_OFFLINE']
    invalidateConfigCache()
  })

  it('names the offline setting and the model directory instead of promising a download', async () => {
    const { stderr } = await runCli(['index', '--walk'])
    expect(indexFileEmbeddings).not.toHaveBeenCalled()
    expect(stderr).toContain('1 file not embedded')
    expect(stderr).toContain('TOKEN_GOAT_OFFLINE')
    expect(stderr).toContain(modelDir())
    expect(stderr).toMatch(/symbol, read, outline and section/)
    expect(stderr).not.toContain('The background worker downloads it')
    expect(stderr).not.toContain(WARM_COMMAND)
  })
})
