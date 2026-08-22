/**
 * The one part of the embedding stack that touches the network, and the checks that make that safe.
 *
 * `ensureModelFiles` fetches 34 MB of ONNX weights and hands them to a native execution runtime, so
 * "it downloaded and the file is there" is not the bar. The bar is that nothing other than the
 * exact pinned bytes ever reaches disk under the cache's name. These tests drive the real function
 * with `fetch` substituted, because the failure modes that matter -- a wrong body, a body that
 * keeps coming, a mutable ref -- cannot be produced by asking huggingface.co nicely.
 *
 * The `tokenizer.json` used here is not a stand-in: it is the same fixture the tokenizer oracle
 * runs against, and its sha256 is the one pinned in embed_model.ts, so the happy path is verified
 * against genuine model bytes. It is also the *first* entry in MODEL_FILES, which is what lets
 * these tests exercise every per-file branch without ever needing the 34 MB second file: a run that
 * gets as far as asking for `model_quantized.onnx` has already accepted the tokenizer.
 *
 * This supersedes tests/embeddings_model_revision_pin.test.ts, which asserted the same pin one
 * layer up by watching the options object `embedTexts` passed to `@xenova/transformers`. There is
 * no such object now -- the revision is a constant in the URL -- so the assertion moved down to the
 * URL itself, which is the thing that was ever actually at risk.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { _resetDataDirCacheForTesting } from '../src/constants.js'
import { DEFAULT_MODEL, PINNED_MODEL_REVISION, ensureModelFiles, modelDir } from '../src/embed_model.js'
import { clearModuleCaches } from '../src/reset.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** The real pinned tokenizer.json, unzipped from the fixture the oracle test also reads. */
const REAL_TOKENIZER: Buffer = zlib.gunzipSync(
  fs.readFileSync(path.join(HERE, 'fixtures', 'wordpiece', 'tokenizer.json.gz')),
)

const ENV_KEYS = ['LOCALAPPDATA', 'XDG_DATA_HOME', 'TOKEN_GOAT_OFFLINE'] as const

let tmp: string
let saved: Record<string, string | undefined>

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-embed-model-'))
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  process.env['LOCALAPPDATA'] = tmp
  process.env['XDG_DATA_HOME'] = tmp
  delete process.env['TOKEN_GOAT_OFFLINE']
  _resetDataDirCacheForTesting()
  clearModuleCaches()
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const key of ENV_KEYS) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  _resetDataDirCacheForTesting()
  clearModuleCaches()
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** A response with the given body, in the shape `download` consumes. */
function bodyResponse(bytes: Uint8Array): Response {
  return new Response(bytes as unknown as BodyInit, { status: 200 })
}

/**
 * Substitute `fetch`, recording every URL asked for. The handler returns the body for a URL, or
 * throws to stand in for "this file was never supposed to be requested".
 */
function stubFetch(handler: (url: string) => Response | Promise<Response>): { urls: string[] } {
  const urls: string[] = []
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input)
    urls.push(url)
    return handler(url)
  })
  return { urls }
}

/** Where a given model file lands once accepted. */
function cachedPath(name: string): string {
  return path.join(modelDir(), ...name.split('/'))
}

/** Put the genuine tokenizer.json into the cache, as a completed earlier run would have. */
function seedRealTokenizer(): void {
  const target = cachedPath('tokenizer.json')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, REAL_TOKENIZER)
}

/** Files left in the model directory, relative and slash-separated, for leftover-partial checks. */
function filesUnderModelDir(): string[] {
  const root = modelDir()
  if (!fs.existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(path.relative(root, full).split(path.sep).join('/'))
    }
  }
  walk(root)
  return out.sort()
}

describe('ensureModelFiles: what it will fetch', () => {
  it('asks only for the pinned model at the pinned immutable revision', async () => {
    const { urls } = stubFetch(() => bodyResponse(REAL_TOKENIZER))

    // The onnx file is not stubbed with correct bytes, so this rejects -- the URL list is the
    // assertion. A mutable ref like `main` here is the trust-on-first-use bug this pins shut.
    await expect(ensureModelFiles()).rejects.toThrow()

    expect(urls[0]).toBe(
      `https://huggingface.co/${DEFAULT_MODEL}/resolve/${PINNED_MODEL_REVISION}/tokenizer.json`,
    )
    expect(urls.every((u) => u.startsWith('https://huggingface.co/'))).toBe(true)
    expect(urls.some((u) => u.includes('/main/') || u.includes('/resolve/main'))).toBe(false)
  })

  it('refuses a model other than the pinned one without opening a connection at all', async () => {
    const { urls } = stubFetch(() => bodyResponse(REAL_TOKENIZER))

    await expect(ensureModelFiles('attacker/evil-model')).rejects.toThrow(/Only Xenova\/bge-small-en-v1\.5/)
    // Refusing after downloading would defeat the point: there is no digest to check it against.
    expect(urls).toEqual([])
  })

  it('puts the pinned revision in the cache path, so a re-pin cannot reuse the old files', () => {
    expect(modelDir()).toContain(PINNED_MODEL_REVISION)
  })
})

describe('ensureModelFiles: what it refuses to keep', () => {
  it('rejects a body whose digest is not the pinned one, and keeps nothing', async () => {
    const wrong = Buffer.from(REAL_TOKENIZER)
    wrong[0] = wrong[0] === 0x7b ? 0x7c : 0x7b // same length, different bytes
    stubFetch(() => bodyResponse(wrong))

    await expect(ensureModelFiles()).rejects.toThrow(/tokenizer\.json has sha256 .*expected the pinned/)
    expect(filesUnderModelDir()).toEqual([])
  })

  it('stops a body that runs past the pinned length instead of spending the disk', async () => {
    const tooLong = Buffer.concat([REAL_TOKENIZER, Buffer.alloc(4096, 0x20)])
    stubFetch(() => bodyResponse(tooLong))

    await expect(ensureModelFiles()).rejects.toThrow(/longer than the pinned 711396 bytes/)
    expect(filesUnderModelDir()).toEqual([])
  })

  it('rejects a truncated body rather than caching a short file', async () => {
    stubFetch(() => bodyResponse(REAL_TOKENIZER.subarray(0, 1000)))

    await expect(ensureModelFiles()).rejects.toThrow(/tokenizer\.json is 1000 bytes, expected the pinned/)
    expect(filesUnderModelDir()).toEqual([])
  })

  it('names the status when the server refuses, rather than failing on an empty digest', async () => {
    stubFetch(() => new Response('nope', { status: 403, statusText: 'Forbidden' }))

    await expect(ensureModelFiles()).rejects.toThrow(/returned 403 Forbidden/)
    expect(filesUnderModelDir()).toEqual([])
  })
})

describe('ensureModelFiles: a sink that fails mid-download', () => {
  // A write stream reports failure by emitting 'error', asynchronously and to its listeners. With
  // none attached, Node re-raises it as an uncaught exception, which in a CLI is not a rejected
  // download but a dead process -- and the caller never learns the download failed at all. Both
  // halves are asserted here because either one alone still looks like a pass.
  it('rejects with the write failure rather than raising it where nobody is listening', async () => {
    stubFetch(() => bodyResponse(REAL_TOKENIZER))
    // A directory sitting where the scratch file goes -- a leftover, or another process -- makes
    // the open fail, asynchronously and after `download` has already returned its promise. Nothing
    // here is mocked: the real code opens the real path and really fails.
    const partial = `${cachedPath('tokenizer.json')}.${process.pid}.partial`
    fs.mkdirSync(partial, { recursive: true })

    const uncaught: unknown[] = []
    const onUncaught = (e: unknown): void => void uncaught.push(e)
    process.on('uncaughtException', onUncaught)
    try {
      await expect(ensureModelFiles()).rejects.toThrow(/EISDIR|EPERM|EACCES/)
      await new Promise((resolve) => setTimeout(resolve, 50))
    } finally {
      process.off('uncaughtException', onUncaught)
    }

    expect(uncaught, 'a stream error must not escape as an uncaught exception').toEqual([])
    // Only the directory that was already there. No half-written tokenizer.json got renamed in.
    expect(filesUnderModelDir()).toEqual([])
  })
})

describe('ensureModelFiles: the cache', () => {
  it('accepts a cached file that hashes correctly without re-fetching it', async () => {
    seedRealTokenizer()
    const { urls } = stubFetch(() => bodyResponse(Buffer.alloc(0)))

    // Reaching the onnx file is the proof: the tokenizer was accepted from disk on its digest.
    await expect(ensureModelFiles()).rejects.toThrow()
    expect(urls).toEqual([
      `https://huggingface.co/${DEFAULT_MODEL}/resolve/${PINNED_MODEL_REVISION}/onnx/model_quantized.onnx`,
    ])
  })

  it('replaces a cached file that does not hash, rather than trusting its name', async () => {
    const target = cachedPath('tokenizer.json')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, Buffer.alloc(REAL_TOKENIZER.length, 0x41))
    const { urls } = stubFetch((url) =>
      url.endsWith('tokenizer.json') ? bodyResponse(REAL_TOKENIZER) : bodyResponse(Buffer.alloc(0)),
    )

    await expect(ensureModelFiles()).rejects.toThrow()

    // A present-and-wrong file that were merely skipped would fail every later run identically.
    expect(urls[0]).toMatch(/tokenizer\.json$/)
    expect(fs.readFileSync(target).equals(REAL_TOKENIZER)).toBe(true)
  })
})

describe('ensureModelFiles: offline mode', () => {
  it('refuses to download and says which switch did it and where to put the files', async () => {
    process.env['TOKEN_GOAT_OFFLINE'] = '1'
    const { urls } = stubFetch(() => bodyResponse(REAL_TOKENIZER))

    await expect(ensureModelFiles()).rejects.toThrow(/network\.offline/)
    await expect(ensureModelFiles()).rejects.toThrow(new RegExp(PINNED_MODEL_REVISION))
    expect(urls, 'offline mode that still opens the connection is not offline mode').toEqual([])
  })

  it('still serves a cache that is already complete and correct', async () => {
    // Offline is about not connecting, not about refusing to work: a verified file on disk needs
    // no network, and treating offline as "always fail" would break an air-gapped install that was
    // seeded deliberately.
    seedRealTokenizer()
    process.env['TOKEN_GOAT_OFFLINE'] = '1'
    const { urls } = stubFetch(() => bodyResponse(REAL_TOKENIZER))

    // The onnx file is genuinely absent, so this still refuses -- but on the onnx file, not the
    // tokenizer, and without a request.
    await expect(ensureModelFiles()).rejects.toThrow(/model_quantized\.onnx/)
    expect(urls).toEqual([])
  })
})
