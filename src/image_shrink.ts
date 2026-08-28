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

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { loadConfig, type VisionTier } from './config.js'
import { DEFAULT_MAX_AGE_MS, tokenGoatHome } from './disk_cache.js'
import { createLazyModuleLoader } from './lazy_module.js'
import { ensureDirSync, atomicWriteBytes, toKB } from './util.js'
import { getFilePath } from './hooks_common.js'
import type { HookEvent } from './hook_registry.js'
import { registerHook } from './hook_registry.js'
import { contextOutput, passOutput } from './hooks_common.js'
import { recordStat } from './stats.js'
import type { HookOutput } from './types.js'
import { formatOcrSummary, isTextHeavy, ocrImage } from './image_ocr.js'

/** Recognised image extensions (lowercase, leading dot). Matches the Python set, plus AVIF/HEIC/HEIF which sharp can decode and the Python port predates. */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.tiff',
  '.avif',
  '.heic',
  '.heif',
])

/** Long-edge resize target. 1568 is Claude's Standard resolution tier maximum; Claude 4.7 and later run a High-resolution tier whose maximum is 2576, so this is a conservative floor that every tier accepts rather than a universal optimum. It also divides evenly into Anthropic's 28px patch grid (56) and OpenAI's 32px one (49). */
const DEFAULT_MAX_DIMENSION = 1568

/**
 * Anthropic bills an image as a grid of 28x28-pixel patches, one visual token per patch, so an
 * image costs `ceil(width / 28) * ceil(height / 28)` tokens. Every constant and every step of the
 * arithmetic below is transcribed from Anthropic's own published rule and reference implementation:
 * https://platform.claude.com/docs/en/build-with-claude/vision#evaluate-image-size and
 * https://platform.claude.com/docs/en/build-with-claude/vision-coordinates#how-claude-resizes-and-pads-images
 *
 * This exists because the byte count an image shrink saves is not what an image is billed in. A
 * saving is only real in the unit that bills, and bytes are not that unit for pixels.
 */
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

/**
 * Visual tokens an image of `width` x `height` actually costs on `tier`, after the API's own
 * downscale.
 *
 * The downscale is the whole point of routing through this rather than multiplying out the raw
 * dimensions: the API caps an oversized image's cost itself, so a saving measured against the
 * untouched original is measured against a bill that is never sent. On the Standard tier a 4K
 * screenshot and a 1080p screenshot cost the identical 1560 tokens, and shrinking the former to
 * 1568px wide saves nothing at all in the unit that bills.
 *
 * Returns 0 for a non-positive or non-finite size rather than throwing: dimensions reach here from
 * image metadata that a decoder may not have populated, and a stat row must never be the thing
 * that fails a read.
 */
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
  /** Input width in pixels, before the resize. Carried so a caller can price the shrink in visual tokens (see {@link visionTokensSaved}) rather than in bytes, which is not the unit an image is billed in. Read before `.rotate()` applies EXIF orientation, so for a rotated source this pair may be transposed relative to what the model would have seen -- harmless here, because a patch count multiplies its two axes and is therefore identical either way round. */
  readonly originalWidth: number
  /** Input height in pixels, before the resize. See {@link ShrinkResult.originalWidth}. */
  readonly originalHeight: number
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

/** Raw decoded metadata for `image-meta` -- dimensions/format only, no re-encode. Returns `null` when `sharp` is unavailable or the input can't be decoded, same convention as {@link shrinkImage}. */
/** Sentinel thrown by {@link probeImageMeta} when sharp is present but the bytes will not decode. */
export class ImageDecodeError extends Error {}

export async function probeImageMeta(input: Buffer): Promise<{ width: number; height: number; format: string | null; pages: number } | null> {
  const sharp = await loadSharp()
  if (sharp === null) return null
  try {
    // Every sibling decode call site in this file threads the configured decompression-bomb cap
    // (cfg.max_image_pixels, 0 meaning "no cap") instead of hardcoding limitInputPixels: false --
    // this was the one that didn't, so `token-goat image-meta` would fully decode an unbounded
    // image with no pixel bound at all. probeImageMeta takes only a Buffer (no caller threads a
    // pre-loaded config through it, unlike shrinkImage/imageQualifiesForShrink which already have
    // one in scope), so it loads config itself here.
    const cfg = loadConfig().image_shrink
    const limitInputPixels = cfg.max_image_pixels > 0 ? cfg.max_image_pixels : false
    const meta = await sharp(input, { limitInputPixels }).metadata()
    return { width: meta.width ?? 0, height: meta.height ?? 0, format: meta.format ?? null, pages: meta.pages ?? 1 }
  } catch (e) {
    // sharp IS installed and still failed: these bytes are not a decodable image (or, now that
    // limitInputPixels is threaded above, decode was refused because the image exceeds the
    // configured pixel cap -- a decompression-bomb rejection, which is deliberately folded into
    // this same ImageDecodeError path rather than given its own error type. Both are "sharp
    // declined to hand back pixel data for this input"; the cap rejection differs only in *why*,
    // and sharp's own thrown message already names that reason, so the caller (runImageMeta in
    // read_commands.ts) surfaces it verbatim as a real error instead of the "install sharp"
    // notice. Reporting either case as null (the "not installed" signal) told the user to install
    // a dependency they already have, at exit 0, for a file that is simply corrupt or oversized.
    // Throw so the caller can say what is actually wrong.
    throw new ImageDecodeError((e as Error)?.message ?? 'image could not be decoded')
  }
}

/**
 * True when `input` is worth spending a re-encode on.
 *
 * Two independent tests, and only the first is about bytes. At or above the byte threshold the
 * encode pays for itself on size alone. Below it, decoded dimensions still decide: a flat-colour
 * screenshot compresses to a hundred kilobytes on disk and still decodes to well past
 * `DEFAULT_MAX_DIMENSION`, and vision is billed on pixels rather than bytes, so the model pays in
 * full for an edge it cannot use. Both callers need both tests, which is why the decision lives
 * here instead of inside either of them: the file-Read path had both and the inline browser
 * screenshot path had only the byte one, so every screenshot under 512 KB went through at full
 * size no matter how large it decoded to.
 *
 * The dimension probe is a header-only metadata read and honours the configured decode-pixel cap,
 * so a decompression bomb answers false rather than being decoded. Undecodable input and a
 * missing `sharp` both answer false, matching {@link shrinkImage}'s own convention.
 */
export async function imageQualifiesForShrink(input: Buffer): Promise<boolean> {
  if (input.length >= DEFAULT_SIZE_THRESHOLD_BYTES) return true

  const sharp = await loadSharp()
  if (sharp === null) return false
  try {
    const cfg = loadConfig().image_shrink
    const limitInputPixels = cfg.max_image_pixels > 0 ? cfg.max_image_pixels : false
    const meta = await sharp(input, { limitInputPixels }).metadata()
    return Math.max(meta.width ?? 0, meta.height ?? 0) > DEFAULT_MAX_DIMENSION
  } catch {
    return false
  }
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
  // max_image_pixels is sharp's decode-time decompression-bomb guard (mirrors Python's Image.MAX_IMAGE_PIXELS), not the resize target — the resize edge is always DEFAULT_MAX_DIMENSION unless a caller overrides it via opts.maxDimension (it was not configurable at all in the original Python port). 0 means "no cap", matching the original TOKEN_GOAT_MAX_IMAGE_PIXELS semantics.
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
      originalWidth: inputMeta.width ?? 0,
      originalHeight: inputMeta.height ?? 0,
      width: meta.width ?? 0,
      height: meta.height ?? 0,
      format,
    }
  } catch {
    // Undecodable / unsupported input: treat as not-shrinkable.
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

/**
 * Cache key for a shrunk re-encode: sha256 of `path:size:mtimeMs:quality`, truncated to 16 hex
 * chars (64 bits). mtime is part of the key -- not just path + size -- so a content change that
 * happens to preserve the exact byte length (e.g. regenerating a same-dimension screenshot)
 * still busts the cache instead of silently serving a stale shrink. The encode quality is part of
 * it for the same reason from the other direction: it is the one input that changes the bytes
 * without changing the source file at all, so a key without it made `image_shrink.jpeg_quality`
 * dead config for every image already in the cache -- measured at a 23x spread (64 KB at quality
 * 10 against 1.5 MB at quality 95 for the same screenshot) that a warm cache flattened to a
 * single stale encode. Entries written under the old key are simply never found again and age out
 * on the existing prune. 64 bits of hash keeps
 * collisions negligible for this cache's realistic working set: entries are pruned after
 * DEFAULT_MAX_AGE_MS, so the live set at any moment is bounded by how many distinct images get
 * read in that window, not by the process's lifetime total -- nowhere close to the ~2^32 items a
 * 64-bit hash would need before collisions become likely by the birthday bound. The key already
 * domain-separates by full source path, so a collision would additionally require two different
 * paths to also match on size+mtime.
 */
function shrinkCacheKey(originalPath: string, size: number, mtimeMs: number, quality: number): string {
  return createHash('sha256').update(`${originalPath}:${size}:${mtimeMs}:${quality}`).digest('hex').slice(0, 16)
}

/**
 * Look for an already-cached re-encode of this exact (path, size, mtime, quality). Checked BEFORE
 * running the shrink so a repeat Read of an unchanged image can skip the sharp re-encode entirely
 * instead of always re-running it.
 *
 * A directory scan rather than two `existsSync` probes, because the entry's name now carries the
 * ORIGINAL image's dimensions as well as the output format, and neither is known ahead of the
 * lookup. Those dimensions are what lets a cache hit price its saving in the unit an image is
 * actually billed in: this path never decodes the original, so without them the branch could only
 * report a zero visual-token saving on every hit -- an entire mechanism reading as worthless in
 * `token-goat stats` while doing exactly the same work as the miss path beside it. The scan costs
 * nothing measurable next to the readdir `pruneShrinkCache` already performs on the same directory
 * one line earlier in the same handler.
 *
 * Entries written by an older version carry no dimensions, so they no longer match and are treated
 * as a miss. That is a single re-encode per image, after which the sweep in `pruneShrinkCache`
 * collects the stale file on age like any other.
 */
function findCachedShrink(originalPath: string, size: number, mtimeMs: number, quality: number): { filePath: string; format: 'webp' | 'jpeg'; originalWidth: number; originalHeight: number } | null {
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
    const m = /^(\d+)x(\d+)(\.webp|\.jpg)$/.exec(file.slice(prefix.length))
    if (m === null) continue
    return {
      filePath: path.join(dir, file),
      format: m[3] === '.jpg' ? 'jpeg' : 'webp',
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
    const ext = result.format === 'jpeg' ? '.jpg' : '.webp'
    atomicWriteBytes(path.join(dir, `token-goat-shrink-${key}-${result.originalWidth}x${result.originalHeight}${ext}`), result.data)
  } catch {
    // Best-effort; failing to cache must not block returning the freshly computed shrink.
  }
}

// Throttles pruneShrinkCache so a burst of Reads within the same process only sweeps the cache
// dir once instead of on every single call. Each hook invocation is normally its own fresh
// `token-goat hook <event>` process (see disk_cache.ts), so in production this already amounts
// to roughly once per hook call; the throttle mainly protects long-lived hosts (tests, a
// persistent worker) from re-scanning the cache dir on every image read.
const SHRINK_CACHE_PRUNE_THROTTLE_MS = 60_000
let lastShrinkCachePruneAtMs = 0

/** Test-only: force the next pruneShrinkCache() call to run instead of being throttled. */
export function resetShrinkCachePruneThrottleForTests(): void {
  lastShrinkCachePruneAtMs = 0
}

/**
 * Best-effort sweep of this cache's own `token-goat-shrink-*` files older than
 * DEFAULT_MAX_AGE_MS, so heavy image-reading does not accumulate them unbounded -- nothing else
 * in this codebase ever removes them otherwise. Mirrors disk_cache.ts's age-based pruning
 * convention (same DEFAULT_MAX_AGE_MS, same mtime-cutoff-then-delete shape) rather than
 * inventing a new policy; disk_cache.ts's own `pruneBlobs` isn't reused directly because it is
 * hardcoded to `.json` blobs written through `storeBlob`, which runs every value through
 * `redactSecrets()` -- a text-oriented secret scan that is the wrong tool for, and could corrupt,
 * base64-free binary image bytes. Scoped to `imageShrinkCacheDir()`, a dedicated subdir of
 * token-goat home that nothing else writes into, and additionally filtered to this cache's own
 * `token-goat-shrink-` filename prefix as defense in depth -- this sweep can never delete
 * anything outside that. Never throws: a prune failure (permissions, a file removed by another
 * process mid-sweep, ...) must never break the caller's actual image-shrink operation.
 */
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

/**
 * Shared tail of {@link preReadImageHandler}: OCR-or-pixel accounting and the `context` output,
 * given a {@link ShrinkResult} regardless of whether it came from a fresh `shrinkImage()` call or
 * a cache hit. Keeping one code path here is what keeps a cache hit's `recordStat` honest -- it
 * reports the same savings a fresh shrink would have, because the model receives the same bytes
 * either way; only the (unmeasured) re-encode CPU cost differs, and this function has no
 * visibility into that.
 */
async function finalizeShrinkResult(result: ShrinkResult, filePath: string): Promise<HookOutput> {
  const basename = path.basename(filePath)

  // The pixel-shrink saving (original bytes -> shrunk bytes) is real on every path this function
  // takes, so record it up front, before the OCR branch below can return early. The OCR branch
  // then adds an image_ocr row measured against the SHRUNK bytes rather than the original, so that
  // when the OCR text is no larger than the shrunk image the two rows sum exactly to the true
  // original->text saving with no double-counting -- which only holds if this image_shrink row is
  // actually recorded on the OCR path too. (In the degenerate case where the OCR text is somehow
  // larger than the shrunk image, image_ocr clamps to zero rather than record a negative saving,
  // so the total is the shrink saving alone; that case does not arise for a genuinely text-heavy
  // image, whose recognized text is far smaller than its downscaled pixels.)
  // This recordStat previously sat after the OCR early-return, so a text-heavy image (exactly what
  // OCR targets) recorded image_ocr alone and dropped the whole shrink saving from the ledger.
  // Bytes and tokens are measured in different units here on purpose. The byte figure is the real
  // wire saving. The token figure is NOT bytes/4: an image is billed as 28x28-pixel patches, so the
  // bytes/4 approximation this used to record (a text-token rule of thumb, inherited because the
  // Python original's exact vision-token delta was never ported to shrinkImage's return shape) was
  // simply the wrong unit, and it was wrong in the direction that flatters -- it credited a
  // megabyte-scale byte delta as a quarter-million tokens. visionTokensSaved prices both sides the
  // way the API does, downscale included, so an original the API would have capped anyway is
  // credited at the capped cost rather than at its full pixel count.
  const shrinkSaved = result.originalBytes - result.shrunkBytes
  const tier = loadConfig().image_shrink.vision_tier
  recordStat('image_shrink', shrinkSaved, visionTokensSaved(result.originalWidth, result.originalHeight, result.width, result.height, tier), undefined, basename)

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
      // preempts), not the original file -- the shrink-step savings are recorded above, on the
      // shared path before this branch, so this avoids double-counting the same bytes under two
      // stat rows.
      // Priced on the payload actually emitted, not on ocr.text alone: the summary line and the
      // untrusted-content fence around the text are both part of what this branch puts into context,
      // so crediting only the bare text would bill a smaller thing than the one that ships.
      const emitted = formatOcrSummary(ocr, basename, result.originalBytes)
      const emittedBytes = Buffer.byteLength(emitted, 'utf8')
      const saved = Math.max(0, result.shrunkBytes - emittedBytes)
      // This branch swaps units mid-trade: pixels go out, text comes back. So the two sides are
      // priced by their own rules -- visual tokens for the image this branch preempts, the codebase's
      // bytes/4 text approximation for the string it emits instead -- rather than by one rule applied
      // to both. Pairs with the image_shrink row above, which covers original -> shrunk, so the two
      // rows still sum to the true original -> text saving with nothing counted twice.
      const tokensSaved = Math.max(0, visionTokens(result.width, result.height, tier) - Math.round(emittedBytes / 4))
      recordStat('image_ocr', saved, tokensSaved, undefined, basename)
      return contextOutput(emitted)
    }
  }

  const { summary, dataUrl } = formatShrinkSummary(result, basename)
  return contextOutput(`${summary}\n${dataUrl}`)
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

  pruneShrinkCache()

  const stat = statInfo(filePath)
  if (stat === null) return passOutput()

  // Checked before any read/decode of the original: a cache hit skips the sharp re-encode (and,
  // for small-but-oversized-dimension files, the metadata probe below) entirely. A corrupt or
  // truncated cache entry (unexpected external interference; atomicWriteBytes itself never
  // leaves a partial file) is detected by re-probing it with sharp -- an undecodable cached file
  // is deleted and treated as a miss, never served.
  // The quality the shrink would be produced at right now, read once and then threaded through
  // the lookup, the encode and the write alike. Reading it here rather than letting each of those
  // three reload the config independently is what stops them disagreeing if the config changed
  // partway through -- bytes encoded at one quality stored under another quality's key would be a
  // permanently stale entry, the same defect this key change fixes.
  const quality = loadConfig().image_shrink.jpeg_quality
  const cached = findCachedShrink(filePath, stat.size, stat.mtimeMs, quality)
  if (cached !== null) {
    let cachedData: Buffer | null
    try {
      cachedData = fs.readFileSync(cached.filePath)
    } catch {
      cachedData = null
    }
    // The pre-read hook must never throw on a bad image; a decode failure here just means this
    // cache entry is unusable, so fall through to a fresh read as if it were a miss.
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
      return finalizeShrinkResult(result, filePath)
    }
    try {
      fs.unlinkSync(cached.filePath)
    } catch {
      // Best-effort; falling through to a fresh shrink below is correct either way.
    }
  }

  // Read once and let imageQualifiesForShrink judge the bytes it already holds. A file that
  // qualifies on size alone never reaches the dimension probe, and one that does not qualify at
  // all is read exactly as often as it was before -- the probe always needed the bytes anyway.
  let input: Buffer
  try {
    input = fs.readFileSync(filePath)
  } catch {
    return passOutput()
  }

  // A pass here is a file that was never a candidate, which is not the same event as a candidate
  // the re-encode declined below, so it deliberately records nothing.
  if (!(await imageQualifiesForShrink(input))) return passOutput()

  const result = await shrinkImage(input, { quality, sizeThresholdBytes: 0 })
  if (result === null) {
    // Qualified for a shrink attempt (over the size/dimension threshold) but shrinkImage
    // declined -- either the re-encode never beat the original ("never enlarge") or the
    // input was undecodable. Event-only like skill_oversized_first_load's sibling: 0
    // bytes/tokens, since a skip saves nothing, but the count is what tells us whether the
    // threshold is tuned right.
    recordStat('image_shrink_skipped')
    return passOutput()
  }

  writeCachedShrink(filePath, result, stat.mtimeMs, quality)

  return finalizeShrinkResult(result, filePath)
}

registerHook('pre_tool_use', preReadImageHandler, { toolName: 'Read' })
