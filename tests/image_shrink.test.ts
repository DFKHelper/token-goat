import { tempConfigPath } from './helpers/temp-config.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'

// The jpeg_quality/max_image_pixels regression tests need a writable config, so
// configPath() is redirected (hoisted vi.mock) to a per-test-run temp file — the
// same pattern tests/config.test.ts and tests/bash_compress_rewrite.test.ts use.
const _testConfigPath = tempConfigPath('tg-image-shrink-config.toml')
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, configPath: () => _testConfigPath }
})

import {
  isImagePath,
  preReadImageHandler,
  probeImageMeta,
  resetShrinkCachePruneThrottleForTests,
  shrinkImage,
  ImageDecodeError,
} from '../src/image_shrink.js'
import { resetOcrStateForTesting, setTesseractEntryForTesting } from '../src/image_ocr.js'
import { summarize } from '../src/stats.js'
import type { HookEvent } from '../src/hook_registry.js'
// Importing relay registers EVERY hook module (hooks_read's large-file deny AND
// image_shrink's preReadImageHandler) for its side-effects, so runHook dispatches
// through the real production registry — the only way to observe the composed
// pre_tool_use decision both handlers produce together, not either in isolation.
import { buildEvent } from '../src/relay.js'
import { runHook } from '../src/hook_registry.js'
import { invalidateConfigCache } from '../src/config.js'
import { makeHookEvent } from './helpers/hook-event.js'

function makeEvent(filePath: string | undefined): HookEvent {
  return makeHookEvent({
    toolName: 'Read',
    toolInput: filePath === undefined ? {} : { file_path: filePath },
  })
}

const here = path.dirname(fileURLToPath(import.meta.url))
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-img-'))

// A tiny PNG, comfortably under the 512KB threshold.
let smallPng: Buffer
// A large, noisy image whose bytes exceed the threshold so it can shrink.
let largeJpeg: Buffer
let largePngPath: string
let smallPngPath: string
// A real 3-frame animated GIF (48x48, random noise per frame so the WEBP
// recompression below reliably shrinks it). sharp has no API to compose a
// multi-frame image from scratch (no `join` input option in this version), so
// this is a small committed binary fixture rather than one generated at test
// time. Regenerate via: magick -size 48x48 xc: +noise random -size 48x48 xc:
// +noise random -size 48x48 xc: +noise random -delay 10 -loop 0 tests/fixtures/animated.gif
const animatedGif = fs.readFileSync(path.join(here, 'fixtures', 'animated.gif'))

beforeAll(async () => {
  smallPng = await sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer()

  // Random noise resists compression, guaranteeing a >512KB encoded size at 3000x3000 so the shrink path (downscale to 1568) has real bytes to save.
  const side = 3000
  const noise = Buffer.allocUnsafe(side * side * 3)
  for (let i = 0; i < noise.length; i++) noise[i] = Math.floor(Math.random() * 256)
  largeJpeg = await sharp(noise, { raw: { width: side, height: side, channels: 3 } })
    .jpeg({ quality: 100 })
    .toBuffer()

  smallPngPath = path.join(TMP, 'small.png')
  largePngPath = path.join(TMP, 'large.jpg')
  fs.writeFileSync(smallPngPath, smallPng)
  fs.writeFileSync(largePngPath, largeJpeg)
})

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

// This suite predates OCR and asserts on the pixel-shrink path specifically (data URLs,
// jpeg_quality wiring, etc). Forcing tesseract.js "unavailable" keeps every existing
// assertion here exercising exactly the path it always has -- OCR's own success/fallback
// behavior gets its dedicated coverage in image_ocr.test.ts and the OCR-specific cases in
// this file's own describe block below.
beforeEach(() => {
  try {
    fs.unlinkSync(_testConfigPath)
  } catch {
    // no config file → schema defaults, matching this suite's behaviour before the mock existed
  }
  invalidateConfigCache()
  resetOcrStateForTesting()
  setTesseractEntryForTesting(null)
})

afterEach(() => {
  try {
    fs.unlinkSync(_testConfigPath)
  } catch {
    // already absent
  }
  invalidateConfigCache()
  resetOcrStateForTesting()
})

describe('isImagePath', () => {
  it('recognises image extensions case-insensitively', () => {
    expect(isImagePath('a.PNG')).toBe(true)
    expect(isImagePath('a.jpeg')).toBe(true)
    expect(isImagePath('a.webp')).toBe(true)
  })
  it('rejects non-image extensions', () => {
    expect(isImagePath('a.ts')).toBe(false)
    expect(isImagePath('a')).toBe(false)
  })
})

describe('shrinkImage', () => {
  it('returns null for an image below the size threshold', async () => {
    expect(await shrinkImage(smallPng)).toBeNull()
  })

  it('returns a smaller ShrinkResult for a large image', async () => {
    const result = await shrinkImage(largeJpeg)
    expect(result).not.toBeNull()
    if (result === null) return
    expect(result.shrunkBytes).toBeLessThan(result.originalBytes)
    expect(result.originalBytes).toBe(largeJpeg.length)
    expect(result.width).toBeLessThanOrEqual(1568)
    expect(result.height).toBeLessThanOrEqual(1568)
    expect(['jpeg', 'webp']).toContain(result.format)
  })

  it('honours a custom size threshold (large threshold => null)', async () => {
    expect(await shrinkImage(largeJpeg, { sizeThresholdBytes: 1024 * 1024 * 1024 })).toBeNull()
  })

  it('honours a configured jpeg_quality with no explicit opts (lower quality => smaller output)', async () => {
    // Baseline under the schema default (jpeg_quality=75; no config file present).
    const baseline = await shrinkImage(largeJpeg)
    expect(baseline).not.toBeNull()
    if (baseline === null) return

    fs.writeFileSync(_testConfigPath, '[image_shrink]\njpeg_quality = 10\n', 'utf8')
    invalidateConfigCache()
    const lowQuality = await shrinkImage(largeJpeg)
    expect(lowQuality).not.toBeNull()
    if (lowQuality === null) return

    // Same input, same call shape (no opts) — the only difference is the
    // configured jpeg_quality, so a real wiring bug (falling back to a
    // hardcoded constant) would make this fail: both calls would produce
    // identical output.
    expect(lowQuality.shrunkBytes).toBeLessThan(baseline.shrunkBytes)
  })

  it('honours a configured max_image_pixels with no explicit opts (cap below actual size => sharp rejects decode)', async () => {
    // largeJpeg is 3000x3000 = 9,000,000px. The schema default (16,000,000)
    // comfortably covers it, so it shrinks normally (see the "returns a smaller
    // ShrinkResult" test above). Capping max_image_pixels below the image's
    // real pixel count wires straight into sharp's own decode-time
    // decompression-bomb guard (limitInputPixels), so the decode is now
    // refused and shrinkImage degrades to its normal "undecodable input" path.
    fs.writeFileSync(_testConfigPath, '[image_shrink]\nmax_image_pixels = 1000000\n', 'utf8')
    invalidateConfigCache()
    expect(await shrinkImage(largeJpeg)).toBeNull()
  })

  it('honours a configured max_image_pixels probing metadata (cap below actual size => sharp rejects decode, thrown as ImageDecodeError not a silent null)', async () => {
    // Same fixture and same reasoning as the shrinkImage max_image_pixels test above, but against
    // probeImageMeta -- the image-meta command's own decode path, which used to hardcode
    // limitInputPixels: false and so was the one sibling call site in image_shrink.ts with no
    // pixel bound at all. A cap rejection here is a real ImageDecodeError (sharp declined to
    // decode), not the "sharp unavailable" null return -- those two failure modes must stay
    // distinguishable to the caller.
    fs.writeFileSync(_testConfigPath, '[image_shrink]\nmax_image_pixels = 1000000\n', 'utf8')
    invalidateConfigCache()
    await expect(probeImageMeta(largeJpeg)).rejects.toBeInstanceOf(ImageDecodeError)
  })

  it('decodes normally under the schema-default max_image_pixels (cap comfortably above actual size)', async () => {
    const meta = await probeImageMeta(largeJpeg)
    expect(meta).not.toBeNull()
    if (meta === null) return
    expect(meta.width).toBe(3000)
    expect(meta.height).toBe(3000)
  })

  it('preserves every frame of an animated GIF instead of collapsing to a single frame', async () => {
    // Confirm the fixture really is multi-frame before trusting the assertions below.
    const inputMeta = await sharp(animatedGif).metadata()
    expect(inputMeta.pages).toBe(3)

    // animatedGif is only ~11KB (well under the 512KB threshold), so force it
    // through the shrink path — this test is about frame preservation, not the
    // size-threshold gate (already covered by the tests above).
    const result = await shrinkImage(animatedGif, { sizeThresholdBytes: 1 })
    expect(result).not.toBeNull()
    if (result === null) return
    expect(result.shrunkBytes).toBeLessThan(result.originalBytes)
    // JPEG has no multi-frame container, so an animated input must never pick it.
    expect(result.format).toBe('webp')

    const outputMeta = await sharp(result.data, { animated: true }).metadata()
    expect(outputMeta.pages).toBeGreaterThan(1)
  })
})

describe('preReadImageHandler', () => {
  it('passes for a non-image file extension', async () => {
    const out = await preReadImageHandler(makeEvent('/some/file.ts'))
    expect(out.hookType).toBe('pass')
  })

  it('passes when file_path is absent', async () => {
    const out = await preReadImageHandler(makeEvent(undefined))
    expect(out.hookType).toBe('pass')
  })

  it('passes for a small image file (below threshold)', async () => {
    const out = await preReadImageHandler(makeEvent(smallPngPath))
    expect(out.hookType).toBe('pass')
  })

  it('shrinks a small-byte, large-dimension image (byte size under threshold, longest edge over DEFAULT_MAX_DIMENSION)', async () => {
    // A solid-color 2200x1700 PNG compresses to a tiny byte count -- well
    // under the 512KB size threshold -- but its decoded dimensions exceed
    // Claude Vision's optimal 1568px edge. Before the dimension probe, the
    // byte-only gate let this file pass through untouched; it must now shrink.
    const bigDimsSmallBytesPng = await sharp({
      create: { width: 2200, height: 1700, channels: 3, background: { r: 40, g: 90, b: 160 } },
    })
      .png()
      .toBuffer()
    expect(bigDimsSmallBytesPng.length).toBeLessThan(512 * 1024)

    const filePath = path.join(TMP, 'big-dims-small-bytes.png')
    fs.writeFileSync(filePath, bigDimsSmallBytesPng)
    try {
      const out = await preReadImageHandler(makeEvent(filePath))
      expect(out.hookType).toBe('context')
      if (out.hookType !== 'context') return
      expect(out.context).toContain('data:image/')
      expect(out.context).toContain('smaller')
    } finally {
      fs.rmSync(filePath, { force: true })
    }
  })

  it('passes for a missing image file', async () => {
    const out = await preReadImageHandler(makeEvent(path.join(TMP, 'nope.png')))
    expect(out.hookType).toBe('pass')
  })

  it('passes for a small, corrupt/undecodable image file (dimension probe fails open)', async () => {
    // Under the byte threshold, so this exercises the dimension-probe branch;
    // the bytes are not a real image, so sharp's metadata() must throw and the
    // handler must fail open rather than crash.
    const corruptPath = path.join(TMP, 'corrupt.png')
    fs.writeFileSync(corruptPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]))
    const out = await preReadImageHandler(makeEvent(corruptPath))
    expect(out.hookType).toBe('pass')
  })

  it('emits a context output with a data URL for a large image', async () => {
    const out = await preReadImageHandler(makeEvent(largePngPath))
    expect(out.hookType).toBe('context')
    if (out.hookType !== 'context') return
    expect(out.context).toContain('data:image/')
    expect(out.context).toContain('smaller')
  })

  it('records an image_shrink stat row through the real global stats DB on a successful shrink (#236: this recording was dropped entirely during the Python->TS port -- a synthetic DB insert would not catch its absence, so this drives the real production hook path with no test-only DB override)', async () => {
    const before = summarize(30).by_kind['image_shrink']
    const beforeEvents = before?.events ?? 0
    const beforeBytesSaved = before?.bytes_saved ?? 0

    const out = await preReadImageHandler(makeEvent(largePngPath))
    expect(out.hookType).toBe('context')

    const after = summarize(30).by_kind['image_shrink']
    expect(after).toBeDefined()
    expect(after?.events ?? 0).toBeGreaterThan(beforeEvents)
    expect(after?.bytes_saved ?? 0).toBeGreaterThan(beforeBytesSaved)
  })

  it('records an image_shrink_skipped stat row through the real global stats DB when a qualifying image cannot be shrunk (regression: image_shrink_skipped was registered in KIND_TO_SOURCE and _KIND_GROUPS but no recordStat call site ever existed anywhere in src/, so the kind was permanently empty in `token-goat stats --full` -- this drives the real production hook path, not a unit test of shrinkImage in isolation)', async () => {
    // Over DEFAULT_SIZE_THRESHOLD_BYTES so the handler skips the dimension probe and goes
    // straight to shrinkImage -- undecodable bytes make sharp's metadata() throw inside
    // shrinkImage's try/catch, which returns null (the "declined" branch under test), not the
    // earlier fail-open passes exercised by the small-corrupt-file and missing-file tests above.
    const bigCorruptPath = path.join(TMP, 'big-corrupt.png')
    fs.writeFileSync(bigCorruptPath, Buffer.alloc(600 * 1024, 7))

    const before = summarize(30).by_kind['image_shrink_skipped']
    const beforeEvents = before?.events ?? 0

    const out = await preReadImageHandler(makeEvent(bigCorruptPath))
    expect(out.hookType).toBe('pass')

    const after = summarize(30).by_kind['image_shrink_skipped']
    expect(after).toBeDefined()
    expect(after?.events ?? 0).toBeGreaterThan(beforeEvents)
    // A decline must never carry nonzero bytes -- it saved nothing, and nonzero would inflate
    // the headline savings figure with a non-saving.
    expect(after?.bytes_saved ?? 0).toBe(0)
  })

  it('passes a large image through unshrunk when image_shrink.enabled is false (regression: no way to opt out of shrinking)', async () => {
    fs.writeFileSync(_testConfigPath, '[image_shrink]\nenabled = false\n', 'utf8')
    invalidateConfigCache()
    try {
      const out = await preReadImageHandler(makeEvent(largePngPath))
      expect(out.hookType).toBe('pass')
    } finally {
      fs.writeFileSync(_testConfigPath, '', 'utf8')
      invalidateConfigCache()
    }
  })
})

describe('preReadImageHandler shrink cache', () => {
  let prevHome: string | undefined
  let tmpHome: string
  let cacheDir: string
  let dir: string
  let filePath: string

  beforeEach(() => {
    prevHome = process.env['TOKEN_GOAT_HOME']
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-shrink-cache-home-'))
    process.env['TOKEN_GOAT_HOME'] = tmpHome
    cacheDir = path.join(tmpHome, 'image_shrink_cache')

    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-shrink-cache-src-'))
    filePath = path.join(dir, 'photo.jpg')
    fs.writeFileSync(filePath, largeJpeg)

    resetShrinkCachePruneThrottleForTests()
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
    else process.env['TOKEN_GOAT_HOME'] = prevHome
    fs.rmSync(tmpHome, { recursive: true, force: true })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('writes a cache entry on a fresh shrink', async () => {
    const out = await preReadImageHandler(makeEvent(filePath))
    expect(out.hookType).toBe('context')
    const entries = fs.readdirSync(cacheDir).filter((f) => f.startsWith('token-goat-shrink-'))
    expect(entries.length).toBe(1)
  })

  it('serves a warm cache hit without re-running the sharp re-encode, and still records the same image_shrink savings a fresh shrink would', async () => {
    const firstOut = await preReadImageHandler(makeEvent(filePath))
    expect(firstOut.hookType).toBe('context')
    if (firstOut.hookType !== 'context') return

    const entries = fs.readdirSync(cacheDir).filter((f) => f.startsWith('token-goat-shrink-'))
    expect(entries.length).toBe(1)
    const cachedPath = path.join(cacheDir, entries[0] as string)
    const mtimeAfterFirst = fs.statSync(cachedPath).mtimeMs

    const before = summarize(30).by_kind['image_shrink']
    const beforeEvents = before?.events ?? 0
    const beforeBytesSaved = before?.bytes_saved ?? 0

    const secondOut = await preReadImageHandler(makeEvent(filePath))
    expect(secondOut.hookType).toBe('context')
    if (secondOut.hookType !== 'context') return
    // Same shrunk data URL both times -- the hit serves identical bytes to the miss.
    expect(secondOut.context).toBe(firstOut.context)

    // The cache file's own mtime is untouched by the second call -- proof the handler served
    // the existing entry instead of running a fresh shrinkImage() and rewriting it (a real
    // re-encode would write a new file via writeCachedShrink and change this mtime).
    expect(fs.statSync(cachedPath).mtimeMs).toBe(mtimeAfterFirst)
    const entriesAfter = fs.readdirSync(cacheDir).filter((f) => f.startsWith('token-goat-shrink-'))
    expect(entriesAfter.length).toBe(1)

    const after = summarize(30).by_kind['image_shrink']
    // The cache-hit handler still reports honest savings: same accounting call, same
    // shape, as a fresh shrink -- see the "accounting honesty" requirement this covers.
    expect(after?.events ?? 0).toBeGreaterThan(beforeEvents)
    expect(after?.bytes_saved ?? 0).toBeGreaterThan(beforeBytesSaved)
  })

  // Provenance for the token figures below: HAND-DERIVED from Anthropic's published rule, computed
  // here independently of visionTokens rather than read out of it. The fixture is 3000x3000 and is
  // resized to 1568x1568. On the standard tier both sizes are downscaled by the API itself to the
  // largest square whose patch grid fits the 1568-token budget -- 39x39 = 1521 patches, i.e.
  // 1092x1092 -- so both are billed 1521 and the shrink saves nothing at all in visual tokens. On
  // the high-resolution tier the original is capped at 69x69 = 4761 while the 1568px resize fits
  // untouched at 56x56 = 3136, a real saving of 1625. tests/vision_tokens.test.ts pins the same
  // arithmetic against the doc's own published table.
  //
  // Nothing asserted the tokens column of an image stat row before this, which is exactly how the
  // wrong unit shipped: image_shrink recorded bytes/4, so a 6 MB screenshot was booked as saving
  // roughly 1.5 million tokens. Every existing test checked bytes_saved and passed regardless.
  it('prices the shrink in visual tokens, not bytes/4, and reports zero on a tier where the API had already capped the original', async () => {
    const before = summarize(30).by_kind['image_shrink']?.tokens_saved ?? 0
    const out = await preReadImageHandler(makeEvent(filePath))
    expect(out.hookType).toBe('context')
    const delta = (summarize(30).by_kind['image_shrink']?.tokens_saved ?? 0) - before

    // The default tier is standard, where 3000x3000 and 1568x1568 cost the identical 1521 tokens.
    // Megabytes come off the wire and not one visual token comes off the bill, and saying so is the
    // point. bytes/4 would have reported six figures here.
    expect(delta).toBe(0)
    expect(summarize(30).by_kind['image_shrink']?.bytes_saved ?? 0).toBeGreaterThan(100_000)
  })

  it('reports the real token saving for the same image once the configured tier is one that would have paid for it', async () => {
    fs.writeFileSync(_testConfigPath, '[image_shrink]\nvision_tier = "high"\n', 'utf8')
    invalidateConfigCache()

    const before = summarize(30).by_kind['image_shrink']?.tokens_saved ?? 0
    const out = await preReadImageHandler(makeEvent(filePath))
    expect(out.hookType).toBe('context')
    const delta = (summarize(30).by_kind['image_shrink']?.tokens_saved ?? 0) - before

    // 4761 for the original the high-resolution tier would have billed, 3136 for the resize.
    expect(delta).toBe(4761 - 3136)
  })

  it('reports the identical token saving on a warm cache hit as on the fresh shrink that filled it', async () => {
    // The cache-hit path never decodes the original, so it can only price its saving if the entry
    // carries the original dimensions. Without them this branch would book a zero token saving on
    // every hit -- a whole mechanism reading as worthless in `token-goat stats` while doing the same
    // work as the miss beside it. Asserted under the high tier because the standard tier's honest
    // answer for this fixture is zero, which a broken cache-hit path would match by accident.
    fs.writeFileSync(_testConfigPath, '[image_shrink]\nvision_tier = "high"\n', 'utf8')
    invalidateConfigCache()

    const start = summarize(30).by_kind['image_shrink']?.tokens_saved ?? 0
    await preReadImageHandler(makeEvent(filePath))
    const afterMiss = summarize(30).by_kind['image_shrink']?.tokens_saved ?? 0
    await preReadImageHandler(makeEvent(filePath))
    const afterHit = summarize(30).by_kind['image_shrink']?.tokens_saved ?? 0

    expect(afterMiss - start).toBe(4761 - 3136)
    expect(afterHit - afterMiss).toBe(afterMiss - start)
  })

  it('invalidates the cache when the source file mtime changes, even at the same byte length (regression: mtime, not just path+size, must be part of the key)', async () => {
    await preReadImageHandler(makeEvent(filePath))
    const entriesBefore = fs.readdirSync(cacheDir).filter((f) => f.startsWith('token-goat-shrink-'))
    expect(entriesBefore.length).toBe(1)

    // Rewrite with byte-identical content but a bumped mtime (regenerating a
    // same-dimension screenshot is the realistic case this guards against).
    const future = new Date(Date.now() + 10_000)
    fs.writeFileSync(filePath, largeJpeg)
    fs.utimesSync(filePath, future, future)

    const out = await preReadImageHandler(makeEvent(filePath))
    expect(out.hookType).toBe('context')

    const entriesAfter = fs.readdirSync(cacheDir).filter((f) => f.startsWith('token-goat-shrink-'))
    // A second, distinct cache entry for the new (path, size, mtime) key -- the
    // stale entry from before the mtime bump is left in place (pruned later by age),
    // not overwritten, since its key no longer matches this file at all.
    expect(entriesAfter.length).toBe(2)
  })

  it('invalidates the cache when image_shrink.jpeg_quality changes, so the setting still reaches an already-cached image (regression: quality, not just path+size+mtime, must be part of the key)', async () => {
    const shrunkPayload = (out: Awaited<ReturnType<typeof preReadImageHandler>>): string => {
      expect(out.hookType).toBe('context')
      if (out.hookType !== 'context') return ''
      const m = /data:image\/\w+;base64,([A-Za-z0-9+/=]+)/.exec(out.context)
      expect(m).not.toBeNull()
      return (m as RegExpExecArray)[1] as string
    }
    const decodedBytes = (payload: string): number => Buffer.from(payload, 'base64').length
    const setQuality = (q: number): void => {
      fs.writeFileSync(_testConfigPath, '[image_shrink]\njpeg_quality = ' + String(q) + '\n', 'utf8')
      invalidateConfigCache()
    }

    setQuality(90)
    const high = shrunkPayload(await preReadImageHandler(makeEvent(filePath)))

    // Same file, untouched on disk -- only the configured quality changed. Before the key
    // carried the quality this served the warm entry verbatim, which made the setting dead
    // config for every image already in the cache.
    setQuality(10)
    const low = shrunkPayload(await preReadImageHandler(makeEvent(filePath)))

    expect(decodedBytes(low)).toBeLessThan(decodedBytes(high))

    // And the low-quality result is byte-for-byte what a cold cache produces at that quality --
    // proving the second call re-encoded rather than serving anything stale. Compared on the
    // encoded payload, not its length, so two different encodes of equal size cannot pass.
    fs.rmSync(cacheDir, { recursive: true, force: true })
    resetShrinkCachePruneThrottleForTests()
    expect(shrunkPayload(await preReadImageHandler(makeEvent(filePath)))).toBe(low)

    // Two live keys for the one file: one per quality, neither overwriting the other.
    setQuality(90)
    await preReadImageHandler(makeEvent(filePath))
    expect(fs.readdirSync(cacheDir).filter((f) => f.startsWith('token-goat-shrink-')).length).toBe(2)
  })

  it('encodes at the quality it built the cache key from, even if the config changes while it is probing a stale entry (regression: shrinkImage must not re-resolve jpeg_quality on its own)', async () => {
    const payloadOf = (out: Awaited<ReturnType<typeof preReadImageHandler>>): string => {
      expect(out.hookType).toBe('context')
      if (out.hookType !== 'context') return ''
      const m = /data:image\/\w+;base64,([A-Za-z0-9+/=]+)/.exec(out.context)
      expect(m).not.toBeNull()
      return (m as RegExpExecArray)[1] as string
    }
    const writeQuality = (q: number): void => {
      fs.writeFileSync(_testConfigPath, '[image_shrink]\njpeg_quality = ' + String(q) + '\n', 'utf8')
      invalidateConfigCache()
    }
    const entries = (): string[] => fs.readdirSync(cacheDir).filter((f) => f.startsWith('token-goat-shrink-'))

    // Reference: a plain quality-90 shrink of this file, cold cache.
    writeQuality(90)
    const cold90 = payloadOf(await preReadImageHandler(makeEvent(filePath)))

    // Corrupt the cached entry. The handler now resolves the quality, finds that entry, and
    // awaits a decode probe of it -- the probe fails, so it falls through to a fresh encode.
    // That await is a real suspension point between the quality it captured and the encode,
    // so rewriting the config here lands strictly between the two. No timers, no spies.
    fs.writeFileSync(path.join(cacheDir, entries()[0] as string), Buffer.from([0x00, 0x01, 0x02]))
    const pending = preReadImageHandler(makeEvent(filePath))
    writeQuality(10)
    const served = payloadOf(await pending)

    // Byte-for-byte the quality-90 encode the key was built from. When shrinkImage resolved the
    // quality itself it produced the quality-10 encode here and stored it under the quality-90
    // key -- a permanently stale entry, the same defect the key change fixes.
    expect(served).toBe(cold90)
  })

  it('treats a corrupt/truncated cache entry as a miss, deletes it, and still returns a valid shrink', async () => {
    await preReadImageHandler(makeEvent(filePath))
    const entries = fs.readdirSync(cacheDir).filter((f) => f.startsWith('token-goat-shrink-'))
    expect(entries.length).toBe(1)
    const cachedPath = path.join(cacheDir, entries[0] as string)

    // Truncate the cached file so it no longer decodes.
    fs.writeFileSync(cachedPath, Buffer.from([0x00, 0x01, 0x02]))

    const out = await preReadImageHandler(makeEvent(filePath))
    expect(out.hookType).toBe('context')
    if (out.hookType !== 'context') return
    expect(out.context).toContain('data:image/')

    // The corrupt (3-byte) entry was deleted and a freshly written valid shrink was written
    // back to the same key -- the file at cachedPath exists again, but it is no longer the
    // corrupt 3-byte payload, and there is still exactly one entry (not a stray second one).
    expect(fs.readFileSync(cachedPath).length).toBeGreaterThan(3)
    const entriesAfter = fs.readdirSync(cacheDir).filter((f) => f.startsWith('token-goat-shrink-'))
    expect(entriesAfter.length).toBe(1)
  })

  it('prunes cache entries older than DEFAULT_MAX_AGE_MS without touching an unrelated file in the same directory', async () => {
    await preReadImageHandler(makeEvent(filePath))
    const entries = fs.readdirSync(cacheDir).filter((f) => f.startsWith('token-goat-shrink-'))
    expect(entries.length).toBe(1)
    const cachedPath = path.join(cacheDir, entries[0] as string)

    // A sentinel that does NOT carry this cache's filename prefix, in the exact same
    // directory -- proves the sweep is scoped by prefix, not "everything in this dir".
    const sentinelPath = path.join(cacheDir, 'not-a-shrink-cache-file.txt')
    fs.writeFileSync(sentinelPath, 'do not delete me')

    // Age both files past the prune cutoff.
    const old = new Date(Date.now() - 25 * 3600 * 1000) // > DEFAULT_MAX_AGE_MS (24h)
    fs.utimesSync(cachedPath, old, old)
    fs.utimesSync(sentinelPath, old, old)

    resetShrinkCachePruneThrottleForTests()
    // Any Read on an image path re-enters preReadImageHandler, which sweeps the cache
    // dir first; the file doesn't need to be the same image being pruned.
    fs.writeFileSync(path.join(dir, 'unrelated.png'), smallPng)
    await preReadImageHandler(makeEvent(path.join(dir, 'unrelated.png')))

    expect(fs.existsSync(cachedPath)).toBe(false)
    expect(fs.existsSync(sentinelPath)).toBe(true)
  })
})

describe('preReadImageHandler + OCR wiring', () => {
  const ocrStubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ocr-wiring-stub-'))

  function writeStub(name: string, body: string): string {
    const file = path.join(ocrStubDir, `${name}.cjs`)
    fs.writeFileSync(file, body, 'utf8')
    return file
  }

  it('returns the OCR text instead of a data URL when the image is text-heavy (confidence above threshold)', async () => {
    setTesseractEntryForTesting(
      writeStub(
        'text-heavy',
        `module.exports.createWorker = async function () {
          return {
            recognize: async () => ({ data: { text: 'a'.repeat(100), confidence: 92 } }),
            terminate: async () => {},
          }
        }`,
      ),
    )
    const out = await preReadImageHandler(makeEvent(largePngPath))
    expect(out.hookType).toBe('context')
    if (out.hookType !== 'context') return
    expect(out.context).toContain('a'.repeat(100))
    expect(out.context).not.toContain('data:image/')
  })

  it('still records the image_shrink pixel-saving row when the OCR branch fires, not only image_ocr (regression: the image_shrink recordStat sat below the OCR early-return, so a text-heavy image -- exactly what OCR targets -- dropped its whole pixel-shrink saving from the ledger and recorded image_ocr alone)', async () => {
    setTesseractEntryForTesting(
      writeStub(
        'text-heavy-stats',
        `module.exports.createWorker = async function () {
          return {
            recognize: async () => ({ data: { text: 'a'.repeat(100), confidence: 92 } }),
            terminate: async () => {},
          }
        }`,
      ),
    )
    const shrinkBefore = summarize(30).by_kind['image_shrink']
    const shrinkEventsBefore = shrinkBefore?.events ?? 0
    const shrinkBytesBefore = shrinkBefore?.bytes_saved ?? 0
    const ocrBefore = summarize(30).by_kind['image_ocr']
    const ocrEventsBefore = ocrBefore?.events ?? 0

    const out = await preReadImageHandler(makeEvent(largePngPath))
    expect(out.hookType).toBe('context')
    if (out.hookType !== 'context') return
    // OCR replaced the data URL -- confirms the OCR branch, not the plain shrink path, ran.
    expect(out.context).toContain('a'.repeat(100))
    expect(out.context).not.toContain('data:image/')

    // The OCR row is recorded...
    const ocrAfter = summarize(30).by_kind['image_ocr']
    expect(ocrAfter?.events ?? 0).toBeGreaterThan(ocrEventsBefore)
    // ...AND the pixel-shrink row is still recorded on the same call, with its real byte saving.
    const shrinkAfter = summarize(30).by_kind['image_shrink']
    expect(shrinkAfter).toBeDefined()
    expect(shrinkAfter?.events ?? 0).toBeGreaterThan(shrinkEventsBefore)
    expect(shrinkAfter?.bytes_saved ?? 0).toBeGreaterThan(shrinkBytesBefore)

    // This path decodes an image into text and puts it straight into model context without anyone
    // asking for OCR, so the recovered text is fenced on provenance rather than on a pattern hit.
    expect(out.context).toContain('<untrusted-image-text>')

    // The saving must be priced on the payload this branch actually emits, header and fence
    // included. Crediting only the bare recognized text bills a smaller thing than the one that
    // ships, which is the recurring shape of over-credit in this codebase.
    const shrinkDelta = (shrinkAfter?.bytes_saved ?? 0) - shrinkBytesBefore
    const shrunkBytes = fs.statSync(largePngPath).size - shrinkDelta
    const ocrDelta = (ocrAfter?.bytes_saved ?? 0) - (ocrBefore?.bytes_saved ?? 0)
    expect(ocrDelta).toBe(Math.max(0, shrunkBytes - Buffer.byteLength(out.context, 'utf8')))
  })

  it('falls back to the pixel-shrink data URL when OCR confidence is below the configured threshold', async () => {
    setTesseractEntryForTesting(
      writeStub(
        'low-confidence',
        `module.exports.createWorker = async function () {
          return {
            recognize: async () => ({ data: { text: 'STOP', confidence: 20 } }),
            terminate: async () => {},
          }
        }`,
      ),
    )
    const out = await preReadImageHandler(makeEvent(largePngPath))
    expect(out.hookType).toBe('context')
    if (out.hookType !== 'context') return
    expect(out.context).toContain('data:image/')
  })

  it('falls back to the pixel-shrink data URL when ocr_enabled is false, without attempting OCR at all', async () => {
    fs.writeFileSync(_testConfigPath, '[image_shrink]\nocr_enabled = false\n', 'utf8')
    invalidateConfigCache()
    // A stub that would throw if ever invoked -- proves the config gate short-circuits before spawning.
    setTesseractEntryForTesting(
      writeStub(
        'should-not-run',
        `module.exports.createWorker = async function () { throw new Error('OCR should not have been attempted') }`,
      ),
    )
    const out = await preReadImageHandler(makeEvent(largePngPath))
    expect(out.hookType).toBe('context')
    if (out.hookType !== 'context') return
    expect(out.context).toContain('data:image/')
  })

  it('falls back to the pixel-shrink data URL when OCR is unavailable (dep unresolved)', async () => {
    setTesseractEntryForTesting(null)
    const out = await preReadImageHandler(makeEvent(largePngPath))
    expect(out.hookType).toBe('context')
    if (out.hookType !== 'context') return
    expect(out.context).toContain('data:image/')
  })
})

describe('composed pre_tool_use dispatch (real runHook)', () => {
  // hooks_read.ts's generic large-file deny threshold is 500KB; image_shrink.ts's
  // own "worth shrinking" threshold is 512KB. A file in between is too big for the
  // deny check to let through, but too small for the shrink handler to touch —
  // the dead zone where a flat deny previously won regardless of what the shrink
  // handler would have done.
  const overlapBytes = 505 * 1024 // 517,120 bytes: inside [512,000, 524,288)
  let overlapDir: string
  let overlapImagePath: string
  let prevHome: string | undefined
  let tmpHome: string

  beforeEach(() => {
    prevHome = process.env['TOKEN_GOAT_HOME']
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-composed-home-'))
    process.env['TOKEN_GOAT_HOME'] = tmpHome

    overlapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-overlap-'))
    overlapImagePath = path.join(overlapDir, 'overlap.png')
    // Content doesn't need to be a decodable image: at this size image_shrink's
    // own threshold (512KB) means it never attempts to decode/shrink it anyway —
    // the point is exercising the size-gate composition, not the shrink itself.
    fs.writeFileSync(overlapImagePath, Buffer.alloc(overlapBytes, 1))
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
    else process.env['TOKEN_GOAT_HOME'] = prevHome
    fs.rmSync(tmpHome, { recursive: true, force: true })
    fs.rmSync(overlapDir, { recursive: true, force: true })
  })

  it('does not unconditionally deny a Read of an image sized in the 500-512KB overlap window', async () => {
    const event = buildEvent('pre_tool_use', {
      tool_name: 'Read',
      tool_input: { file_path: overlapImagePath },
      session_id: 'composed-1',
    })
    const result = await runHook(event)
    expect(result.hookType).not.toBe('deny')
  })

  it('still denies a same-sized non-image file via the generic large-file deny', async () => {
    const textPath = path.join(overlapDir, 'overlap.txt')
    fs.writeFileSync(textPath, Buffer.alloc(overlapBytes, 97)) // 'a'
    const event = buildEvent('pre_tool_use', {
      tool_name: 'Read',
      tool_input: { file_path: textPath },
      session_id: 'composed-2',
    })
    const result = await runHook(event)
    expect(result.hookType).toBe('deny')
  })
})
