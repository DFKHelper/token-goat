/**
 * Image shrink — intercept large images before they reach the model.
 *
 * Ports the load-bearing slice of `image_shrink.py` to the TypeScript hook
 * surface. Large images cost many vision tokens; downscaling to Claude's
 * optimal Vision dimension and re-encoding to JPEG (or WebP when that is
 * smaller) typically cuts the byte count — and the token cost — by more than
 * half with no perceptible quality loss at reading distance.
 *
 * The Python implementation uses Pillow; here we use `sharp`. `sharp` ships a
 * native binary, so it is imported lazily: if it is unavailable at runtime
 * (missing/incompatible native build), {@link shrinkImage} degrades to a
 * no-op (returns null) and {@link preReadImageHandler} passes through rather
 * than crashing the hook.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { loadConfig } from './config.js'
import { createLazyModuleLoader } from './lazy_module.js'
import { statSize, toKB } from './util.js'
import { getFilePath } from './hooks_common.js'
import type { HookEvent } from './hook_registry.js'
import { registerHook } from './hook_registry.js'
import { contextOutput, passOutput } from './hooks_common.js'
import { recordStat } from './stats.js'
import type { HookOutput } from './types.js'
import { formatOcrSummary, isTextHeavy, ocrImage } from './image_ocr.js'

/** Recognised image extensions (lowercase, leading dot). Matches the Python set. */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.tiff',
])

/** Claude Vision's optimal max edge: images larger than this gain nothing. */
const DEFAULT_MAX_DIMENSION = 1568

/** Below this byte count an image is left untouched (encode CPU > savings). */
const DEFAULT_SIZE_THRESHOLD_BYTES = 512 * 1024

/** Telemetry returned for a successful shrink. */
export interface ShrinkResult {
  /** Re-encoded image bytes. */
  readonly data: Buffer
  /** Byte count of the original input. */
  readonly originalBytes: number
  /** Byte count after shrinking. */
  readonly shrunkBytes: number
  /** Output width in pixels. */
  readonly width: number
  /** Output height in pixels. */
  readonly height: number
  /** Output container format (`jpeg` or `webp`). */
  readonly format: string
}

/** Build the human-readable savings summary and the shrunk image's data URL, shared by every caller of {@link shrinkImage} (hooks_browser_image.ts's inline-screenshot rewrite, this file's own file-read rewrite). */
export function formatShrinkSummary(result: ShrinkResult, subject: string): { summary: string; dataUrl: string } {
  const saved = result.originalBytes - result.shrunkBytes
  const pct = Math.round((saved / result.originalBytes) * 100)
  const summary =
    `token-goat shrank ${subject}: ` +
    `${toKB(result.originalBytes)}kb -> ${toKB(result.shrunkBytes)}kb ` +
    `(${pct}% smaller, ${result.width}x${result.height} ${result.format}).`
  const dataUrl = `data:image/${result.format};base64,${result.data.toString('base64')}`
  return { summary, dataUrl }
}

/**
 * Minimal structural type for the `sharp` API surface we use.
 *
 * Declared locally so the module type-checks even when `@types/sharp` (bundled
 * with sharp itself) is absent, and so the lazy `import()` result can be
 * narrowed without `any`.
 */
interface SharpInstance {
  metadata(): Promise<{ width?: number; height?: number; format?: string; pages?: number }>
  resize(opts: { width: number; height: number; fit: 'inside'; withoutEnlargement: boolean }): SharpInstance
  rotate(): SharpInstance
  jpeg(opts: { quality: number; mozjpeg: boolean }): SharpInstance
  webp(opts: { quality: number }): SharpInstance
  toBuffer(): Promise<Buffer>
}
type SharpFactory = (
  input: Buffer,
  options?: { limitInputPixels?: number | false; animated?: boolean },
) => SharpInstance

/** Load `sharp` lazily, returning null (and logging once) when unavailable -- e.g. a missing/incompatible native binary. */
const loadSharp = createLazyModuleLoader(async () => {
  const mod = (await import('sharp')) as unknown as { default: SharpFactory }
  return mod.default
}, 'image shrink disabled (sharp unavailable)')

/** True when `p` has a recognised image extension (case-insensitive). */
export function isImagePath(p: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(p).toLowerCase())
}

/**
 * Shrink an image buffer to fit within `maxDimension` on its longest edge and
 * re-encode it, choosing JPEG or WebP — whichever is smaller.
 *
 * Returns `null` (no shrink) when:
 *   - the input is already below `sizeThresholdBytes`,
 *   - `sharp` is unavailable,
 *   - the image cannot be decoded, or
 *   - the re-encoded result is not actually smaller than the input.
 *
 * `withoutEnlargement` keeps images already under `maxDimension` at their
 * native size; `rotate()` bakes in EXIF orientation before stripping metadata.
 */
export async function shrinkImage(
  input: Buffer,
  opts?: {
    maxDimension?: number
    quality?: number
    sizeThresholdBytes?: number
  },
): Promise<ShrinkResult | null> {
  const cfg = loadConfig().image_shrink
  const maxDimension = opts?.maxDimension ?? DEFAULT_MAX_DIMENSION
  const quality = opts?.quality ?? cfg.jpeg_quality
  const sizeThreshold = opts?.sizeThresholdBytes ?? DEFAULT_SIZE_THRESHOLD_BYTES
  // max_image_pixels is sharp's decode-time decompression-bomb guard (mirrors Python's Image.MAX_IMAGE_PIXELS), not the resize target — the resize edge is always DEFAULT_MAX_DIMENSION (Claude Vision's fixed optimum, never configurable in the original Python port either). 0 means "no cap", matching the original TOKEN_GOAT_MAX_IMAGE_PIXELS semantics.
  const limitInputPixels = cfg.max_image_pixels > 0 ? cfg.max_image_pixels : false

  const originalBytes = input.length
  if (originalBytes < sizeThreshold) return null

  const sharp = await loadSharp()
  if (sharp === null) return null

  try {
    // Multi-frame formats (animated GIF/WEBP, multi-page TIFF) decode only page 0 by default — sharp's `animated: true` decodes every frame instead, stacked into one "toilet roll" image that resize()/encode calls handle per-frame. `pages` is populated by a cheap header-only metadata read regardless of the animated option, so this detects multi-frame input before either full decode below without paying for a second full decode.
    const inputMeta = await sharp(input, { limitInputPixels }).metadata()
    const isAnimated = (inputMeta.pages ?? 1) > 1

    // Encode candidates from independent pipelines (a sharp instance is single-shot once consumed) and keep the smaller output. JPEG has no multi-frame container: encoding an animated decode to JPEG would either silently drop every frame but the first, or — once decoded with every frame via animated:true — emit a corrupted vertical stack of all of them. So an animated input only ever gets the WEBP candidate, which does preserve it.
    const webpBuf = await sharp(input, { limitInputPixels, animated: isAnimated })
      .rotate()
      .resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true })
      .webp({ quality })
      .toBuffer()
    let data = webpBuf
    let format = 'webp'

    if (!isAnimated) {
      const jpegBuf = await sharp(input, { limitInputPixels })
        .rotate()
        .resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer()
      if (jpegBuf.length < webpBuf.length) {
        data = jpegBuf
        format = 'jpeg'
      }
    }

    // Never enlarge: if neither re-encode beat the original, leave it alone.
    if (data.length >= originalBytes) return null

    const meta = await sharp(data).metadata()
    return {
      data,
      originalBytes,
      shrunkBytes: data.length,
      width: meta.width ?? 0,
      height: meta.height ?? 0,
      format,
    }
  } catch {
    // Undecodable / unsupported input: treat as not-shrinkable.
    return null
  }
}

/**
 * pre_tool_use handler for Read on image files.
 *
 * Passes through unless the target is an image at or above the size
 * threshold OR whose longest edge exceeds `DEFAULT_MAX_DIMENSION` — a small,
 * highly-compressible PNG (e.g. a large flat-color screenshot) can sail under
 * the byte threshold on disk while still decoding to well beyond Claude
 * Vision's optimal edge, and Claude Code's own internal re-encode for vision
 * then inflates it far past its on-disk size. When the byte size alone
 * doesn't already qualify the file, a cheap header-only `sharp().metadata()`
 * probe checks the decoded dimensions before falling through to a pass.
 * On a successful shrink it returns a `context` output carrying the shrunk
 * image as a base64 data URL plus a one-line savings summary, so the model
 * sees the cheaper image instead of the original. Any failure (non-image,
 * small file/dimensions, unreadable, sharp unavailable, no net saving) is a
 * pass — the hook never blocks a Read.
 */
export async function preReadImageHandler(event: HookEvent): Promise<HookOutput> {
  if (loadConfig().image_shrink.enabled === false) return passOutput()

  const filePath = getFilePath(event)
  if (filePath === undefined) return passOutput()
  if (!isImagePath(filePath)) return passOutput()

  const size = statSize(filePath)
  if (size === null) return passOutput()

  let input: Buffer | null = null
  let qualifies = size >= DEFAULT_SIZE_THRESHOLD_BYTES

  if (!qualifies) {
    // Under the byte threshold: probe decoded dimensions before giving up on
    // this file. The probe reads the file once and reuses that same buffer
    // for the shrink below on a hit, so a qualifying file is never read twice.
    try {
      input = fs.readFileSync(filePath)
    } catch {
      return passOutput()
    }

    const sharp = await loadSharp()
    if (sharp === null) return passOutput()

    try {
      const cfg = loadConfig().image_shrink
      const limitInputPixels = cfg.max_image_pixels > 0 ? cfg.max_image_pixels : false
      const meta = await sharp(input, { limitInputPixels }).metadata()
      const longestEdge = Math.max(meta.width ?? 0, meta.height ?? 0)
      qualifies = longestEdge > DEFAULT_MAX_DIMENSION
    } catch {
      // Undecodable / unsupported input: treat as not-shrinkable, same as shrinkImage's own convention.
      return passOutput()
    }
  }

  if (!qualifies) return passOutput()

  if (input === null) {
    try {
      input = fs.readFileSync(filePath)
    } catch {
      return passOutput()
    }
  }

  const result = await shrinkImage(input, { sizeThresholdBytes: 0 })
  if (result === null) return passOutput()

  const basename = path.basename(filePath)

  // OCR runs on the already-shrunk bytes, not the raw file: it is resized to Claude Vision's
  // optimal edge already (plenty of resolution for legible screenshot text) and is much
  // cheaper to hand to a subprocess than the original, sometimes-many-MB source. A text-heavy
  // result REPLACES the shrunk-image output below rather than supplementing it -- the whole
  // point is to avoid spending vision tokens on pixels the model would only reconstruct back
  // into this same text. Any failure here (dep unavailable, low confidence, short text, OCR
  // subprocess timeout/crash) is silently absorbed by ocrImage/isTextHeavy and this handler
  // falls through to the existing pixel-shrink path unchanged -- zero regression risk to the
  // image-shrink feature this OCR path sits on top of.
  if (loadConfig().image_shrink.ocr_enabled) {
    const ocr = await ocrImage(result.data)
    if (ocr !== null && isTextHeavy(ocr, loadConfig().image_shrink.ocr_min_confidence)) {
      // Measured against the shrunk image bytes (the realistic alternative this branch
      // preempts), not the original file -- the shrink-step savings are already attributed
      // to the 'image_shrink' stat kind above; this avoids double-counting the same bytes
      // under two stat rows.
      const textBytes = Buffer.byteLength(ocr.text, 'utf8')
      const saved = Math.max(0, result.shrunkBytes - textBytes)
      recordStat('image_ocr', saved, Math.round(saved / 4), undefined, basename)
      return contextOutput(formatOcrSummary(ocr, basename, result.originalBytes))
    }
  }

  const saved = result.originalBytes - result.shrunkBytes
  const { summary, dataUrl } = formatShrinkSummary(result, basename)

  // The Python original (hooks_read.py) recorded this under 'image_shrink' via an exact vision-token delta (Claude's per-tile token cost at the pre/post dimensions); that formula was never ported to shrinkImage's return shape, so this uses the same bytes/4 token-cost approximation the rest of this TS codebase already applies to savings it can't cost in exact tokens (see hooks_read.ts's session_hint calls). This call was dropped entirely during the Python->TS port -- restoring it is what makes 'image_shrink' rows (and the flagship image-shrink savings figure derived from them) appear in `token-goat stats --full` again.
  recordStat('image_shrink', saved, Math.round(saved / 4), undefined, basename)

  return contextOutput(`${summary}\n${dataUrl}`)
}

registerHook('pre_tool_use', preReadImageHandler, { toolName: 'Read' })
