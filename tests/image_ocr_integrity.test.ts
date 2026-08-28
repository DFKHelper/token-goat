import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type * as ChildProcess from 'node:child_process'

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Same wrapper as image_ocr.test.ts: the real spawn still runs, but call counts become observable,
// which is how "refused without ever starting the engine" is asserted as behavior rather than
// inferred from timing.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

import { spawn } from 'node:child_process'

import { tokenGoatHome } from '../src/disk_cache.js'
import {
  OCR_LANG_PATH,
  OCR_LANG_SHA256,
  ocrImage,
  ocrIntegrityFailed,
  resetOcrStateForTesting,
  setTesseractEntryForTesting,
  verifyOcrLangCache,
} from '../src/image_ocr.js'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ocr-integrity-'))

// Every test here writes and deletes the one shared model cache under TOKEN_GOAT_HOME. Other files
// run concurrently and some of them OCR, so pointing this file at its own home is what keeps the two
// from poisoning each other -- without it these tests fail intermittently and take others with them.
const PRIOR_HOME = process.env['TOKEN_GOAT_HOME']
process.env['TOKEN_GOAT_HOME'] = path.join(TMP, 'home')

afterAll(() => {
  if (PRIOR_HOME === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = PRIOR_HOME
})

function cacheFile(): string {
  return path.join(tokenGoatHome(), 'ocr-cache', 'eng.traineddata')
}

function writePoisonedCache(): string {
  const file = cacheFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // Any content at all fails: finding a preimage for the pinned digest is the thing being relied on.
  fs.writeFileSync(file, 'not the real language model', 'utf8')
  return file
}

/** A tesseract.js-shaped stub that records the options `createWorker` was called with, so the
 * argument the shipping child script actually builds is asserted rather than the constant it was
 * built from. */
function writeRecordingStub(recordTo: string): string {
  const file = path.join(TMP, `stub-${Math.random().toString(36).slice(2)}.cjs`)
  const body = [
    "const fs = require('fs');",
    'module.exports = {',
    '  createWorker: async (lang, oem, options) => {',
    `    fs.writeFileSync(${JSON.stringify(recordTo)}, JSON.stringify({ lang, oem, options: { cachePath: options.cachePath, langPath: options.langPath } }));`,
    "    return { recognize: async () => ({ data: { text: 'hello', confidence: 90 } }), terminate: async () => {} };",
    '  },',
    '};',
  ].join('\n')
  fs.writeFileSync(file, body, 'utf8')
  return file
}

beforeEach(() => {
  resetOcrStateForTesting()
  fs.rmSync(cacheFile(), { force: true })
  vi.mocked(spawn).mockClear()
})

afterEach(() => {
  resetOcrStateForTesting()
  fs.rmSync(cacheFile(), { force: true })
})

describe('the pinned language-model source', () => {
  // Provenance: HAND-DERIVED. Both assertions are computed from the stated invariant (an immutable
  // artifact needs an explicit version and a full-length digest), independently of the values in
  // image_ocr.ts, so they do not merely restate the constants back at themselves.
  it('names an explicit npm version, because a jsDelivr /npm/ path without one resolves to latest', () => {
    // This is the whole defect being closed: tesseract.js's own default URL ends in a 4.0.0_best_int
    // path segment and carries no @version, so it floats to whatever the package's latest publish is.
    expect(OCR_LANG_PATH).toMatch(/@tesseract\.js-data\/eng@\d+\.\d+\.\d+\//)
    expect(OCR_LANG_PATH.startsWith('https://')).toBe(true)
  })

  it('pins a full-length lowercase sha-256, not a truncated or uppercase one', () => {
    expect(OCR_LANG_SHA256).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('verifyOcrLangCache', () => {
  it('reports absent when nothing is cached yet, which is the ordinary cold start and not a failure', () => {
    expect(verifyOcrLangCache()).toBe('absent')
  })

  it('reports mismatch when the cached bytes are not the pinned model', () => {
    writePoisonedCache()
    expect(verifyOcrLangCache()).toBe('mismatch')
  })
})

describe('ocrImage with a cached model that fails verification', () => {
  it('refuses before starting the engine, quarantines the file, and says why', async () => {
    const poisoned = writePoisonedCache()
    setTesseractEntryForTesting(writeRecordingStub(path.join(TMP, 'unused.json')))

    expect(ocrIntegrityFailed()).toBe(false)
    const result = await ocrImage(Buffer.from('image bytes'))

    expect(result).toBeNull()
    // The engine must never have run: a model that failed its hash is one whose parser must not be
    // handed the file at all, so refusing after the spawn would be a materially weaker guarantee.
    expect(vi.mocked(spawn)).not.toHaveBeenCalled()
    expect(fs.existsSync(poisoned)).toBe(false)
    expect(ocrIntegrityFailed()).toBe(true)
  })

  it('stays refused for the rest of the process even once the bad file is gone', async () => {
    writePoisonedCache()
    setTesseractEntryForTesting(writeRecordingStub(path.join(TMP, 'unused2.json')))
    await ocrImage(Buffer.from('image bytes'))
    vi.mocked(spawn).mockClear()

    // The quarantine already deleted the file, so without the sticky flag this second call would
    // look like an ordinary cold start and run the engine against a freshly downloaded model.
    const second = await ocrImage(Buffer.from('image bytes'))
    expect(second).toBeNull()
    expect(vi.mocked(spawn)).not.toHaveBeenCalled()
  })
})

describe('the model cache directory', () => {
  // Provenance: CAPTURE. tesseract.js was run directly against a cachePath whose directory did not
  // exist: it returned OCR text normally and wrote nothing, so the missing directory is silent. With
  // the directory present it wrote eng.traineddata (5,199,098 bytes). Without this, the model is
  // re-fetched on every call and the warm-cache verification above never has a file to check.
  it('exists after an OCR run, so the model is cached instead of re-downloaded every call', async () => {
    const dir = path.join(tokenGoatHome(), 'ocr-cache')
    fs.rmSync(dir, { recursive: true, force: true })
    expect(fs.existsSync(dir)).toBe(false)

    setTesseractEntryForTesting(writeRecordingStub(path.join(TMP, 'unused4.json')))
    await ocrImage(Buffer.from('image bytes'))

    expect(fs.existsSync(dir)).toBe(true)
  })
})

describe('image-text reporting an integrity refusal', () => {
  it('names the checksum failure instead of blaming the image', async () => {
    const { runImageText } = await import('../src/read_commands.js')
    const img = path.join(TMP, `shot-${Math.random().toString(36).slice(2)}.png`)
    fs.writeFileSync(img, Buffer.from('\x89PNG\r\n\x1a\n', 'binary'))
    writePoisonedCache()
    setTesseractEntryForTesting(writeRecordingStub(path.join(TMP, 'unused3.json')))

    // The generic branch below this one blames the input, which for an integrity refusal is both
    // wrong and unactionable: the image was never looked at.
    await expect(runImageText(img)).rejects.toThrow(/failed its checksum and was discarded/)
  })
})

describe('the child script the engine actually receives', () => {
  it('passes the pinned langPath, so the download never falls back to the floating default', async () => {
    const recordTo = path.join(TMP, `opts-${Math.random().toString(36).slice(2)}.json`)
    setTesseractEntryForTesting(writeRecordingStub(recordTo))

    const result = await ocrImage(Buffer.from('image bytes'))

    expect(result).not.toBeNull()
    expect(fs.existsSync(recordTo)).toBe(true)
    const recorded = JSON.parse(fs.readFileSync(recordTo, 'utf8')) as {
      lang: string
      oem: number
      options: { cachePath?: string; langPath?: string }
    }
    expect(recorded.options.langPath).toBe(OCR_LANG_PATH)
    // The OEM is load-bearing for the pin: tesseract.js picks 4.0.0_best_int over 4.0.0 from this
    // value, so a change here silently points the pinned URL at a different artifact than the digest.
    expect(recorded.oem).toBe(1)
    expect(recorded.lang).toBe('eng')
  })
})
