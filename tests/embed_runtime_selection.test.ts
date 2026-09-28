/** Which ONNX Runtime build embeds, and which stamp its vectors carry. embed_runtime.ts takes the native binding whenever `onnxruntime-node` resolves and loads, and otherwise the bundled WebAssembly build; backendId() in embeddings.ts then names whichever one loaded, at its own major.minor, in the vector-space half of the provenance stamp. The two builds must never share a stamp: a vector space is only as comparable as the runtime that computed it, and the builds were measured bit-identical on one platform only. The repository installs onnxruntime-node as a devDependency, so the native case runs against the real package. The WebAssembly case needs a machine where it does not resolve, which this repository never is, so `node:module`'s createRequire is wrapped to answer for `onnxruntime-node` the way Node does when a package is absent, or present with a binary that will not load. Every other specifier reaches the real require untouched, and the runtime's own choice, version lookup and the stamp are all the shipping code. HAND-DERIVED: the absent-package error carries `code: 'MODULE_NOT_FOUND'`, which is what Node's CJS loader sets (https://nodejs.org/api/errors.html#module_not_found), and the unloadable-binary one `code: 'ERR_DLOPEN_FAILED'` (https://nodejs.org/api/errors.html#err_dlopen_failed); the expected stamp segments are computed from the installed package.json and ORT_WEB_VERSION, not read back from backendId(). */
import * as fs from 'node:fs'
import type * as NodeModule from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { _resetDataDirCacheForTesting } from '../src/constants.js'
import { closeAllDbs } from '../src/db.js'
import { checkEmbeddingPreflight } from '../src/embed_model.js'
import { ORT_WEB_VERSION, ORT_WEB_WASM, activeRuntime, isRuntimeAvailable, nativeRuntimeLoadError, runtimeVersion, wasmDir } from '../src/embed_runtime.js'
import { embeddingProvenance } from '../src/embeddings.js'
import { runSemantic } from '../src/read_semantic.js'
import { clearModuleCaches } from '../src/reset.js'

import { ROOT } from './helpers/bundle.js'

/** What `require('onnxruntime-node')` does in the process under test: load normally, or fail the way Node fails. */
let nativeFailure: 'none' | 'absent' | 'unloadable' = 'none'

function failure(id: string): Error | null {
  if (id !== 'onnxruntime-node' || nativeFailure === 'none') return null
  if (nativeFailure === 'absent') return Object.assign(new Error(`Cannot find module '${id}'`), { code: 'MODULE_NOT_FOUND' })
  return Object.assign(new Error('The specified module could not be found.\r\n\\\\?\\onnxruntime_binding.node'), { code: 'ERR_DLOPEN_FAILED' })
}

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeModule>()
  const createRequire = (from: string | URL): NodeJS.Require => {
    const real = actual.createRequire(from)
    const gated = ((id: string) => {
      const err = failure(id)
      if (err) throw err
      return real(id) as unknown
    }) as NodeJS.Require
    gated.resolve = ((id: string, options?: { paths?: string[] }) => {
      // An installed package whose binary will not load still resolves; only an absent one does not.
      if (id === 'onnxruntime-node' && nativeFailure === 'absent') throw failure(id)
      return real.resolve(id, options)
    }) as NodeJS.RequireResolve
    gated.resolve.paths = real.resolve.paths
    gated.cache = real.cache
    gated.main = real.main
    gated.extensions = real.extensions
    return gated
  }
  return { ...actual, createRequire, default: { ...actual, createRequire } }
})

/** The major.minor of the onnxruntime-node this repository installed, read independently of embed_runtime.ts. */
function installedNativeMajorMinor(): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'onnxruntime-node', 'package.json'), 'utf8')) as { version: string }
  return manifest.version.split('.').slice(0, 2).join('.')
}

const WEB_STAMP = `/onnxruntime-web@${ORT_WEB_VERSION.split('.').slice(0, 2).join('.')}/`

afterEach(() => {
  nativeFailure = 'none'
  clearModuleCaches()
})

describe('runtime selection', () => {
  it('takes the native binding when it resolves, and stamps vectors with its own name and version', () => {
    clearModuleCaches()
    expect(activeRuntime()).toBe('onnxruntime-node')
    expect(nativeRuntimeLoadError()).toBeNull()
    expect(isRuntimeAvailable()).toBe(true)
    expect(embeddingProvenance()).toContain(`/onnxruntime-node@${installedNativeMajorMinor()}/`)
    expect(embeddingProvenance()).not.toContain('onnxruntime-web')
  })

  it('falls back to the bundled WebAssembly build when the native binding is not installed', () => {
    nativeFailure = 'absent'
    clearModuleCaches()
    expect(activeRuntime()).toBe('onnxruntime-web')
    expect((nativeRuntimeLoadError() as NodeJS.ErrnoException | null)?.code).toBe('MODULE_NOT_FOUND')
    // Available before anything is downloaded: the binary is fetched on first use, not a precondition.
    expect(isRuntimeAvailable()).toBe(true)
    expect(runtimeVersion()).toBe(ORT_WEB_VERSION)
    expect(embeddingProvenance()).toContain(WEB_STAMP)
    expect(embeddingProvenance()).not.toContain('onnxruntime-node')
  })

  it('falls back to the WebAssembly build when the native binding is installed but will not load, and keeps the reason', () => {
    nativeFailure = 'unloadable'
    clearModuleCaches()
    expect(activeRuntime()).toBe('onnxruntime-web')
    expect((nativeRuntimeLoadError() as NodeJS.ErrnoException | null)?.code).toBe('ERR_DLOPEN_FAILED')
    expect(embeddingProvenance()).toContain(WEB_STAMP)
  })

  it('gives the two builds different vector spaces, so switching between them re-embeds rather than mixing', () => {
    clearModuleCaches()
    const native = embeddingProvenance()
    nativeFailure = 'absent'
    clearModuleCaches()
    const web = embeddingProvenance()
    expect(web).not.toBe(native)
    // Only the runtime segment differs: the model, its revision and the chunking fingerprint are the same code either way.
    const cut = (p: string): string => p.replace(/\/onnxruntime-(?:node|web)@[^/]+\//, '/<runtime>/')
    expect(cut(web)).toBe(cut(native))
  })
})

// The data root and the shared cache are replaced, not inherited: whether the binary is already on disk is what these observe, and CI exports the shared cache variable.
const ENV_KEYS = ['LOCALAPPDATA', 'XDG_DATA_HOME', 'TOKEN_GOAT_OFFLINE', 'TOKEN_GOAT_MODEL_CACHE_DIR', 'TOKEN_GOAT_EMBEDDINGS_ENABLED'] as const

describe('what the WebAssembly build reports before its binary is downloaded', () => {
  let tmp: string
  let saved: Record<string, string | undefined>

  function isolate(offline: boolean): void {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-rt-preflight-'))
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
    process.env['LOCALAPPDATA'] = tmp
    process.env['XDG_DATA_HOME'] = tmp
    delete process.env['TOKEN_GOAT_MODEL_CACHE_DIR']
    // tests/setup/isolate-home.ts turns embeddings off for the suite, and a disabled config answers preflight before the runtime is consulted.
    process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
    if (offline) process.env['TOKEN_GOAT_OFFLINE'] = '1'
    else delete process.env['TOKEN_GOAT_OFFLINE']
    nativeFailure = 'absent'
    _resetDataDirCacheForTesting()
    clearModuleCaches()
  }

  afterEach(() => {
    // runSemantic opens the isolated global.db to read coverage; Windows refuses to delete a directory holding an open database.
    closeAllDbs()
    for (const key of ENV_KEYS) {
      const value = saved[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    _resetDataDirCacheForTesting()
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
  })

  it('says the binary is fetched on first use, rather than calling the runtime missing', async () => {
    isolate(false)
    const result = await checkEmbeddingPreflight()
    expect(result.runtime).toBe('onnxruntime-web')
    expect(result.runtimeBinaryPresent).toBe(false)
    expect(result.status).not.toBe('missing_runtime')
    const text = (await runSemantic('', { preflight: true })).text
    expect(text).toContain('ONNX runtime (onnxruntime-web): available (1.30.0)')
    expect(text).toContain(`Runtime binary (${ORT_WEB_WASM.name}, ~14 MB): not downloaded yet, fetched once on first use`)
  })

  it('reports the runtime missing when offline mode forbids that first fetch, and says where to put the file', async () => {
    isolate(true)
    const result = await checkEmbeddingPreflight()
    expect(result.status).toBe('missing_runtime')
    expect(result.available).toBe(false)
    expect(result.message).toContain('network.offline')
    expect(result.suggestion).toContain(wasmDir())
    expect(result.suggestion).toContain('npm install -g onnxruntime-node')
  })
})
