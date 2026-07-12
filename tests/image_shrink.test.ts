import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'

// The jpeg_quality/max_image_pixels regression tests need a writable config, so
// configPath() is redirected (hoisted vi.mock) to a per-test-run temp file — the
// same pattern tests/config.test.ts and tests/bash_compress_rewrite.test.ts use.
const _testConfigPath = path.join(os.tmpdir(), `tg-image-shrink-config-${process.pid}.toml`)
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, configPath: () => _testConfigPath }
})

import { isImagePath, preReadImageHandler, shrinkImage } from '../src/image_shrink.js'
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

beforeEach(() => {
  try {
    fs.unlinkSync(_testConfigPath)
  } catch {
    // no config file → schema defaults, matching this suite's behaviour before the mock existed
  }
  invalidateConfigCache()
})

afterEach(() => {
  try {
    fs.unlinkSync(_testConfigPath)
  } catch {
    // already absent
  }
  invalidateConfigCache()
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

  it('passes for a missing image file', async () => {
    const out = await preReadImageHandler(makeEvent(path.join(TMP, 'nope.png')))
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
