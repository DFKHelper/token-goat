import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import sharp from 'sharp'

import { isImagePath, preReadImageHandler, shrinkImage } from '../src/image_shrink.js'
import type { HookEvent } from '../src/hook_registry.js'
// Importing relay registers EVERY hook module (hooks_read's large-file deny AND
// image_shrink's preReadImageHandler) for its side-effects, so runHook dispatches
// through the real production registry — the only way to observe the composed
// pre_tool_use decision both handlers produce together, not either in isolation.
import { buildEvent } from '../src/relay.js'
import { runHook } from '../src/hook_registry.js'

function makeEvent(filePath: string | undefined): HookEvent {
  return {
    eventName: 'pre_tool_use',
    toolName: 'Read',
    toolInput: filePath === undefined ? {} : { file_path: filePath },
    sessionId: 's1',
    raw: {},
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-img-'))

// A tiny PNG, comfortably under the 512KB threshold.
let smallPng: Buffer
// A large, noisy image whose bytes exceed the threshold so it can shrink.
let largeJpeg: Buffer
let largePngPath: string
let smallPngPath: string

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
