/** Image shrink — intercept large images before they reach the model. Ports the load-bearing slice of `image_shrink.py` to the TypeScript hook surface. Large images cost many vision tokens; downscaling to Claude's optimal Vision dimension and re-encoding to JPEG (or WebP when that is smaller) typically cuts the byte count — and the token cost — by more than half with no perceptible quality loss at reading distance. The image shrink subsystem uses an internal pure TypeScript/JavaScript image engine (`src/image_engine.ts`) running inside V8's memory-safe sandbox with zero native C compilation and zero libvips dependencies. If an image is unreadable or corrupt, {@link shrinkImage} degrades to a no-op (returns null) and {@link preReadImageHandler} passes through rather than crashing the hook. */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { IMAGE_EXTENSIONS, isImagePath } from './asset_extensions.js'
import { loadConfig, type VisionTier } from './config.js'
import { DEFAULT_MAX_AGE_MS, tokenGoatHome } from './disk_cache.js'
import {
  applyExifOrientation,
  type DecodedImage,
  type ImageMeta,
  probeBufferMeta,
  decodePng,
  encodePng,
  decodeJpeg,
  encodeJpeg,
  decodeBmp,
  decodeGif,
  resizeRgba,
  calculateFitInside,
} from './image_engine.js'
import { ensureDirSync, atomicWriteBytes, toKB } from './util.js'
import { getCwd, getFilePath } from './hooks_common.js'
import { preToolPathDeclined, vscodePathAllowed } from './vscode_path_gate.js'
import type { HookEvent } from './hook_registry.js'
import { registerHook } from './hook_registry.js'
import { VSCODE_TOOL_NAME_KEY } from './hooks_cli.js'
import { contextOutput, passOutput } from './hooks_common.js'
import { materializeShrunkImageFile } from './bridges/vscode_hooks.js'
import { detectHarness } from './bridges/registry.js'
import { loadingHiddenRuleCheck, permissionNeutralRewrite } from './rewrite_permission.js'
import type { HarnessName } from './bridges/types.js'
import { displaySafePath } from './paths.js'
import { recordFileRead } from './session.js'
import { recordStat, savedTokensFromBytes } from './stats.js'
import type { HookOutput } from './types.js'

/** Long-edge resize target. 1568 is Claude's Standard resolution tier maximum; Claude 4.7 and later run a High-resolution tier whose maximum is 2576, so this is a conservative floor that every tier accepts rather than a universal optimum. It also divides evenly into Anthropic's 28px patch grid (56) and OpenAI's 32px one (49). */
const DEFAULT_MAX_DIMENSION = 1568

/** Anthropic bills an image as a grid of 28x28-pixel patches, one visual token per patch, so an image costs `ceil(width / 28) * ceil(height / 28)` tokens. Every constant and every step of the arithmetic below is transcribed from Anthropic's own published rule and reference implementation: https://platform.claude.com/docs/en/build-with-claude/vision#evaluate-image-size and https://platform.claude.com/docs/en/build-with-claude/vision-coordinates#how-claude-resizes-and-pads-images This exists because the byte count an image shrink saves is not what an image is billed in. A saving is only real in the unit that bills, and bytes are not that unit for pixels. */
const VISION_PATCH_PX = 28

/** Per-tier limits, from the "Resolution and token cost" table in Anthropic's vision documentation. High-resolution covers Claude 4.7 and later; Standard covers every other model. */
const VISION_TIER_LIMITS: Readonly<Record<VisionTier, { readonly maxEdge: number; readonly maxTokens: number }>> = {
  standard: { maxEdge: 1568, maxTokens: 1568 },
  high: { maxEdge: 2576, maxTokens: 4784 },
}

/** Visual tokens an image of these exact dimensions costs, with no resize applied. */
function countImagePatches(width: number, height: number): number {
  return Math.ceil(width / VISION_PATCH_PX) * Math.ceil(height / VISION_PATCH_PX)
}

/** Round half to even (banker's rounding), matching Python's `round()`. Anthropic's reference implementation is explicit that the live API resolves exact .5 ties toward the even neighbour, so `Math.round` -- which rounds halves up -- computes a different resized size for some images. */
function roundTiesToEven(value: number): number {
  const floor = Math.floor(value)
  if (value - floor !== 0.5) return Math.round(value)
  return floor % 2 === 0 ? floor : floor + 1
}

/** Whether an image of this size is served as-is: both padded edges within the tier's edge limit, and the patch count within its token budget. The edge test is on the PADDED edge (`ceil(w / 28) * 28`), not the raw one, because the API pads every image up to the next patch boundary before measuring. */
function fitsVisionLimits(width: number, height: number, maxEdge: number, maxTokens: number): boolean {
  return (
    Math.ceil(width / VISION_PATCH_PX) * VISION_PATCH_PX <= maxEdge &&
    Math.ceil(height / VISION_PATCH_PX) * VISION_PATCH_PX <= maxEdge &&
    countImagePatches(width, height) <= maxTokens
  )
}

/** The dimensions the API resizes an image to before billing it: the largest aspect-preserving size that satisfies both tier limits. A direct port of Anthropic's published TypeScript reference implementation, binary search included -- scaling to the edge limit by hand gets this wrong, since for nearly every photo and screenshot it is the token budget rather than the edge that binds (a 1920x1080 screenshot resizes to 1456x819 on the Standard tier, not to 1568x882). */
function resizedForVision(width: number, height: number, maxEdge: number, maxTokens: number): [number, number] {
  if (fitsVisionLimits(width, height, maxEdge, maxTokens)) return [width, height]
  if (height > width) {
    const [resizedH, resizedW] = resizedForVision(height, width, maxEdge, maxTokens)
    return [resizedW, resizedH]
  }
  const aspectRatio = width / height
  let lo = 1
  let hi = width
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (fitsVisionLimits(mid, Math.max(roundTiesToEven(mid / aspectRatio), 1), maxEdge, maxTokens)) lo = mid
    else hi = mid
  }
  return [lo, Math.max(roundTiesToEven(lo / aspectRatio), 1)]
}

/** Visual tokens an image of `width` x `height` actually costs on `tier`, after the API's own downscale. The downscale is the whole point of routing through this rather than multiplying out the raw dimensions: the API caps an oversized image's cost itself, so a saving measured against the untouched original is measured against a bill that is never sent. On the Standard tier a 4K screenshot and a 1080p screenshot cost the identical 1560 tokens, and shrinking the former to 1568px wide saves nothing at all in the unit that bills. Returns 0 for a non-positive or non-finite size rather than throwing: dimensions reach here from image metadata that a decoder may not have populated, and a stat row must never be the thing that fails a read. */
export function visionTokens(width: number, height: number, tier: VisionTier): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return 0
  const limits = VISION_TIER_LIMITS[tier]
  const [w, h] = resizedForVision(Math.floor(width), Math.floor(height), limits.maxEdge, limits.maxTokens)
  return countImagePatches(w, h)
}

/** Visual tokens saved by showing the model a `toWidth` x `toHeight` image where it would otherwise have been shown a `fromWidth` x `fromHeight` one. Clamped at zero: a "shrink" that costs more visual tokens than it saves is not a negative saving to be booked, it is a branch that should not have been taken. */
export function visionTokensSaved(fromWidth: number, fromHeight: number, toWidth: number, toHeight: number, tier: VisionTier): number {
  return Math.max(0, visionTokens(fromWidth, fromHeight, tier) - visionTokens(toWidth, toHeight, tier))
}

/** The most visual tokens any single image can cost at this tier. The honest ceiling for a caller that emits text in place of an image but never learns the image's pixel dimensions. Crediting a byte count there would invent a number: the alternative the caller preempted was one image, and one image cannot bill more than this. */
export function visionTierMaxTokens(tier: VisionTier): number {
  return VISION_TIER_LIMITS[tier].maxTokens
}

/** Visual tokens saved by emitting `emittedBytes` of text where the model would otherwise have been shown a `width` x `height` image. The single definition of the image-for-text trade. The two sides are deliberately priced by different rules because they are different units: the image side in visual tokens (28x28-pixel patches, the unit the API actually bills), the text side by the repo-wide bytes/4 text approximation. Pricing the image side in bytes -- an image is not text, and its byte size has no relationship to what it costs -- is the accounting error this helper exists to stop repeating. Pass `null` dimensions when they are genuinely unavailable and the tier ceiling is used instead. */
export function visionTokensSavedByText(width: number | null, height: number | null, emittedBytes: number, tier: VisionTier): number {
  const imageSide = width === null || height === null ? visionTierMaxTokens(tier) : visionTokens(width, height, tier)
  return Math.max(0, imageSide - savedTokensFromBytes(emittedBytes))
}

/** Below this byte count an image is left untouched (encode CPU > savings). */
const DEFAULT_SIZE_THRESHOLD_BYTES = 512 * 1024

/** Every format the engine can decode to RGBA, and how. `probeImageMeta` reads headers for more formats than this -- webp, tiff and friends -- so the two lists must be asked separately: a probe that succeeds says only that the dimensions are known, never that a re-encode is possible. Callers derive {@link canShrinkFormat} from these keys rather than listing the formats again. When the dispatch was an if/else chain, `image-meta` answered "Shrink: no benefit (already small/optimal)" for a 3000x3000 webp, reporting a missing decoder as a measured verdict. */
const SINGLE_FRAME_DECODERS = new Map<string, (input: Buffer) => DecodedImage | null>([
  ['png', (input) => decodePng(input)],
  ['jpeg', (input) => decodeJpeg(input)],
  ['bmp', (input) => decodeBmp(input)],
  // The still-image path wants frame 0 and nothing else. Decoding the whole animation to index into it costs a full canvas per frame for frames that are then dropped, and a file can declare far more of them than it contains pixels.
  ['gif', (input) => {
    const decoded = decodeGif(input, { maxFrames: 1 })
    const frame = decoded.frames[0]
    return frame === undefined ? null : { data: frame.data, width: frame.width, height: frame.height }
  }],
])

/** Whether the engine has a decoder for `format`, i.e. whether a shrink is even attemptable. A `false` here is a capability limit, not a measurement: it must never be reported as "no benefit". A Map rather than an object literal, so a format spelled `constructor` or `toString` answers no instead of resolving off Object.prototype and handing a Function to the decode call. */
export function canShrinkFormat(format: string | null | undefined): boolean {
  return format != null && SINGLE_FRAME_DECODERS.has(format)
}

/** Why the decoder for `format` refuses `input`, or null when it decodes it (or there is no decoder). `shrinkImage` folds a refused decode into the same null a measured no-benefit returns, so a caller that must tell the two apart, `image-meta`, asks here: a 16-bit or interlaced PNG is a capability limit, not a verdict that the image is already small. */
export function decoderRefusal(input: Buffer, format: string | null | undefined): string | null {
  const decode = SINGLE_FRAME_DECODERS.get(format ?? '')
  if (decode === undefined) return null
  try {
    decode(input)
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

/** Telemetry returned for a successful shrink. */
export interface ShrinkResult {
  /** Re-encoded image bytes. */
  readonly data: Buffer
  /** Byte count of the original input. */
  readonly originalBytes: number
  /** Byte count after shrinking. */
  readonly shrunkBytes: number
  /** Input width in pixels, before the resize. Carried so a caller can price the shrink in visual tokens (see {@link visionTokensSaved}) rather than in bytes, which is not the unit an image is billed in. Read before `.rotate()` applies EXIF orientation, so for a rotated source this pair may be transposed relative to what the model would have seen -- harmless here, because a patch count multiplies its two axes and is therefore identical either way round. */
  readonly originalWidth: number
  /** Input height in pixels, before the resize. See {@link ShrinkResult.originalWidth}. */
  readonly originalHeight: number
  /** Output width in pixels. */
  readonly width: number
  /** Output height in pixels. */
  readonly height: number
  /** Output container format: `jpeg`, `png`, or `gif`. */
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

// Re-exported rather than defined here: the single list now lives in the leaf module asset_extensions.ts, which src/parser.ts can also import (it cannot import this file). Kept exported from here so the existing importers (hooks_read.ts, read_commands.ts) are unchanged.
export { IMAGE_EXTENSIONS, isImagePath }

/** Sentinel thrown by {@link probeImageMeta} when bytes will not decode as a valid image or exceed pixel limit. */
export class ImageDecodeError extends Error {}

/** Header-only probe of every format token-goat can describe. AVIF/HEIC/HEIF are probe-only (no decoder, so `canShrinkFormat` is false and every shrink path passes them through), and their parser loads only when the bytes open with an ISO-BMFF `ftyp` box, which keeps it out of the hook entry's eager set. */
async function probeAnyMeta(input: Buffer): Promise<ImageMeta | null> {
  const meta = probeBufferMeta(input)
  if (meta !== null || input.length < 16 || input.toString('latin1', 4, 8) !== 'ftyp') return meta
  const { probeIsoBmffMeta } = await import('./image_isobmff.js')
  const isoBmff = probeIsoBmffMeta(input)
  return isoBmff === null ? null : { ...isoBmff, pages: 1 }
}

export async function probeImageMeta(input: Buffer): Promise<{ width: number; height: number; format: string | null; pages: number; orientation?: number } | null> {
  const meta = await probeAnyMeta(input)
  if (meta === null) {
    throw new ImageDecodeError('image could not be decoded')
  }
  const cfg = loadConfig().image_shrink
  const limitInputPixels = cfg.max_image_pixels > 0 ? cfg.max_image_pixels : false
  if (limitInputPixels !== false && (meta.width * meta.height) > limitInputPixels) {
    throw new ImageDecodeError(`Input image exceeds pixel limit ${limitInputPixels}`)
  }
  return {
    width: meta.width,
    height: meta.height,
    format: meta.format,
    pages: meta.pages,
    ...(meta.orientation === undefined ? {} : { orientation: meta.orientation }),
  }
}

/** Whether the header's declared pixel count alone is why `probeImageMeta` would throw for `input` -- computed independently (and before) that throw, off the same header-only `probeAnyMeta` read, so a caller can tell "over the configured limit" apart from every other decode failure and record it as its own event rather than folding it into a generic skip. */
async function exceedsConfiguredPixelLimit(input: Buffer): Promise<boolean> {
  const meta = await probeAnyMeta(input)
  if (meta === null) return false
  const cfg = loadConfig().image_shrink
  const limitInputPixels = cfg.max_image_pixels > 0 ? cfg.max_image_pixels : false
  return limitInputPixels !== false && meta.width * meta.height > limitInputPixels
}

/** True when `input` is worth spending a re-encode on. Files under {@link DEFAULT_SIZE_THRESHOLD_BYTES} qualify only if their pixel dimensions exceed {@link DEFAULT_MAX_DIMENSION} on their longest edge. */
export async function imageQualifiesForShrink(input: Buffer): Promise<boolean> {
  try {
    const meta = await probeImageMeta(input)
    if (meta === null) return false
    // Size alone used to be enough to qualify, which certified a candidate the re-encode could never accept: a large webp or tiff probes fine, has no decoder, and came back as a declined shrink. That put a permanent capability limit into image_shrink_skipped, whose whole job is to say whether the thresholds are tuned right.
    if (!canShrinkFormat(meta.format)) return false
    if (input.length >= DEFAULT_SIZE_THRESHOLD_BYTES) return true
    return Math.max(meta.width, meta.height) > DEFAULT_MAX_DIMENSION
  } catch {
    return false
  }
}

/** Shrink an image buffer to fit within `maxDimension` on its longest edge and re-encode it, choosing JPEG or PNG — whichever is smaller. Pure TypeScript / JavaScript implementation: zero native libvips binaries, zero C memory corruption vulnerabilities. Returns `null` (no shrink) when: - the input is already below `sizeThresholdBytes`, - the image cannot be decoded, or - the re-encoded result is not actually smaller than the input. */
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

  const originalBytes = input.length
  if (originalBytes < sizeThreshold) return null

  let inputMeta: { width: number; height: number; format: string | null; pages: number; orientation?: number } | null
  try {
    inputMeta = await probeImageMeta(input)
  } catch {
    return null
  }
  if (!inputMeta || inputMeta.width <= 0 || inputMeta.height <= 0) return null

  try {
    const isAnimated = (inputMeta.pages ?? 1) > 1
    const { width: targetW, height: targetH } = calculateFitInside(inputMeta.width, inputMeta.height, maxDimension)

    // Animated GIF handling
    if (isAnimated && inputMeta.format === 'gif') {
      const decodedGif = decodeGif(input)
      // Dynamically imported so the animated-GIF encoder stays out of the hook entry's eager set. A rejected import (missing chunk, corrupt install) lands in this function's own catch below and returns null, which is the same pass-through the size guard two lines down takes, so a failure here ships the original image rather than a broken one.
      const { encodeAnimatedGifDelta } = await import('./image_gif_encode.js')
      const data = encodeAnimatedGifDelta(decodedGif, targetW, targetH)
      if (data.length >= originalBytes) return null
      return {
        data,
        originalBytes,
        shrunkBytes: data.length,
        originalWidth: inputMeta.width,
        originalHeight: inputMeta.height,
        width: targetW,
        height: targetH,
        format: 'gif',
      }
    }

    // Single-frame image handling
    const decode = SINGLE_FRAME_DECODERS.get(inputMeta.format ?? '')
    if (!decode) return null
    const decoded = decode(input)
    if (decoded === null) return null

    // The decoder's own dimensions, not the probe's: for EXIF orientations 5-8 the probe reports display geometry, and reading this buffer at that stride shears every row. Rotating here is the only way the orientation survives, since the re-encode below writes no EXIF block.
    const oriented = applyExifOrientation(decoded.data, decoded.width, decoded.height, inputMeta.orientation)
    const dstRgba = resizeRgba(oriented.data, oriented.width, oriented.height, targetW, targetH)

    const jpegBuf = encodeJpeg(targetW, targetH, dstRgba, quality)
    const pngBuf = encodePng(targetW, targetH, dstRgba)

    let data = jpegBuf
    let format = 'jpeg'
    if (pngBuf.length < jpegBuf.length) {
      data = pngBuf
      format = 'png'
    }

    if (data.length >= originalBytes) return null

    return {
      data,
      originalBytes,
      shrunkBytes: data.length,
      originalWidth: inputMeta.width,
      originalHeight: inputMeta.height,
      width: targetW,
      height: targetH,
      format,
    }
  } catch {
    return null
  }
}

/** Best-effort file size and mtime in one stat call, or null when the path cannot be stat'd or isn't a regular file. */
function statInfo(absPath: string): { size: number; mtimeMs: number } | null {
  try {
    const st = fs.statSync(absPath)
    return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null
  } catch {
    return null
  }
}

/** Directory the shrunk-image re-encode cache lives under: `<home>/image_shrink_cache`. Its own dedicated subdir of token-goat home (not the OS temp dir, and not disk_cache.ts's JSON blob store -- see the module docblock above `findCachedShrink`), so pruning can be scoped to a directory nothing else writes into. */
function imageShrinkCacheDir(): string {
  return path.join(tokenGoatHome(), 'image_shrink_cache')
}

/** Cache key for a shrunk re-encode: sha256 of `path:size:mtimeMs:quality`, truncated to 16 hex chars (64 bits). mtime is part of the key -- not just path + size -- so a content change that happens to preserve the exact byte length (e.g. regenerating a same-dimension screenshot) still busts the cache instead of silently serving a stale shrink. The encode quality is part of it for the same reason from the other direction: it is the one input that changes the bytes without changing the source file at all, so a key without it made `image_shrink.jpeg_quality` dead config for every image already in the cache -- measured at a 23x spread (64 KB at quality 10 against 1.5 MB at quality 95 for the same screenshot) that a warm cache flattened to a single stale encode. Entries written under the old key are simply never found again and age out on the existing prune. 64 bits of hash keeps collisions negligible for this cache's realistic working set: entries are pruned after DEFAULT_MAX_AGE_MS, so the live set at any moment is bounded by how many distinct images get read in that window, not by the process's lifetime total -- nowhere close to the ~2^32 items a 64-bit hash would need before collisions become likely by the birthday bound. The key already domain-separates by full source path, so a collision would additionally require two different paths to also match on size+mtime. */
/** Bump whenever the engine starts producing different pixels for an unchanged input file. Nothing else in the key moves when the code does, so without this an entry garbled by a shipped defect keeps being served from disk until DEFAULT_MAX_AGE_MS retires it -- the fix reaches new files only. Revision 2: EXIF orientation is now baked into the pixels. Revision 3: animated GIFs re-encode as delta frames against one global palette. */
export const SHRINK_ENGINE_REVISION = 3

/** Exported so a test can hold every other input fixed and vary only the revision, which is the one property the salt has to have. */
export function shrinkCacheKeyForRevision(revision: number, originalPath: string, size: number, mtimeMs: number, quality: number): string {
  return createHash('sha256').update(`r${revision}:${originalPath}:${size}:${mtimeMs}:${quality}`).digest('hex').slice(0, 16)
}

function shrinkCacheKey(originalPath: string, size: number, mtimeMs: number, quality: number): string {
  return shrinkCacheKeyForRevision(SHRINK_ENGINE_REVISION, originalPath, size, mtimeMs, quality)
}

/** Output format to the extension its cache entry is stored under, and back again. The cache used to know two formats because sharp only ever produced two. The pure-TypeScript engine emits `png` and `gif` as well and produces `webp` never, so an entry written under the old rule -- jpeg gets `.jpg`, everything else gets `.webp` -- came back claiming to be a WebP while holding PNG or GIF bytes. That label is not cosmetic: it becomes the `data:image/...` MIME type the model is handed, and the extension `screenshot.ts` saves the file under. `.webp` stays readable and is no longer written. Entries from before this change are on disk and really are WebP, so recognising them is correct; producing a new one is not possible. */
const SHRINK_CACHE_EXTENSION: ReadonlyMap<string, string> = new Map([
  ['jpeg', '.jpg'],
  ['png', '.png'],
  ['gif', '.gif'],
])

const SHRINK_CACHE_FORMAT: ReadonlyMap<string, string> = new Map([
  ['.jpg', 'jpeg'],
  ['.png', 'png'],
  ['.gif', 'gif'],
  ['.webp', 'webp'],
])

/** Look for an already-cached re-encode of this exact (path, size, mtime, quality). Checked BEFORE running the shrink so a repeat Read of an unchanged image can skip the re-encode entirely instead of always re-running it. A directory scan rather than two `existsSync` probes, because the entry's name now carries the ORIGINAL image's dimensions as well as the output format, and neither is known ahead of the lookup. Those dimensions are what lets a cache hit price its saving in the unit an image is actually billed in: this path never decodes the original, so without them the branch could only report a zero visual-token saving on every hit -- an entire mechanism reading as worthless in `token-goat stats` while doing exactly the same work as the miss path beside it. The scan costs nothing measurable next to the readdir `pruneShrinkCache` already performs on the same directory one line earlier in the same handler. Entries written by an older version carry no dimensions, so they no longer match and are treated as a miss. That is a single re-encode per image, after which the sweep in `pruneShrinkCache` collects the stale file on age like any other. */
function findCachedShrink(originalPath: string, size: number, mtimeMs: number, quality: number): { filePath: string; format: string; originalWidth: number; originalHeight: number } | null {
  const prefix = `token-goat-shrink-${shrinkCacheKey(originalPath, size, mtimeMs, quality)}-`
  const dir = imageShrinkCacheDir()
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return null
  }
  for (const file of entries) {
    if (!file.startsWith(prefix)) continue
    const m = /^(\d+)x(\d+)(\.webp|\.jpg|\.png|\.gif)$/.exec(file.slice(prefix.length))
    if (m === null) continue
    const format = SHRINK_CACHE_FORMAT.get(m[3] ?? '')
    if (format === undefined) continue
    return {
      filePath: path.join(dir, file),
      format,
      originalWidth: Number(m[1]),
      originalHeight: Number(m[2]),
    }
  }
  return null
}

/** Write a shrink result's bytes to the cache, keyed by the source (path, size, mtime). Atomic (temp file + rename), so a reader never observes a partially-written cache entry. Best-effort: a write failure (permissions, disk full, ...) must never block returning the shrink result the caller already computed. */
function writeCachedShrink(originalPath: string, result: ShrinkResult, mtimeMs: number, quality: number): void {
  try {
    const dir = imageShrinkCacheDir()
    ensureDirSync(dir)
    const key = shrinkCacheKey(originalPath, result.originalBytes, mtimeMs, quality)
    // No entry at all beats one that will be read back under the wrong format. A miss costs a re-encode; a mislabelled hit is served to the model as a different image type than it is.
    const ext = SHRINK_CACHE_EXTENSION.get(result.format)
    if (ext === undefined) return
    atomicWriteBytes(path.join(dir, `token-goat-shrink-${key}-${result.originalWidth}x${result.originalHeight}${ext}`), result.data)
  } catch {
    // Best-effort; failing to cache must not block returning the freshly computed shrink.
  }
}

// Throttles pruneShrinkCache so a burst of Reads within the same process only sweeps the cache dir once instead of on every single call. Each hook invocation is normally its own fresh `token-goat hook <event>` process (see disk_cache.ts), so in production this already amounts to roughly once per hook call; the throttle mainly protects long-lived hosts (tests, a persistent worker) from re-scanning the cache dir on every image read.
const SHRINK_CACHE_PRUNE_THROTTLE_MS = 60_000
let lastShrinkCachePruneAtMs = 0

/** Test-only: force the next pruneShrinkCache() call to run instead of being throttled. */
export function resetShrinkCachePruneThrottleForTests(): void {
  lastShrinkCachePruneAtMs = 0
}

/** Best-effort sweep of this cache's own `token-goat-shrink-*` files older than DEFAULT_MAX_AGE_MS, so heavy image-reading does not accumulate them unbounded -- nothing else in this codebase ever removes them otherwise. Mirrors disk_cache.ts's age-based pruning convention (same DEFAULT_MAX_AGE_MS, same mtime-cutoff-then-delete shape) rather than inventing a new policy; disk_cache.ts's own `pruneBlobs` isn't reused directly because it is hardcoded to `.json` blobs written through `storeBlob`, which runs every value through `redactSecrets()` -- a text-oriented secret scan that is the wrong tool for, and could corrupt, base64-free binary image bytes. Scoped to `imageShrinkCacheDir()`, a dedicated subdir of token-goat home that nothing else writes into, and additionally filtered to this cache's own `token-goat-shrink-` filename prefix as defense in depth -- this sweep can never delete anything outside that. Never throws: a prune failure (permissions, a file removed by another process mid-sweep, ...) must never break the caller's actual image-shrink operation. */
function pruneShrinkCache(): void {
  const now = Date.now()
  if (now - lastShrinkCachePruneAtMs < SHRINK_CACHE_PRUNE_THROTTLE_MS) return
  lastShrinkCachePruneAtMs = now

  try {
    const dir = imageShrinkCacheDir()
    if (!fs.existsSync(dir)) return
    const cutoff = now - DEFAULT_MAX_AGE_MS
    for (const file of fs.readdirSync(dir)) {
      if (!file.startsWith('token-goat-shrink-')) continue
      const full = path.join(dir, file)
      try {
        const st = fs.statSync(full)
        if (st.mtimeMs < cutoff) fs.unlinkSync(full)
      } catch {
        // Best-effort per-file cleanup; one bad stat/unlink must not abort the sweep.
      }
    }
  } catch {
    // Best-effort; a readdir failure (e.g. permissions) must never break the caller's shrink.
  }
}

/** Shared tail of {@link preReadImageHandler}: saving accounting and the delivered output, given a {@link ShrinkResult} regardless of whether it came from a fresh `shrinkImage()` call or a cache hit. Keeping one code path here is what keeps a cache hit's `recordStat` honest -- it reports the same savings a fresh shrink would have, because the model receives the same bytes either way; only the (unmeasured) re-encode CPU cost differs, and this function has no visibility into that. */
/** Harnesses whose host writes the shrunk copy to a temp file in its own process (MATERIALIZE_SHRUNK_IMAGE_JS in bridges/shrink_block.ts, and pi.ts's typed twin) after this hook has answered. OpenClaw pins no harness when it calls the hook, so it is recognized from its environment or not at all. opencode is left out: its read tool asks the `read` permission against the path the plugin hands it, so a copy's temp path would slip past a rule on the original. */
const HOST_MATERIALIZED_HARNESSES: ReadonlySet<HarnessName> = new Set<HarnessName>(['copilot_cli', 'pi', 'openclaw'])

/** Harnesses whose PreToolUse honours a rewritten tool input, so this process writes the shrunk copy and points the read at it. Claude Code caps additionalContext at 10,000 characters (https://code.claude.com/docs/en/hooks), so the data URL the context channel used to carry there arrived as a 2,000-character base64 preview while the Read loaded the original. */
const PATH_REWRITE_HARNESSES: ReadonlySet<HarnessName> = new Set<HarnessName>(['vscode', 'claudecode'])

async function finalizeShrinkResult(result: ShrinkResult, filePath: string, event: HookEvent): Promise<HookOutput> {
  // The image's own file name, so a cloned repository chooses it; the summary below reaches the model on the context channel, which neither fences nor escapes the markers token-goat speaks in. Sanitized once here rather than at each use, which also keeps the stats label it feeds from carrying a forged field.
  const basename = displaySafePath(path.basename(filePath))

  const harness = detectHarness()
  if (PATH_REWRITE_HARNESSES.has(harness)) {
    // VS Code and Claude Code take the copy only as a rewritten Read/view_image path, so the file is written here, in the process that books the saving, and a failed write passes and books nothing. OCR is skipped: text beside the call cannot stop the Read loading the image, so it would only add to what the model receives.
    const file = materializeShrunkImageFile(formatShrinkSummary(result, basename).dataUrl)
    if (file === undefined) return passOutput()
    // Claude Code checks Read rules against the rewritten path, so a rule that could match the original or the copy keeps the original Read, and the copy is removed rather than left for the age sweep.
    const cwd = getCwd(event) ?? process.cwd()
    const rewrite = permissionNeutralRewrite({ ...event.toolInput, file_path: file }, { kind: 'read', harness, mode: event.raw['permission_mode'], cwd, original: filePath, rewritten: file, insideCwd: vscodePathAllowed(filePath, cwd) })
    if (rewrite === null) {
      try {
        fs.unlinkSync(file)
      } catch {
        // Left for pruneMaterialized's age sweep.
      }
      return passOutput()
    }
    if (deliveryReplacesRead(harness, rewrite)) recordSavedShrink(result, basename)
    // The session records the image asked for, not the copy: the post-read hook only sees the copy's temp path, and preReadHandler, which records every other Read, never runs once this handler answers.
    recordFileRead(filePath)
    return rewrite
  }
  // A host (or generic, an OpenClaw host that pinned no harness) writes the copy in its own process after this one has answered and falls back to the original image if that write fails, so this process never sees the delivery and books nothing. No OCR text either: the host finds no data URL in it and sends the original image, so the text would only add to what the model receives.
  const { summary, dataUrl } = formatShrinkSummary(result, basename)
  // Recorded for the same reason as the rewrite above: the host delivers the copy or falls back to the original, and either way the model has read this image.
  recordFileRead(filePath)
  return contextOutput(`${summary}\n${dataUrl}`)
}

/** The one gate on booking an image_shrink saving: only a rewritten Read path this process wrote itself is a delivery it can vouch for. Context text sits beside a Read that still loads the original, and a host-materialized copy is written after this process has answered. */
function deliveryReplacesRead(harness: HarnessName, output: HookOutput): boolean {
  return output.hookType === 'rewriteInput' && PATH_REWRITE_HARNESSES.has(harness)
}

/** Whether a shrunk copy can take the original image's place on this harness at all. Every other harness only appends hook context beside a Read that still loads the original: Codex spills context over 2,500 tokens to a file behind a preview (https://developers.openai.com/codex/hooks) and Gemini's BeforeTool has no context field (https://geminicli.com/docs/hooks/reference/), so a 2.6 MB data URL there was pure added cost. */
function shrinkCanReplaceRead(harness: HarnessName): boolean {
  return PATH_REWRITE_HARNESSES.has(harness) || HOST_MATERIALIZED_HARNESSES.has(harness) || harness === 'generic'
}

/** Books the original-to-shrunk saving. The token figure prices both sides as 28x28-pixel vision patches, downscale included, rather than bytes/4, which credited a megabyte-scale byte delta as a quarter-million tokens. */
function recordSavedShrink(result: ShrinkResult, basename: string): void {
  const tier = loadConfig().image_shrink.vision_tier
  recordStat('image_shrink', result.originalBytes - result.shrunkBytes, visionTokensSaved(result.originalWidth, result.originalHeight, result.width, result.height, tier), undefined, basename)
}

/** pre_tool_use handler for Read on image files. Passes through unless the target is an image at or above the size threshold OR whose longest edge exceeds `DEFAULT_MAX_DIMENSION` — a small, highly-compressible PNG (e.g. a large flat-color screenshot) can sail under the byte threshold on disk while still decoding to well beyond Claude Vision's optimal edge, and Claude Code's own internal re-encode for vision then inflates it far past its on-disk size. When the byte size alone doesn't already qualify the file, a cheap header-only `probeImageMeta` probe checks the decoded dimensions before falling through to a pass. On a successful shrink it returns a `context` output carrying the shrunk image as a base64 data URL plus a one-line savings summary, so the model sees the cheaper image instead of the original. Any failure (non-image, small file/dimensions, unreadable, no net saving) is a pass — the hook never blocks a Read. */
export async function preReadImageHandler(event: HookEvent): Promise<HookOutput> {
  if (loadConfig().image_shrink.enabled === false) return passOutput()
  // On VS Code only view_image can take the shrunk copy (its path is rewritten to it); read_file and list_dir also map to Read, and a shrink recorded for them would never reach the model.
  const vscodeTool = event.raw[VSCODE_TOOL_NAME_KEY]
  if (vscodeTool !== undefined && vscodeTool !== 'view_image') return passOutput()

  const filePath = getFilePath(event)
  if (filePath === undefined) return passOutput()
  if (!isImagePath(filePath)) return passOutput()
  // Before any stat or read of the path: see preToolPathDeclined.
  if (preToolPathDeclined(event, filePath)) return passOutput()
  // Claude Code's Read of the shrunk copy, which lives outside the working directory, needs permissionDecision "allow" to avoid a prompt, and an allow is only honest for an original Read that would not have prompted either (https://code.claude.com/docs/en/permissions), so only an image inside the working directory is shrunk there; rewrite_permission.ts makes the same check before the allow is sent. Copilot CLI gets the same gate: it asks before a view outside the working directory, its added directories, and the system temp dir, and its permission engine is native code whose order against a preToolUse modifiedArgs no hook can read, so a copy in the temp dir could take an outside image past that prompt; an added directory is invisible to the hook, so an image there is left alone too.
  const harness = detectHarness()
  if ((harness === 'claudecode' || harness === 'copilot_cli') && !vscodePathAllowed(filePath, getCwd(event))) return passOutput()
  // Before any shrink work, so a harness whose Read the copy cannot replace is not handed a megabyte of base64 text beside the original either.
  if (!shrinkCanReplaceRead(harness)) return passOutput()

  pruneShrinkCache()

  const stat = statInfo(filePath)
  if (stat === null) return passOutput()

  // Checked before any read/decode of the original: a cache hit skips the re-encode (and, for small-but-oversized-dimension files, the metadata probe below) entirely. A corrupt or truncated cache entry (unexpected external interference; atomicWriteBytes itself never leaves a partial file) is detected by re-probing it -- an undecodable cached file is deleted and treated as a miss, never served. The quality the shrink would be produced at right now, read once and then threaded through the lookup, the encode and the write alike. Reading it here rather than letting each of those three reload the config independently is what stops them disagreeing if the config changed partway through -- bytes encoded at one quality stored under another quality's key would be a permanently stale entry, the same defect this key change fixes.
  const quality = loadConfig().image_shrink.jpeg_quality
  const cached = findCachedShrink(filePath, stat.size, stat.mtimeMs, quality)
  if (cached !== null) {
    let cachedData: Buffer | null
    try {
      cachedData = fs.readFileSync(cached.filePath)
    } catch {
      cachedData = null
    }
    // The pre-read hook must never throw on a bad image; a decode failure here just means this cache entry is unusable, so fall through to a fresh read as if it were a miss.
    let meta: Awaited<ReturnType<typeof probeImageMeta>> = null
    if (cachedData !== null) {
      try {
        meta = await probeImageMeta(cachedData)
      } catch {
        meta = null
      }
    }
    if (cachedData !== null && meta !== null) {
      const result: ShrinkResult = {
        data: cachedData,
        originalBytes: stat.size,
        shrunkBytes: cachedData.length,
        originalWidth: cached.originalWidth,
        originalHeight: cached.originalHeight,
        width: meta.width,
        height: meta.height,
        format: cached.format,
      }
      return finalizeShrinkResult(result, filePath, event)
    }
    try {
      fs.unlinkSync(cached.filePath)
    } catch {
      // Best-effort; falling through to a fresh shrink below is correct either way.
    }
  }

  // Read once and let imageQualifiesForShrink judge the bytes it already holds. A file that qualifies on size alone never reaches the dimension probe, and one that does not qualify at all is read exactly as often as it was before -- the probe always needed the bytes anyway.
  let input: Buffer
  try {
    input = fs.readFileSync(filePath)
  } catch {
    return passOutput()
  }

  // A pass here is a file that was never a candidate, which is not the same event as a candidate the re-encode declined below, so it deliberately records nothing -- except when the reason it never became a candidate is the pixel-limit check inside probeImageMeta throwing, which is otherwise invisible to the stats surface and to anyone debugging "why didn't this shrink": an image over the configured ceiling is recorded distinctly, the same way image_shrink_skipped is recorded below for a candidate the re-encode declined.
  if (!(await imageQualifiesForShrink(input))) {
    if (await exceedsConfiguredPixelLimit(input)) recordStat('image_shrink_over_pixel_limit')
    return passOutput()
  }

  const result = await shrinkImage(input, { quality, sizeThresholdBytes: 0 })
  if (result === null) {
    // Qualified for a shrink attempt (over the size/dimension threshold) but shrinkImage declined -- either the re-encode never beat the original ("never enlarge") or the input was undecodable. Event-only like skill_oversized_first_load's sibling: 0 bytes/tokens, since a skip saves nothing, but the count is what tells us whether the threshold is tuned right.
    recordStat('image_shrink_skipped')
    return passOutput()
  }

  writeCachedShrink(filePath, result, stat.mtimeMs, quality)

  return finalizeShrinkResult(result, filePath, event)
}

registerHook('pre_tool_use', loadingHiddenRuleCheck(preReadImageHandler), { toolName: 'Read' })
