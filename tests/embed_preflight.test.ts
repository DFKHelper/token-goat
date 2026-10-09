/** `semantic --preflight`, the MCP readiness check and parallel search report why semantic search cannot run. checkEmbeddingPreflight answers from configuration and the files on disk and cannot see a download that failed in another process, so with the network blocked it said "0 of N files have embeddings, run `token-goat index`" (the user had indexed; running it again changed nothing) or, after a `--warm`, "load_error ... Check model integrity" (there was no model to check). explainModelDownload (src/embed_preflight.ts) reads the recorded failure and rewrites those results; these tests pin every branch of that rewrite, the advice it gives, and the hold the worker and `index` consult before each embed. PROVENANCE: HAND-DERIVED throughout. The base results are built field by field from the EmbeddingPreflightResult interface in src/embed_model.ts, and the expected statuses and wording follow from the branch conditions, not from running the rewrite. The failure message "fetch failed (connect ECONNREFUSED 127.0.0.1:9)" is the describeCause output tests/model_download_gate.test.ts derives from a CAPTURE on node v24.12.0. The Node version floors for NODE_USE_ENV_PROXY are FORMAT-DERIVED from the v22.21.0 release notes and nodejs/node#57165 (see tests/worker_spawn_proxy_env.test.ts). Model file sizes are the pinned MODEL_FILES entries in src/embed_model.ts (711396 and 34014426 bytes). */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { _resetDataDirCacheForTesting } from '../src/constants.js'
import { checkSemanticReadiness, downloadAdvice, explainModelDownload, foregroundDownloadDeferred, modelDownloadHeld, runtimeDownloadAdvice, WARM_COMMAND } from '../src/embed_preflight.js'
import { modelDir, type EmbeddingPreflightResult } from '../src/embed_model.js'
import type * as EmbedRuntime from '../src/embed_runtime.js'
import { NATIVE_RUNTIME_INSTALL, ORT_WEB_WASM, wasmDir, type RuntimeName } from '../src/embed_runtime.js'
import { MODEL_DOWNLOAD_HOST, RUNTIME_DOWNLOAD_HOST, downloadHoldMs, recordDownloadFailure, withExplicitDownload } from '../src/model_download_gate.js'
import { clearModuleCaches } from '../src/reset.js'

const ENV_KEYS = ['LOCALAPPDATA', 'XDG_DATA_HOME', 'TOKEN_GOAT_OFFLINE', 'TOKEN_GOAT_MODEL_CACHE_DIR', 'TOKEN_GOAT_EMBEDDINGS_ENABLED'] as const
const MODEL_URL = `https://${MODEL_DOWNLOAD_HOST}/Xenova/bge-small-en-v1.5/resolve/x/tokenizer.json`
const CAUSE = 'fetch failed (connect ECONNREFUSED 127.0.0.1:9)'
const MINUTE = 60 * 1000
const RUNTIME_URL = `https://${RUNTIME_DOWNLOAD_HOST}/onnxruntime-web/-/onnxruntime-web-1.30.0.tgz`

/** Which runtime the code under test believes is active. onnxruntime-node resolves in a dev checkout and on CI, so without this every case would run against the native runtime and none could reach the WebAssembly branch. The default keeps the model-only cases on the native runtime, where nothing else is downloaded. */
let runtimeName: RuntimeName = 'onnxruntime-node'
vi.mock('../src/embed_runtime.js', async (importOriginal) => ({ ...(await importOriginal<typeof EmbedRuntime>()), activeRuntime: () => runtimeName }))

let tmp: string
let saved: Record<string, string | undefined>

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-embed-preflight-'))
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  process.env['LOCALAPPDATA'] = tmp
  process.env['XDG_DATA_HOME'] = tmp
  delete process.env['TOKEN_GOAT_OFFLINE']
  // The machine's shared cache holds the real model; every case here is about a machine that does not.
  delete process.env['TOKEN_GOAT_MODEL_CACHE_DIR']
  // tests/setup/isolate-home.ts turns embeddings off for the suite, and a disabled result is never rewritten; the shipped default is on.
  delete process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  runtimeName = 'onnxruntime-node'
  _resetDataDirCacheForTesting()
  clearModuleCaches()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  _resetDataDirCacheForTesting()
  clearModuleCaches()
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** The runtime binary at its pinned size, which is all wasmBinaryPresent checks. */
function placeWasm(): void {
  const file = path.join(wasmDir(), ORT_WEB_WASM.name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '')
  fs.truncateSync(file, ORT_WEB_WASM.bytes)
}

/** Files of the pinned sizes, which is all modelFilesPresent checks. */
function placeModelFiles(): void {
  const dir = modelDir()
  for (const [name, bytes] of [['tokenizer.json', 711396], ['onnx/model_quantized.onnx', 34014426]] as const) {
    const file = path.join(dir, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '')
    fs.truncateSync(file, bytes)
  }
}

function base(status: EmbeddingPreflightResult['status'], extra: Partial<EmbeddingPreflightResult> = {}): EmbeddingPreflightResult {
  return {
    status,
    available: status === 'ready',
    message: `original ${status}`,
    summary: `original ${status}`,
    modelName: 'Xenova/bge-small-en-v1.5',
    runtime: 'onnxruntime-web',
    runtimeVersion: '1.0.0',
    runtimeAvailable: true,
    runtimeBinaryPresent: true,
    configEnabled: true,
    modelFilesPresent: false,
    modelWarmed: false,
    modelDir: modelDir(),
    indexedFiles: 5,
    embeddedFiles: 0,
    coveragePercent: 0,
    ...(status === 'ready' ? {} : { suggestion: 'original suggestion', actionRequired: 'original suggestion' }),
    ...extra,
  }
}

describe('explainModelDownload', () => {
  it('turns "no embeddings, run index" into "downloading by itself, nothing to do" when no download has failed', () => {
    const out = explainModelDownload(base('no_embeddings'))
    expect(out.status).toBe('missing_model_files')
    expect(out.available).toBe(false)
    expect(out.message).toContain('not downloaded yet')
    expect(out.message).toContain("this project's 5 indexed files")
    expect(out.message).not.toMatch(/token-goat index/)
    expect(out.suggestion).toBe(`Nothing to do. To download it now instead, run \`${WARM_COMMAND}\`.`)
    expect(out.actionRequired).toBe(out.suggestion)
    expect(out.summary).toBe(out.message)
    expect(out.error).toBeUndefined()
  })

  it('keeps "ready" ready and says the model comes on first use', () => {
    const out = explainModelDownload(base('ready'))
    expect(out.status).toBe('ready')
    expect(out.available).toBe(true)
    expect(out.message).toMatch(/fetched on first use/)
    expect(out.suggestion).toBeUndefined()
  })

  it('leaves a load_error alone when no download failure explains it', () => {
    const input = base('load_error', { error: 'bad weights' })
    expect(explainModelDownload(input)).toBe(input)
  })

  it.each(['no_embeddings', 'ready', 'load_error'] as const)('reports a held download for %s, with when it retries and what to do', (status) => {
    const now = Date.now()
    recordDownloadFailure(MODEL_URL, CAUSE, now - MINUTE)
    const out = explainModelDownload(base(status), now)
    expect(out.status).toBe('missing_model_files')
    expect(out.available).toBe(false)
    expect(out.message).toContain(`failed: ${CAUSE}.`)
    expect(out.message).toContain(new Date(now - MINUTE).toISOString())
    expect(out.message).toContain(`tried again automatically after ${new Date(now - MINUTE + downloadHoldMs(1)).toISOString()}`)
    expect(out.error).toBe(out.message)
    expect(out.suggestion).toContain(WARM_COMMAND)
    expect(out.suggestion).toContain(modelDir())
    expect(out.message).not.toMatch(/model integrity|token-goat index/)
  })

  it('says the next embed retries once the hold has run out', () => {
    const now = Date.now()
    recordDownloadFailure(MODEL_URL, CAUSE, now - downloadHoldMs(1) - MINUTE)
    const out = explainModelDownload(base('no_embeddings'), now)
    expect(out.status).toBe('missing_model_files')
    expect(out.message).toContain('the next time a file is embedded')
  })

  it('changes nothing once the model files are on disk, failure record or not', () => {
    recordDownloadFailure(MODEL_URL, CAUSE)
    placeModelFiles()
    for (const status of ['no_embeddings', 'ready', 'load_error'] as const) {
      const input = base(status)
      expect(explainModelDownload(input)).toBe(input)
    }
  })

  it('marks the files present after a warm, which fetched them after the snapshot was taken', () => {
    recordDownloadFailure(MODEL_URL, CAUSE)
    const out = explainModelDownload(base('ready', { modelWarmed: true }))
    expect(out.status).toBe('ready')
    expect(out.modelFilesPresent).toBe(true)
  })

  it.each(['disabled', 'missing_runtime', 'missing_model_files'] as const)('passes %s through untouched', (status) => {
    recordDownloadFailure(MODEL_URL, CAUSE)
    const input = base(status)
    expect(explainModelDownload(input)).toBe(input)
  })
})

describe('downloadAdvice', () => {
  const tail = (): string => `, or copy the model files into ${modelDir()}. Then run \`${WARM_COMMAND}\` to download it now.`

  it('tells an old Node to upgrade, since the flag does nothing there', () => {
    expect(downloadAdvice({ HTTPS_PROXY: 'http://p:1' }, '22.16.0')).toBe(`This machine sets a proxy, but Node 22.16.0 cannot send fetch through it: upgrade to Node 22.21+ or 24+${tail()}`)
  })

  // With the flag unset the download that failed went through the proxy all the same: the worker is started with the flag, and `--warm` and `doctor --repair` run themselves again with it (env_proxy.ts). So "set NODE_USE_ENV_PROXY=1" would send the user to a setting already in effect; what they can change is the proxy, or going around it, and the second is only findable if something names it.
  it('points at the proxy, and names the way around it, whether or not the flag is set', () => {
    const expected = `Check that the proxy in HTTPS_PROXY lets huggingface.co and registry.npmjs.org through. If this machine reaches them without it, set NODE_USE_ENV_PROXY=0 and token-goat's downloads go around the proxy${tail()}`
    expect(downloadAdvice({ https_proxy: 'http://p:1' }, '24.12.0')).toBe(expected)
    expect(downloadAdvice({ HTTPS_PROXY: 'http://p:1', NODE_USE_ENV_PROXY: '1' }, '24.12.0')).toBe(expected)
  })

  it('says the opt-out is what sent the download around the proxy when it is set', () => {
    expect(downloadAdvice({ HTTPS_PROXY: 'http://p:1', NODE_USE_ENV_PROXY: '0' }, '24.12.0')).toBe(
      `NODE_USE_ENV_PROXY=0 sends token-goat's downloads around the proxy in HTTPS_PROXY. If this machine reaches the internet only through that proxy, remove it${tail()}`,
    )
  })

  it('names HTTPS_PROXY alone when no proxy is set, since token-goat adds the flag itself', () => {
    expect(downloadAdvice({}, '24.12.0')).toBe(`If this machine reaches the internet through a proxy, set HTTPS_PROXY to it${tail()}`)
  })

  it('adds the Node floor when no proxy is set on a Node that could not use one', () => {
    expect(downloadAdvice({}, '22.16.0')).toBe(`If this machine reaches the internet through a proxy, set HTTPS_PROXY to it and upgrade to Node 22.21+ or 24+, the first versions that can use it${tail()}`)
  })
})

describe('modelDownloadHeld', () => {
  it('is false with no record and no offline mode', () => {
    expect(modelDownloadHeld()).toBe(false)
  })

  it('is true while a recorded failure holds, and false after', () => {
    const now = Date.now()
    recordDownloadFailure(MODEL_URL, CAUSE, now)
    expect(modelDownloadHeld(now + MINUTE)).toBe(true)
    expect(modelDownloadHeld(now + downloadHoldMs(1) + 1)).toBe(false)
  })

  it('is true offline', () => {
    process.env['TOKEN_GOAT_OFFLINE'] = '1'
    clearModuleCaches()
    expect(modelDownloadHeld()).toBe(true)
  })

  it('is false when the files are here, whatever else says', () => {
    process.env['TOKEN_GOAT_OFFLINE'] = '1'
    clearModuleCaches()
    recordDownloadFailure(MODEL_URL, CAUSE)
    placeModelFiles()
    expect(modelDownloadHeld()).toBe(false)
  })
})

describe('checkSemanticReadiness', () => {
  it('reports the recorded failure instead of "run token-goat index" for an indexed project with no vectors', async () => {
    const plain = await checkSemanticReadiness({ coverage: { indexedFiles: 5, embeddedFiles: 0 } })
    expect(plain.status).toBe('missing_model_files')
    expect(plain.suggestion).toMatch(/^Nothing to do\./)

    recordDownloadFailure(MODEL_URL, CAUSE)
    const held = await checkSemanticReadiness({ coverage: { indexedFiles: 5, embeddedFiles: 0 } })
    expect(held.status).toBe('missing_model_files')
    expect(held.message).toContain(CAUSE)
    expect(held.message).not.toMatch(/token-goat index/)
  })
})

/** The WebAssembly runtime is a second download: once the model is in place, an embed on a machine without the native runtime still waits on the onnxruntime-web tarball from registry.npmjs.org. Checking only huggingface.co's hold let the worker retry that tarball on every file, and let the preflight say "ready" while every embed was failing. */
describe('the WebAssembly runtime download', () => {
  beforeEach(() => {
    runtimeName = 'onnxruntime-web'
    placeModelFiles()
  })

  it('holds the worker while the runtime host has a recent failure and the binary is missing', () => {
    const now = Date.now()
    recordDownloadFailure(RUNTIME_URL, CAUSE, now)
    expect(modelDownloadHeld(now + MINUTE)).toBe(true)
    expect(modelDownloadHeld(now + downloadHoldMs(1) + 1)).toBe(false)
  })

  it('does not hold on the runtime host once the binary is here', () => {
    const now = Date.now()
    recordDownloadFailure(RUNTIME_URL, CAUSE, now)
    placeWasm()
    expect(modelDownloadHeld(now + MINUTE)).toBe(false)
  })

  it('does not hold on the runtime host under the native runtime, which downloads nothing', () => {
    runtimeName = 'onnxruntime-node'
    const now = Date.now()
    recordDownloadFailure(RUNTIME_URL, CAUSE, now)
    expect(modelDownloadHeld(now + MINUTE)).toBe(false)
  })

  it('reports the runtime failure as missing_runtime, with the model marked present', () => {
    const now = Date.now()
    recordDownloadFailure(RUNTIME_URL, CAUSE, now)
    const out = explainModelDownload(base('ready', { modelFilesPresent: true }), now + MINUTE)
    expect(out.status).toBe('missing_runtime')
    expect(out.available).toBe(false)
    expect(out.modelFilesPresent).toBe(true)
    expect(out.message).toContain('onnxruntime-web, from registry.npmjs.org')
    expect(out.message).toContain(CAUSE)
    expect(out.suggestion).toBe(runtimeDownloadAdvice())
  })

  it('leaves the result alone when only the binary is missing and nothing has failed, since it comes on first use', () => {
    const input = base('ready', { modelFilesPresent: true })
    expect(explainModelDownload(input)).toBe(input)
  })

  it('reports the newer of two failures when both downloads are pending', () => {
    fs.rmSync(modelDir(), { recursive: true, force: true })
    const now = Date.now()
    recordDownloadFailure(MODEL_URL, 'model host down', now - 2 * MINUTE)
    recordDownloadFailure(RUNTIME_URL, CAUSE, now - MINUTE)
    const out = explainModelDownload(base('no_embeddings'), now)
    expect(out.status).toBe('missing_runtime')
    expect(out.modelFilesPresent).toBe(false)
    expect(out.message).toContain(CAUSE)
  })
})

describe('runtimeDownloadAdvice', () => {
  it('offers the native runtime rather than copying model files, which does nothing for the runtime', () => {
    const advice = runtimeDownloadAdvice({}, '24.12.0')
    expect(advice).toContain(NATIVE_RUNTIME_INSTALL)
    expect(advice).not.toContain('copy the model files')
    expect(advice).toContain(WARM_COMMAND)
  })
})

/** A foreground command reads NODE_USE_ENV_PROXY only at startup, so on a proxy machine without it, its automatic download goes around the proxy, fails, and records a hold that then stops the worker too, whose downloads go through. foregroundDownloadDeferred leaves such a download to the worker instead. HAND-DERIVED from the three conditions it adds to modelDownloadHeld; the version floors are those in tests/worker_spawn_proxy_env.test.ts. */
describe('foregroundDownloadDeferred', () => {
  const proxy = { HTTPS_PROXY: 'http://127.0.0.1:9' }

  it('defers when a proxy is set without the flag and the model is missing', () => {
    expect(foregroundDownloadDeferred(Date.now(), proxy, '24.12.0')).toBe(true)
  })

  it('does not defer a download the user asked for by name, which re-runs itself with the flag instead', () => {
    expect(withExplicitDownload(() => foregroundDownloadDeferred(Date.now(), proxy, '24.12.0'))).toBe(false)
  })

  it('does not defer once the model is on disk, since nothing is left to download', () => {
    placeModelFiles()
    expect(foregroundDownloadDeferred(Date.now(), proxy, '24.12.0')).toBe(false)
  })

  it('does not defer when this process already has the flag, or there is no proxy', () => {
    expect(foregroundDownloadDeferred(Date.now(), { ...proxy, NODE_USE_ENV_PROXY: '1' }, '24.12.0')).toBe(false)
    expect(foregroundDownloadDeferred(Date.now(), {}, '24.12.0')).toBe(false)
  })

  it('does not defer on a Node that cannot use the flag, where the worker is no better off', () => {
    expect(foregroundDownloadDeferred(Date.now(), proxy, '22.20.0')).toBe(false)
  })

  it('still defers under a recorded hold, with no proxy at all', () => {
    const now = Date.now()
    recordDownloadFailure(MODEL_URL, CAUSE, now - MINUTE)
    expect(foregroundDownloadDeferred(now, {}, '24.12.0')).toBe(true)
  })

  it('records no hold of its own, so the worker is left free to download', () => {
    foregroundDownloadDeferred(Date.now(), proxy, '24.12.0')
    expect(modelDownloadHeld()).toBe(false)
  })
})
