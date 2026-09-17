import * as fs from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { applyExifOrientation, decodeJpeg, decodePng, encodeJpeg, probeBufferMeta } from '../src/image_engine.js'
import { SHRINK_ENGINE_REVISION, preReadImageHandler, shrinkCacheKeyForRevision } from '../src/image_shrink.js'
import { makeHookEvent } from './helpers/hook-event.js'

// HAND-DERIVED. The RGBA corner values and the expected landing coordinates below are computed from
// the EXIF specification's meaning of tag 274, not read off this repo's rotation code. The APP1
// segment layout is FORMAT-DERIVED from TIFF 6.0 section 2 / Exif 2.32 section 4.6.2: SOI, then
// 0xFFE1, a big-endian segment length, "Exif\0\0", a little-endian TIFF header ("II", 0x002A,
// first-IFD offset 8), an IFD of one entry (tag 0x0112, type 3 SHORT, count 1, value = orientation)
// and a zero next-IFD pointer.
function withExifOrientation(jpeg: Buffer, orientation: number): Buffer {
  const tiff = Buffer.alloc(26)
  tiff.write('II', 0, 'ascii')
  tiff.writeUInt16LE(0x2a, 2)
  tiff.writeUInt32LE(8, 4)
  tiff.writeUInt16LE(1, 8)
  tiff.writeUInt16LE(0x0112, 10)
  tiff.writeUInt16LE(3, 12)
  tiff.writeUInt32LE(1, 14)
  tiff.writeUInt16LE(orientation, 18)
  tiff.writeUInt32LE(0, 22)

  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff])
  const header = Buffer.alloc(4)
  header.writeUInt16BE(0xffe1, 0)
  header.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([jpeg.subarray(0, 2), header, payload, jpeg.subarray(2)])
}

/**
 * A 4x2 frame whose four corners are four distinct colours, so a wrong rotation is always
 * detectable: a symmetric subject cannot tell 90 from 270 and would pass on half the defect.
 * Storage order corners -- TL red, TR green, BL blue, BR white.
 */
const W = 4
const H = 2
const TL = [255, 0, 0, 255]
const TR = [0, 255, 0, 255]
const BL = [0, 0, 255, 255]
const BR = [255, 255, 255, 255]

function cornerFrame(): Buffer {
  const rgba = Buffer.alloc(W * H * 4)
  const put = (x: number, y: number, c: number[]): void => {
    const off = (y * W + x) * 4
    for (let i = 0; i < 4; i++) rgba[off + i] = c[i] as number
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(x, y, [64, 64, 64, 255])
  put(0, 0, TL)
  put(W - 1, 0, TR)
  put(0, H - 1, BL)
  put(W - 1, H - 1, BR)
  return rgba
}

function pixelAt(data: Uint8Array, width: number, x: number, y: number): number[] {
  const off = (y * width + x) * 4
  return [data[off] as number, data[off + 1] as number, data[off + 2] as number, data[off + 3] as number]
}

describe('applyExifOrientation moves pixels the way EXIF tag 274 specifies', () => {
  // Must not drop: these are the literal corner landings each orientation is defined by. 1 top-left
  // (identity), 2 top-right (mirror horizontal), 3 bottom-right (rotate 180), 4 bottom-left (mirror
  // vertical), 5 left-top (transpose), 6 right-top (rotate 90 CW), 7 right-bottom (transverse),
  // 8 left-bottom (rotate 270 CW). Each case names where the storage top-left pixel ends up, and
  // the resulting frame dimensions.
  const cases: Array<{ orientation: number; dims: [number, number]; tlLandsAt: [number, number] }> = [
    { orientation: 1, dims: [4, 2], tlLandsAt: [0, 0] },
    { orientation: 2, dims: [4, 2], tlLandsAt: [3, 0] },
    { orientation: 3, dims: [4, 2], tlLandsAt: [3, 1] },
    { orientation: 4, dims: [4, 2], tlLandsAt: [0, 1] },
    { orientation: 5, dims: [2, 4], tlLandsAt: [0, 0] },
    { orientation: 6, dims: [2, 4], tlLandsAt: [1, 0] },
    { orientation: 7, dims: [2, 4], tlLandsAt: [1, 3] },
    { orientation: 8, dims: [2, 4], tlLandsAt: [0, 3] },
  ]

  for (const { orientation, dims, tlLandsAt } of cases) {
    it(`orientation ${orientation} puts the storage top-left corner at ${tlLandsAt[0]},${tlLandsAt[1]} in a ${dims[0]}x${dims[1]} frame`, () => {
      const out = applyExifOrientation(cornerFrame(), W, H, orientation)
      expect([out.width, out.height]).toEqual(dims)
      expect(pixelAt(out.data, out.width, tlLandsAt[0], tlLandsAt[1])).toEqual(TL)
    })
  }

  it('lands all four corners, not just one, for orientation 6', () => {
    // Rotate 90 CW: storage TL -> display TR, TR -> BR, BR -> BL, BL -> TL.
    const out = applyExifOrientation(cornerFrame(), W, H, 6)
    expect(pixelAt(out.data, out.width, 1, 0)).toEqual(TL)
    expect(pixelAt(out.data, out.width, 1, 3)).toEqual(TR)
    expect(pixelAt(out.data, out.width, 0, 3)).toEqual(BR)
    expect(pixelAt(out.data, out.width, 0, 0)).toEqual(BL)
  })

  it('orientation 1 returns the input buffer itself, byte-identical and unresized', () => {
    const src = cornerFrame()
    const out = applyExifOrientation(src, W, H, 1)
    expect(Buffer.from(out.data).equals(src)).toBe(true)
    expect([out.width, out.height]).toEqual([W, H])
  })

  it('treats an absent tag as identity', () => {
    const src = cornerFrame()
    const out = applyExifOrientation(src, W, H, undefined)
    expect(Buffer.from(out.data).equals(src)).toBe(true)
  })
})

describe('probeBufferMeta reports display geometry for a transposing orientation', () => {
  it('swaps width and height for orientation 6 and surfaces the tag', () => {
    const landscape = encodeJpeg(40, 20, Buffer.alloc(40 * 20 * 4, 0x7f), 70)
    expect(probeBufferMeta(landscape)).toMatchObject({ width: 40, height: 20, orientation: 1 })
    const rotated = probeBufferMeta(withExifOrientation(landscape, 6))
    // Must not drop: the swap is the user-visible `image-meta` contract -- what a viewer shows.
    expect(rotated).toMatchObject({ width: 20, height: 40, format: 'jpeg', orientation: 6 })
  })

  it('leaves the non-transposing orientation 3 unswapped but still reports it', () => {
    const landscape = encodeJpeg(40, 20, Buffer.alloc(40 * 20 * 4, 0x7f), 70)
    expect(probeBufferMeta(withExifOrientation(landscape, 3))).toMatchObject({ width: 40, height: 20, orientation: 3 })
  })
})

describe('shrink cache key is salted by the engine revision', () => {
  it('produces a different key for the same file under a different revision', () => {
    const a = shrinkCacheKeyForRevision(SHRINK_ENGINE_REVISION, '/x/photo.jpg', 1234, 99, 80)
    const b = shrinkCacheKeyForRevision(SHRINK_ENGINE_REVISION + 1, '/x/photo.jpg', 1234, 99, 80)
    expect(a).not.toBe(b)
    expect(shrinkCacheKeyForRevision(SHRINK_ENGINE_REVISION, '/x/photo.jpg', 1234, 99, 80)).toBe(a)
  })
})

describe('the delivered image for an EXIF-rotated photo is rotated, not sheared', () => {
  // A 2400x1600 landscape frame carrying orientation 6, with a red block at storage (300..700,
  // 200..500) and a green block at storage (2100..2300, 1300..1500). Big blocks and a gradient
  // background so the JPEG survives a downscale and re-encode with its corners intact.
  const SRC_W = 2400
  const SRC_H = 1600
  const RED = [220, 30, 30]
  const GREEN = [30, 200, 60]

  function subjectFrame(): Buffer {
    const rgba = Buffer.alloc(SRC_W * SRC_H * 4)
    for (let y = 0; y < SRC_H; y++) {
      for (let x = 0; x < SRC_W; x++) {
        const off = (y * SRC_W + x) * 4
        const inRed = x >= 300 && x < 700 && y >= 200 && y < 500
        const inGreen = x >= 2100 && x < 2300 && y >= 1300 && y < 1500
        // Background noise lives in the blue channel only, so no background pixel can fall inside the match tolerance of either subject colour and be counted into its box.
        const c = inRed ? RED : inGreen ? GREEN : [50, 50, 100 + ((x * 7 + y * 13) % 100)]
        rgba[off] = c[0] as number
        rgba[off + 1] = c[1] as number
        rgba[off + 2] = c[2] as number
        rgba[off + 3] = 255
      }
    }
    return rgba
  }

  function bbox(data: Uint8Array, width: number, height: number, rgb: number[]): [number, number, number, number] | null {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const off = (y * width + x) * 4
        if (Math.abs((data[off] as number) - (rgb[0] as number)) < 60 &&
            Math.abs((data[off + 1] as number) - (rgb[1] as number)) < 60 &&
            Math.abs((data[off + 2] as number) - (rgb[2] as number)) < 60) {
          if (x < x0) x0 = x
          if (y < y0) y0 = y
          if (x > x1) x1 = x
          if (y > y1) y1 = y
        }
      }
    }
    return x1 < 0 ? null : [x0, y0, x1, y1]
  }

  async function deliver(buf: Buffer, tag: string): Promise<{ data: Uint8Array; width: number; height: number } | null> {
    const dir = fs.mkdtempSync(path.join(process.env.TEMP ?? '/tmp', 'tg-exif-'))
    const file = path.join(dir, `${tag}.jpg`)
    fs.writeFileSync(file, buf)
    const out = await preReadImageHandler(makeHookEvent({ toolName: 'Read', toolInput: { file_path: file } }))
    const m = /data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)/.exec(JSON.stringify(out ?? {}))
    if (m === null) return null
    const bytes = Buffer.from(m[2] as string, 'base64')
    return m[1] === 'png' ? decodePng(bytes) : decodeJpeg(bytes)
  }

  it('delivers an orientation-6 landscape photo as an upright portrait with the subject where a viewer would see it', async () => {
    const jpeg = encodeJpeg(SRC_W, SRC_H, subjectFrame(), 90)
    const delivered = await deliver(withExifOrientation(jpeg, 6), 'rot6')
    expect(delivered).not.toBeNull()
    const { data, width, height } = delivered as { data: Uint8Array; width: number; height: number }

    // A landscape frame tagged orientation 6 is a portrait photo. Dimensions alone do not catch the
    // defect -- the shear produced plausible portrait dimensions too -- so the boxes below carry it.
    expect(height).toBeGreaterThan(width)

    // Rotate 90 CW maps storage (x, y) to display (SRC_H - 1 - y, x), then the fit-inside downscale
    // divides by SRC_H / width. Must not drop: these literal coordinates are the whole assertion.
    const scale = width / SRC_H
    const expectRed: [number, number, number, number] = [
      Math.round((SRC_H - 500) * scale), Math.round(300 * scale),
      Math.round((SRC_H - 200) * scale), Math.round(700 * scale),
    ]
    const expectGreen: [number, number, number, number] = [
      Math.round((SRC_H - 1500) * scale), Math.round(2100 * scale),
      Math.round((SRC_H - 1300) * scale), Math.round(2300 * scale),
    ]
    const red = bbox(data, width, height, RED)
    const green = bbox(data, width, height, GREEN)
    expect(red).not.toBeNull()
    expect(green).not.toBeNull()
    for (let i = 0; i < 4; i++) {
      expect(Math.abs((red as number[])[i] as number - (expectRed[i] as number))).toBeLessThanOrEqual(12)
      expect(Math.abs((green as number[])[i] as number - (expectGreen[i] as number))).toBeLessThanOrEqual(12)
    }
  })
})
