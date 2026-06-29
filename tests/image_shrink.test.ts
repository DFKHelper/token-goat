import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import sharp from 'sharp'

import { isImagePath, preReadImageHandler, shrinkImage } from '../src/image_shrink.js'
import type { HookEvent } from '../src/hook_registry.js'

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
