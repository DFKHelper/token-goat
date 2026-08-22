/**
 * `doctor`'s report on the one optional package a default install stopped carrying.
 *
 * The embedding backend was `@xenova/transformers`, an optionalDependency, which npm installs by
 * default -- so in practice everyone got it, along with a critical `protobufjs` advisory, four more
 * through `onnxruntime-web`, and a nested older `sharp` with four inherited libvips CVEs, none
 * patchable from here. The backend is `onnxruntime-node` now, and it is opt-in: a 34 MB native
 * addon has no business landing in every install for a feature most of them never invoke.
 *
 * That trade has one cost and this check is the whole of paying it. `semantic` consults keyword
 * search alongside the vectors, so with the model gone it still answers, still finds things, and
 * never errors -- it just stops matching on meaning. A degradation that produces no error, no empty
 * result and no warning is one nobody discovers, which is exactly what `doctor` is for.
 *
 * Four states, and the messages are genuinely different advice rather than four phrasings of
 * "unavailable": off in config is not a fault at all, absent is one command away, and present but
 * throwing is a different fault entirely. Asserting only `status` would pass while the install
 * command was wrong or missing, so these assert the text a reader actually acts on.
 *
 * The available case runs against the real package, which the repository still carries as a
 * devDependency, so the happy path is not a mock of itself. The three failure cases substitute
 * `embeddings.js` -- a genuinely separate module, not the code under test -- because the branch that
 * matters most to a consumer is the one this repository can never reach on its own.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Config } from '../src/config.js'

/** Only `indexing.embeddings_enabled` is read, so the rest of Config is irrelevant to the check. */
function configWith(enabled: boolean | undefined): Config {
  return { indexing: { embeddings_enabled: enabled } } as unknown as Config
}

/** Loads `checkEmbeddings` with `embeddings.js` reporting the given availability and load error. */
async function withModel(available: boolean, error: Error | null) {
  vi.resetModules()
  vi.doMock('../src/embeddings.js', () => ({
    isAvailable: () => available,
    embeddingBackendLoadError: () => error,
    // cli_doctor imports only these two, but the module graph is shared: anything else that pulls
    // embeddings.js during this import would get an incomplete module otherwise.
    embeddingsDepsAvailable: () => available,
  }))
  const mod = await import('../src/cli_doctor.js')
  return mod.checkEmbeddings
}

function notFound(code: string): Error {
  const err = new Error(`Cannot find module 'onnxruntime-node'`) as NodeJS.ErrnoException
  err.code = code
  return err
}

describe('doctor: embeddings', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.doUnmock('../src/embeddings.js')
  })

  it('reports the model as available when the real package loads', async () => {
    // No mock: the repository keeps onnxruntime-node as a devDependency, so this resolves it
    // through the same createRequire the shipping code uses, against the real package.
    const { checkEmbeddings } = await import('../src/cli_doctor.js')
    const result = checkEmbeddings(configWith(true))
    expect(result.name).toBe('Embeddings')
    expect(result.status).toBe('ok')
    expect(result.message).toBe('available')
  })

  it('treats the setting being switched off as fine, not as a fault', async () => {
    const checkEmbeddings = await withModel(false, notFound('MODULE_NOT_FOUND'))
    const result = checkEmbeddings(configWith(false))
    // Even with the model genuinely absent, an explicit opt-out is not a problem to report.
    expect(result.status).toBe('ok')
    expect(result.message).toContain('disabled by config')
    // And it must not print an install command: doctor would be telling the reader to undo
    // something they meant to do.
    expect(result.message).not.toContain('npm install')
  })

  it('treats an absent setting as enabled, matching how the rest of the code reads it', async () => {
    // src/cli.ts and src/worker.ts both spell this `?? true`. A doctor that instead read an absent
    // flag as "disabled by config" would print a clean bill of health for a config that never
    // mentioned the setting, which is a false all-clear rather than a cosmetic difference.
    const checkEmbeddings = await withModel(false, notFound('MODULE_NOT_FOUND'))
    const result = checkEmbeddings(configWith(undefined))
    expect(result.status).toBe('warn')
    expect(result.message).not.toContain('disabled by config')
    expect(result.message).toContain('npm install -g onnxruntime-node')
  })

  it.each([['MODULE_NOT_FOUND'], ['ERR_MODULE_NOT_FOUND']])(
    'names the exact install command when the model is absent (%s)',
    async (code) => {
      const checkEmbeddings = await withModel(false, notFound(code))
      const result = checkEmbeddings(configWith(true))
      expect(result.status).toBe('warn')
      // The command is the entire value of the warning. A global token-goat resolves a sibling in
      // the same global node_modules, so it needs -g; a project install must not have it. Getting
      // this wrong sends the reader to a package that installs fine and still does not load.
      expect(result.message).toContain('npm install -g onnxruntime-node')
      expect(result.message).toContain('drop -g if token-goat is a project dependency')
      // And it must say what is lost meanwhile, or the warning reads like a hard failure of a
      // command that in fact still works.
      expect(result.message).toContain('falls back to keyword search')
    },
  )

  it('distinguishes a package that is installed but broken from one that is missing', async () => {
    // Different fault, different fix. Telling someone to install a package they already have is the
    // failure mode this branch exists to avoid, so the install command must be absent here.
    const checkEmbeddings = await withModel(false, new Error('onnxruntime_binding.node is not a valid Win32 application'))
    const result = checkEmbeddings(configWith(true))
    expect(result.status).toBe('warn')
    expect(result.message).toContain('installed but failed to load')
    expect(result.message).toContain('onnxruntime_binding.node')
    expect(result.message).not.toContain('npm install')
  })

  it('says so rather than guessing when the load was never attempted', async () => {
    const checkEmbeddings = await withModel(false, null)
    const result = checkEmbeddings(configWith(true))
    expect(result.status).toBe('warn')
    expect(result.message).toContain('not attempted')
  })
})

describe('the error code the absent branch keys on', () => {
  it('is what Node really produces for a module that is not installed', async () => {
    // Anchors the branch to reality instead of an assumed constant: were Node ever to report
    // something else, checkEmbeddings would quietly fall through to the generic "failed to load"
    // message and stop printing the install command. This fails instead of that drifting unnoticed.
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
