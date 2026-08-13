import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type * as ChildProcess from 'node:child_process'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Wraps the real `spawn` so call counts are observable without breaking the actual subprocess
// round trip other tests in this file rely on -- Node's built-in ESM module namespace can't be
// spied on directly (its exports are non-configurable), so this is the only way to assert "no
// second spawn happened" as behavior instead of falling back to a wall-clock race.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

import {
  formatOcrSummary,
  isTextHeavy,
  ocrImage,
  resetOcrStateForTesting,
  setOcrTimeoutForTesting,
  setTesseractEntryForTesting,
} from '../src/image_ocr.js'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ocr-stub-'))

/** Writes a fake `tesseract.js`-shaped module (matching the `{ createWorker }` shape the
 * child script destructures) so `ocrImage`'s spawn/stdin/stdout/JSON-parse plumbing can be
 * exercised end-to-end without the real WASM engine or a network-fetched language model —
 * fast and fully offline, per this repo's convention of not requiring the real heavy
 * dependency to run in every CI test (see image_shrink_sharp_unavailable.test.ts's
 * `vi.mock('sharp', ...)` for the equivalent pattern applied to a real module instead of a
 * spawned subprocess, which cannot be `vi.mock`ed since it runs in a separate process). */
function writeStub(name: string, body: string): string {
  const file = path.join(TMP, `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`)
  fs.writeFileSync(file, body, 'utf8')
  return file
}

beforeEach(() => {
  resetOcrStateForTesting()
})

afterEach(() => {
  resetOcrStateForTesting()
})

describe('isTextHeavy', () => {
  it('is true for high confidence and substantial text', () => {
    expect(isTextHeavy({ text: 'x'.repeat(50), confidence: 90 }, 65)).toBe(true)
  })

  it('is false when confidence is below the threshold even with plenty of text', () => {
    expect(isTextHeavy({ text: 'x'.repeat(200), confidence: 40 }, 65)).toBe(false)
  })

  it('is false when text is too short even at high confidence (a stray high-confidence word on a photo)', () => {
    expect(isTextHeavy({ text: 'STOP', confidence: 95 }, 65)).toBe(false)
  })

  it('honours a custom minChars', () => {
    expect(isTextHeavy({ text: 'short', confidence: 95 }, 65, 3)).toBe(true)
  })
})

describe('formatOcrSummary', () => {
  it('replaces the image with the extracted text (no data URL)', () => {
    const out = formatOcrSummary({ text: 'hello world', confidence: 88 }, 'shot.png', 600_000)
    expect(out).toContain('hello world')
    expect(out).not.toContain('data:image/')
    expect(out).toContain('88%')
  })
})

describe('ocrImage', () => {
  it('returns null immediately when tesseract.js cannot be resolved (optional dep skipped)', async () => {
    setTesseractEntryForTesting(null)
    const result = await ocrImage(Buffer.from('not a real image'))
    expect(result).toBeNull()
  })

  it('returns the recognised text and confidence on a successful subprocess round trip', async () => {
    const stub = writeStub(
      'ok',
      `module.exports.createWorker = async function () {
        return {
          recognize: async () => ({ data: { text: 'stubbed screenshot text', confidence: 91 } }),
          terminate: async () => {},
        }
      }`,
    )
    setTesseractEntryForTesting(stub)
    const result = await ocrImage(Buffer.from('fake-image-bytes'))
    expect(result).not.toBeNull()
    expect(result?.text).toBe('stubbed screenshot text')
    expect(result?.confidence).toBe(91)
  })

  it('returns null when the child process exits non-zero (recognition failure)', async () => {
    const stub = writeStub(
      'crash',
      `module.exports.createWorker = async function () {
        throw new Error('boom')
      }`,
    )
    setTesseractEntryForTesting(stub)
    const result = await ocrImage(Buffer.from('fake-image-bytes'))
    expect(result).toBeNull()
  })

  it('returns null and does not hang the caller when the child never responds (simulates the tesseract.js load-hang bug this module works around)', async () => {
    const stub = writeStub(
      'hang',
      `module.exports.createWorker = async function () {
        return new Promise(() => {}); // never resolves, never rejects
      }`,
    )
    setTesseractEntryForTesting(stub)
    setOcrTimeoutForTesting(300)
    // Fake timers assert the kill-timeout path actually fires, instead of a wall-clock bound
    // that measures the test machine's speed under load rather than the module's behaviour.
    vi.useFakeTimers()
    try {
      const pending = ocrImage(Buffer.from('fake-image-bytes'))
      await vi.advanceTimersByTimeAsync(300)
      const result = await pending
      expect(result).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks OCR unavailable for the rest of the process after a timeout, skipping the spawn on the next call', async () => {
    const stub = writeStub(
      'hang2',
      `module.exports.createWorker = async function () {
        return new Promise(() => {});
      }`,
    )
    setTesseractEntryForTesting(stub)
    setOcrTimeoutForTesting(1000)
    const { spawn } = await import('node:child_process')
    const spawnSpy = vi.mocked(spawn)
    spawnSpy.mockClear()
    // Fake timers drive the kill-timeout deterministically; the regression this guards against
    // is the sticky-disable flag not being set, which a wall-clock "second call is fast" bound
    // cannot distinguish from ordinary machine-speed variance under parallel test load.
    vi.useFakeTimers()
    try {
      const firstPending = ocrImage(Buffer.from('a'))
      await vi.advanceTimersByTimeAsync(1000)
      const first = await firstPending
      expect(first).toBeNull()
      expect(spawnSpy).toHaveBeenCalledTimes(1)

      // Second call must not spawn a new child at all -- if the sticky-disable flag weren't
      // set by the timeout above, this would spawn again and hang on the same fake timer.
      const second = await ocrImage(Buffer.from('b'))
      expect(second).toBeNull()
      expect(spawnSpy).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does NOT mark OCR unavailable after a normal per-image recognition failure (exit code 1)', async () => {
    const stub = writeStub(
      'crash2',
      `module.exports.createWorker = async function () {
        throw new Error('bad image')
      }`,
    )
    setTesseractEntryForTesting(stub)
    const first = await ocrImage(Buffer.from('a'))
    expect(first).toBeNull()

    // A follow-up call against a stub that succeeds must still attempt the subprocess --
    // proves the sticky-disable flag was NOT set by the ordinary exit-code-1 failure above.
    const okStub = writeStub(
      'ok2',
      `module.exports.createWorker = async function () {
        return { recognize: async () => ({ data: { text: 'second image text', confidence: 80 } }), terminate: async () => {} }
      }`,
    )
    setTesseractEntryForTesting(okStub)
    const second = await ocrImage(Buffer.from('b'))
    expect(second?.text).toBe('second image text')
  })
})
