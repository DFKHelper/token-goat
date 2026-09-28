/** `doctor`'s report on which inference runtime embeddings run on, and whether they can run at all. A default install embeds on the bundled WebAssembly build of ONNX Runtime, whose 14 MB binary is fetched once on first use; the native `onnxruntime-node` (about 288 MB installed) takes over whenever it resolves. `semantic` consults keyword search alongside the vectors, so when embeddings cannot run it still answers, still finds things, and never errors -- it just stops matching on meaning. A degradation that produces no error, no empty result and no warning is one nobody discovers, which is exactly what `doctor` is for. The states are genuinely different advice rather than phrasings of "unavailable": off in config is not a fault at all, either runtime running is fine but the reader should know which, a binary not yet fetched is fine unless offline mode forbids fetching it, a bundled runtime that failed to start is a warning with its reason, and a native binding that is installed but throwing is a different fault with a different fix. Asserting only `status` would pass while the advice was wrong or missing, so these assert the text a reader acts on. The native case runs against the real package, which the repository carries as a devDependency, so that happy path is not a mock of itself. The bundled cases substitute the runtime queries of `embed_runtime.js` -- a separate module, not the code under test -- because a consumer's install without the native binding is the one this repository never reaches on its own. Everything else in that module stays real, including the advice text, so a change to it is asserted here rather than restated. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Config } from '../src/config.js'
import type * as EmbedRuntime from '../src/embed_runtime.js'

/** Only `indexing.embeddings_enabled` and `network.offline` are read, so the rest of Config is irrelevant to the check. */
function configWith(enabled: boolean | undefined, offline = false): Config {
  return { indexing: { embeddings_enabled: enabled }, network: { offline } } as unknown as Config
}

interface WebState {
  /** Whether the bundled runtime is able to start, i.e. its last attempt did not fail recently. */
  available: boolean
  /** Why it could not start, when it could not. */
  loadError: Error | null
  /** Whether the runtime binary is already on disk. */
  binaryPresent: boolean
  /** Why the native binding is not the one in use. */
  nativeError: Error | null
}

/** Loads `checkEmbeddings` with `embed_runtime.js` reporting the bundled WebAssembly runtime in the given state. */
async function withWebRuntime(state: WebState) {
  vi.resetModules()
  vi.doMock('../src/embed_runtime.js', async (importOriginal) => ({
    ...(await importOriginal<typeof EmbedRuntime>()),
    activeRuntime: () => 'onnxruntime-web',
    isRuntimeAvailable: () => state.available,
    runtimeLoadError: () => state.loadError,
    nativeRuntimeLoadError: () => state.nativeError,
    wasmBinaryPresent: () => state.binaryPresent,
    runtimeVersion: () => '1.30.0',
  }))
  const mod = await import('../src/cli_doctor.js')
  return mod.checkEmbeddings
}

function notFound(code: string): Error {
  const err = new Error(`Cannot find module 'onnxruntime-node'`) as NodeJS.ErrnoException
  err.code = code
  return err
}

const RUNNING: WebState = { available: true, loadError: null, binaryPresent: true, nativeError: notFound('MODULE_NOT_FOUND') }

describe('doctor: embeddings', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.doUnmock('../src/embed_runtime.js')
  })

  it('names the native runtime and its version when the real package loads', async () => {
    // No mock: the repository keeps onnxruntime-node as a devDependency, and embed_runtime.ts prefers it whenever it resolves, through the same createRequire the shipping code uses. HAND-DERIVED from package.json devDependencies.
    const { checkEmbeddings } = await import('../src/cli_doctor.js')
    const result = checkEmbeddings(configWith(true))
    expect(result.name).toBe('Embeddings')
    expect(result.status).toBe('ok')
    expect(result.message).toMatch(/^available \(native onnxruntime-node \d+\.\d+\.\d+\)$/)
  })

  it('treats the setting being switched off as fine, not as a fault', async () => {
    const checkEmbeddings = await withWebRuntime({ ...RUNNING, available: false, loadError: new Error('offline') })
    const result = checkEmbeddings(configWith(false))
    // Even with embeddings genuinely unable to run, an explicit opt-out is not a problem to report.
    expect(result.status).toBe('ok')
    expect(result.message).toContain('disabled by config')
    // And it must not print an install command: doctor would be telling the reader to undo something they meant to do.
    expect(result.message).not.toContain('npm install')
  })

  it('treats an absent setting as enabled, matching how the rest of the code reads it', async () => {
    // src/cli.ts and src/worker.ts both spell this `?? true`. A doctor that instead read an absent flag as "disabled by config" would print a clean bill of health for a config that never mentioned the setting, which is a false all-clear rather than a cosmetic difference.
    const checkEmbeddings = await withWebRuntime({ ...RUNNING, available: false, loadError: new Error('fetch failed') })
    const result = checkEmbeddings(configWith(undefined))
    expect(result.status).toBe('warn')
    expect(result.message).not.toContain('disabled by config')
  })

  it.each([['MODULE_NOT_FOUND'], ['ERR_MODULE_NOT_FOUND']])(
    'names the bundled runtime, and the command for the native one, when the native package is absent (%s)',
    async (code) => {
      const checkEmbeddings = await withWebRuntime({ ...RUNNING, nativeError: notFound(code) })
      const result = checkEmbeddings(configWith(true))
      expect(result.status).toBe('ok')
      expect(result.message).toContain('bundled WebAssembly runtime, onnxruntime-web 1.30.0')
      expect(result.message).toContain('runtime binary downloaded')
      // A global token-goat resolves a sibling in the same global node_modules, so it needs -g; a project install must not have it. Getting this wrong sends the reader to a package that installs fine and still does not load.
      expect(result.message).toContain('npm install -g onnxruntime-node')
      expect(result.message).toContain('drop -g if token-goat is a project dependency')
    },
  )

  it('says the binary is fetched on first use when it is not on disk yet', async () => {
    const checkEmbeddings = await withWebRuntime({ ...RUNNING, binaryPresent: false })
    const result = checkEmbeddings(configWith(true))
    // Not a fault: the first `index` fetches it, exactly as it fetches the model weights.
    expect(result.status).toBe('ok')
    expect(result.message).toContain('runtime binary not downloaded yet, fetched once on first use')
  })

  it('warns when the binary is not on disk and offline mode forbids fetching it', async () => {
    const checkEmbeddings = await withWebRuntime({ ...RUNNING, binaryPresent: false })
    const result = checkEmbeddings(configWith(true, true))
    expect(result.status).toBe('warn')
    expect(result.message).toContain('network.offline')
    expect(result.message).toContain('falls back to keyword search')
  })

  it('carries the reason when the bundled runtime failed to start', async () => {
    const checkEmbeddings = await withWebRuntime({ ...RUNNING, available: false, loadError: new Error('download of onnxruntime-web-1.30.0.tgz failed: HTTP 404') })
    const result = checkEmbeddings(configWith(true))
    expect(result.status).toBe('warn')
    expect(result.message).toContain('HTTP 404')
    // It must say what is lost meanwhile, or the warning reads like a hard failure of a command that in fact still works.
    expect(result.message).toContain('falls back to keyword search')
    // Both ways out: fix the download, or install the native runtime.
    expect(result.message).toContain('registry.npmjs.org')
    expect(result.message).toContain('npm install -g onnxruntime-node')
  })

  it('says so rather than guessing when no reason was recorded', async () => {
    const checkEmbeddings = await withWebRuntime({ ...RUNNING, available: false, loadError: null })
    const result = checkEmbeddings(configWith(true))
    expect(result.status).toBe('warn')
    expect(result.message).toContain('unknown error')
  })

  it('distinguishes a native package that is installed but broken from one that is missing', async () => {
    // Different fault, different fix. Telling someone to install a package they already have is the failure mode this branch exists to avoid, so the install command must be absent here.
    const checkEmbeddings = await withWebRuntime({ ...RUNNING, nativeError: new Error('onnxruntime_binding.node is not a valid Win32 application') })
    const result = checkEmbeddings(configWith(true))
    expect(result.status).toBe('ok')
    expect(result.message).toContain('installed but failed to load')
    expect(result.message).toContain('onnxruntime_binding.node')
    expect(result.message).not.toContain('npm install')
  })
})

describe('the error code the absent branch keys on', () => {
  it('is what Node really produces for a module that is not installed', async () => {
    // Anchors the branch to reality instead of an assumed constant: were Node ever to report something else, checkEmbeddings would quietly fall through to the "failed to load" message and stop printing the install command. This fails instead of that drifting unnoticed.
    const { createRequire } = await import('node:module')
    const req = createRequire(import.meta.url)
    let code: string | undefined
    try {
      req.resolve('onnxruntime-node-definitely-not-installed')
    } catch (e) {
      code = (e as NodeJS.ErrnoException).code
    }
    expect(code).toBe('MODULE_NOT_FOUND')
  })
})
