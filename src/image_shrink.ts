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
import { statSize, toKB } from './util.js'
import { getFilePath } from './hooks_common.js'
import type { HookEvent } from './hook_registry.js'
import { registerHook } from './hook_registry.js'
import { contextOutput, passOutput } from './hooks_common.js'
import { recordStat } from './stats.js'
import type { HookOutput } from './types.js'

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

/**
 * Cached lazy import of `sharp`.
 *
 * `undefined` until first attempted; `null` once an import failure is recorded
 * (so we do not re-pay the failing import on every image). Resolved once
 * because the native module's availability does not change within a process.
 */
let _sharpCache: SharpFactory | null | undefined

/** Load `sharp` lazily, returning null (and logging once) when unavailable. */
async function loadSharp(): Promise<SharpFactory | null> {
  if (_sharpCache !== undefined) return _sharpCache
  try {
    const mod = (await import('sharp')) as unknown as { default: SharpFactory }
    _sharpCache = mod.default
  } catch (err) {
    // Native binary missing or incompatible: degrade gracefully for the rest of the process. One warning is enough; the hot path stays silent.
    process.stderr.write(`token-goat: image shrink disabled (sharp unavailable): ${String(err)}\n`)
    _sharpCache = null
  }
  return _sharpCache
}

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
  // max_image_pixels is sharp's decode-time decompression-bomb guard (mirrors
  // Python's Image.MAX_IMAGE_PIXELS), not the resize target — the resize edge
  // is always DEFAULT_MAX_DIMENSION (Claude Vision's fixed optimum, never
  // configurable in the original Python port either). 0 means "no cap",
  // matching the original TOKEN_GOAT_MAX_IMAGE_PIXELS semantics.
  const limitInputPixels = cfg.max_image_pixels > 0 ? cfg.max_image_pixels : false

  const originalBytes = input.length
  if (originalBytes < sizeThreshold) return null

  const sharp = await loadSharp()
  if (sharp === null) return null

  try {
    // Multi-frame formats (animated GIF/WEBP, multi-page TIFF) decode only page 0
    // by default — sharp's `animated: true` decodes every frame instead, stacked
    // into one "toilet roll" image that resize()/encode calls handle per-frame.
    // `pages` is populated by a cheap header-only metadata read regardless of the
    // animated option, so this detects multi-frame input before either full
    // decode below without paying for a second full decode.
    const inputMeta = await sharp(input, { limitInputPixels }).metadata()
    const isAnimated = (inputMeta.pages ?? 1) > 1

    // Encode candidates from independent pipelines (a sharp instance is single-shot once consumed) and keep the smaller output.
    // JPEG has no multi-frame container: encoding an animated decode to JPEG would
    // either silently drop every frame but the first, or — once decoded with every
    // frame via animated:true — emit a corrupted vertical stack of all of them. So
    // an animated input only ever gets the WEBP candidate, which does preserve it.
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
 * Passes through unless the target is an image at or above the size threshold.
 * On a successful shrink it returns a `context` output carrying the shrunk
 * image as a base64 data URL plus a one-line savings summary, so the model
 * sees the cheaper image instead of the original. Any failure (non-image,
 * small file, unreadable, sharp unavailable, no net saving) is a pass — the
 * hook never blocks a Read.
 */
export async function preReadImageHandler(event: HookEvent): Promise<HookOutput> {
  if (loadConfig().image_shrink.enabled === false) return passOutput()

  const filePath = getFilePath(event)
  if (filePath === undefined) return passOutput()
  if (!isImagePath(filePath)) return passOutput()

  const size = statSize(filePath)
  if (size === null || size < DEFAULT_SIZE_THRESHOLD_BYTES) return passOutput()

  let input: Buffer
  try {
    input = fs.readFileSync(filePath)
  } catch {
    return passOutput()
  }

  const result = await shrinkImage(input)
  if (result === null) return passOutput()

  const saved = result.originalBytes - result.shrunkBytes
  const pct = Math.round((saved / result.originalBytes) * 100)
  const dataUrl = `data:image/${result.format};base64,${result.data.toString('base64')}`
  const summary =
    `token-goat shrank ${path.basename(filePath)}: ` +
    `${toKB(result.originalBytes)}kb -> ${toKB(result.shrunkBytes)}kb ` +
    `(${pct}% smaller, ${result.width}x${result.height} ${result.format}).`

  // The Python original (hooks_read.py) recorded this under 'image_shrink' via an exact
  // vision-token delta (Claude's per-tile token cost at the pre/post dimensions); that
  // formula was never ported to shrinkImage's return shape, so this uses the same
  // bytes/4 token-cost approximation the rest of this TS codebase already applies to
  // savings it can't cost in exact tokens (see hooks_read.ts's session_hint calls).
  // This call was dropped entirely during the Python->TS port -- restoring it is what
  // makes 'image_shrink' rows (and the flagship image-shrink savings figure derived
  // from them) appear in `token-goat stats --full` again.
  recordStat('image_shrink', saved, Math.round(saved / 4), undefined, path.basename(filePath))

  return contextOutput(`${summary}\n${dataUrl}`)
}

registerHook('pre_tool_use', preReadImageHandler, { toolName: 'Read' })
