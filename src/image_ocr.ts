/**
 * OCR — extract text from text-heavy images (screenshots of a terminal, a
 * stack trace, a table, an editor, a doc page) instead of paying vision
 * tokens to reconstruct their pixels.
 *
 * `tesseract.js` is the only realistic offline-capable OCR engine for a
 * Node CLI with no guaranteed network at runtime: it is pure JS/WASM (no
 * native binary to cross-compile, unlike a Tesseract C++ binding), and its
 * one genuinely network-dependent piece — the `eng.traineddata` language
 * model (~4 MB) — is fetched once and then cached under `tokenGoatHome()`,
 * so every read after the first works fully offline. It is registered as
 * `optionalDependencies` and added to `esbuild.config.mjs`'s
 * `EXTERNAL_NATIVE_DEPS` (see that file's comment) so an install that skips
 * optional deps degrades gracefully instead of breaking the build.
 *
 * The one thing that makes this module unusually shaped: `tesseract.js`
 * v6's Node worker does NOT reliably surface load failures as a rejected
 * promise. Verified directly against this package/Node version: pointing
 * `createWorker` at an unreadable local `langPath` throws an uncaught
 * exception from inside the worker's internal `worker_threads` message
 * handler (bypassing any surrounding try/catch — Node's `Worker` is an
 * `EventEmitter`, and tesseract.js's `worker.onerror = ...` assignment is
 * not the same as `worker.on('error', ...)`, so the default "unhandled
 * error event" throw applies); pointing it at an unreachable network host
 * (an offline machine with no cached model) instead makes `createWorker`'s
 * returned promise hang forever, settling neither way. Either failure mode
 * would violate this hook's "must fail open, never blocks a Read" contract
 * if `createWorker` were called in-process — a crash kills the whole hook
 * invocation, and a hang is worse: `main.ts` deliberately never calls
 * `process.exit()` (so buffered stdout flushes cleanly on Windows pipes),
 * so a hung promise here would hang the entire CLI process forever.
 *
 * The fix is process isolation, not a try/catch: {@link ocrImage} spawns a
 * short-lived Node child process to do the actual `tesseract.js` work,
 * talks to it over stdin/stdout, and enforces its own hard kill-timeout
 * from the parent. However the child misbehaves — crash, hang, garbage
 * output — the parent's timeout guarantees a `SIGKILL` and a `null`
 * result, never a hang or a crash in the process the hook actually runs in.
 */

import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'

import { loadConfig } from './config.js'
import { tokenGoatHome } from './disk_cache.js'

/** Result of a successful OCR pass. `confidence` is Tesseract's own 0-100 mean-word-confidence score. */
export interface OcrResult {
  readonly text: string
  readonly confidence: number
}

/** Hard ceiling on the whole spawn-recognize-parse round trip, including a cold-cache language-model download. Bounded low enough that an offline machine with no cached model doesn't stall a Read for long, high enough that a real download over a slow link usually completes. Overridable for tests exercising the timeout path itself, which would otherwise have to burn the real 12s per case. */
let _ocrTimeoutMs = 12_000

/** Test seam for {@link _ocrTimeoutMs}. */
export function setOcrTimeoutForTesting(ms: number | undefined): void {
  _ocrTimeoutMs = ms ?? 12_000
}

/** Where the language-model cache lives, so `token-goat`'s own installs share the download and it survives across CLI invocations (each hook event is normally its own short-lived process). */
/** The file tesseract.js writes into its cache directory for the one language this module uses. */
const OCR_LANG_FILE = 'eng.traineddata'

/**
 * tesseract.js downloads its language data from a CDN on a cold cache and offers no option to
 * forbid that, so offline mode checks the cache itself: a machine that already has the file still
 * does OCR, and one that does not declines instead of reaching cdn.jsdelivr.net.
 */
export function ocrBlockedOffline(): boolean {
  if (!loadConfig().network.offline) return false
  return !fs.existsSync(path.join(ocrCacheDir(), OCR_LANG_FILE))
}

function ocrCacheDir(): string {
  return path.join(tokenGoatHome(), 'ocr-cache')
}

const _require = createRequire(import.meta.url)

/** `undefined` until first resolved; `null` once resolution fails (dep skipped/broken). Resolved once because availability does not change within a process — mirrors `image_shrink.ts`'s `_sharpCache` pattern. */
let _tesseractEntryPath: string | null | undefined

/** Resolve `tesseract.js`'s real entry file path via Node's own module resolution — from `dist/token-goat.mjs`'s location, this walks up to token-goat's own `node_modules`, exactly like the bare `import('tesseract.js')` other lazy-loaders in this codebase use, but resolves synchronously to a path the spawned child process can `require()` directly (see the module doc comment for why the child never inherits token-goat's own working directory or module graph). */
function resolveTesseractEntry(): string | null {
  if (_tesseractEntryPath !== undefined) return _tesseractEntryPath
  try {
    _tesseractEntryPath = _require.resolve('tesseract.js')
  } catch {
    _tesseractEntryPath = null
  }
  return _tesseractEntryPath
}

/** Test seam: lets tests substitute a fake resolved entry path (e.g. pointing at a stub module) without needing the real `tesseract.js` package installed, or force "unavailable" by passing null. */
export function setTesseractEntryForTesting(entryPath: string | null | undefined): void {
  _tesseractEntryPath = entryPath
}

/** Once a spawn/timeout failure is observed, OCR is treated as unavailable for the rest of this process — avoids re-paying the full timeout on every subsequent image in a process that reads several (e.g. `hook_lib.ts`'s in-process bridges, or a batch of Reads relayed through one process). A normal per-image recognition failure (exit code 1, bad image) does NOT set this — only a broken subprocess boundary itself does. */
let _ocrUnavailableThisProcess = false

/** Test seam to reset the sticky-disable flag between test cases. */
export function resetOcrStateForTesting(): void {
  _ocrUnavailableThisProcess = false
  _tesseractEntryPath = undefined
  _ocrTimeoutMs = 12_000
}

/**
 * Inline child-process script: loads `tesseract.js` from the resolved
 * absolute entry path (never a bare specifier — the child's own module
 * resolution starts from `process.cwd()`, which for a globally installed
 * CLI is the caller's project directory, not token-goat's install dir), reads
 * the image bytes from stdin, OCRs them, and prints a one-line JSON result
 * to stdout. `errorHandler: () => {}` swallows tesseract.js's internal
 * "load failed" event so it does not throw inside the worker's message
 * handler (see module doc comment) — the parent's timeout is what actually
 * bounds a load failure, not this handler.
 */
function buildChildScript(entryPath: string, cacheDir: string): string {
  return [
    `const { createWorker } = require(${JSON.stringify(entryPath)});`,
    'const chunks = [];',
    "process.stdin.on('data', (c) => chunks.push(c));",
    "process.stdin.on('end', async () => {",
    '  try {',
    '    const buf = Buffer.concat(chunks);',
    `    const worker = await createWorker('eng', 1, { cachePath: ${JSON.stringify(cacheDir)}, errorHandler: () => {} });`,
    '    const { data } = await worker.recognize(buf);',
    "    process.stdout.write(JSON.stringify({ text: data.text || '', confidence: data.confidence || 0 }));",
    '    await worker.terminate();',
    '    process.exit(0);',
    '  } catch (e) {',
    '    process.exit(1);',
    '  }',
    '});',
  ].join('\n')
}

/**
 * OCR an image buffer in an isolated child process. Returns `null` on any
 * failure — dep unavailable, spawn error, timeout, non-zero exit, or
 * unparsable output — never throws.
 */
export async function ocrImage(input: Buffer): Promise<OcrResult | null> {
  if (_ocrUnavailableThisProcess) return null

  const entryPath = resolveTesseractEntry()
  if (entryPath === null) return null

  if (ocrBlockedOffline()) return null

  return new Promise<OcrResult | null>((resolve) => {
    let settled = false
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(process.execPath, ['-e', buildChildScript(entryPath, ocrCacheDir())], {
        stdio: ['pipe', 'pipe', 'ignore'],
      })
    } catch {
      _ocrUnavailableThisProcess = true
      resolve(null)
      return
    }

    const chunks: Buffer[] = []

    const finish = (result: OcrResult | null, subprocessBroken: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (subprocessBroken) _ocrUnavailableThisProcess = true
      try {
        child.kill()
      } catch {
        // Already exited; nothing to clean up.
      }
      resolve(result)
    }

    // See module doc comment: a load failure inside tesseract.js can hang the child's own
    // createWorker promise forever rather than reject it, so this timeout — not a rejection
    // handler — is what guarantees the parent (and thus the hook process) never blocks.
    const timer = setTimeout(() => finish(null, true), _ocrTimeoutMs)

    child.stdout?.on('data', (c: Buffer) => chunks.push(c))
    child.on('error', () => finish(null, true))
    child.on('close', (code) => {
      if (code !== 0) {
        finish(null, false)
        return
      }
      try {
        const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const parsed = raw as { text?: unknown; confidence?: unknown }
        const text = typeof parsed.text === 'string' ? parsed.text.trim() : ''
        const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0
        finish({ text, confidence }, false)
      } catch {
        finish(null, false)
      }
    })

    try {
      child.stdin?.end(input)
    } catch {
      finish(null, false)
    }
  })
}

/**
 * Heuristic for "is this OCR result evidence of a text-heavy image" —
 * requires both a confident recognition (Tesseract's own score, not a
 * separate pixel-based classifier) and a non-trivial amount of extracted
 * text. Confidence alone is not enough: a photo with one crisp word on a
 * sign or logo can still score high confidence on that one word while the
 * rest of the frame is pixels, so `minChars` guards against a short
 * high-confidence fragment being mistaken for a genuinely text-heavy image.
 */
export function isTextHeavy(result: OcrResult, minConfidence: number, minChars = 40): boolean {
  return result.confidence >= minConfidence && result.text.length >= minChars
}

/** Build the human-readable OCR summary + extracted text, mirroring `image_shrink.ts`'s `formatShrinkSummary` convention: one savings-style line, then the payload the model actually reads. This REPLACES the image entirely (no data URL) rather than supplementing it — the whole point is to avoid paying vision tokens for pixels the model would only use to reconstruct this same text. */
export function formatOcrSummary(result: OcrResult, subject: string, originalBytes: number): string {
  const kb = Math.round(originalBytes / 1024)
  const summary =
    `token-goat OCR'd ${subject} instead of shrinking it: text-heavy image detected ` +
    `(${Math.round(result.confidence)}% confidence), extracted ${result.text.length} chars ` +
    `of text from ${kb}kb of pixels.`
  return `${summary}\n\n${result.text}`
}
