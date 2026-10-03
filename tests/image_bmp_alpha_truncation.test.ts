/** BMP alpha and truncation. Fixture provenance: gdi-getdibits32-64x48.bmp is CAPTURE (real Windows GDI GetDIBits output, row in tests/fixtures/PROVENANCE.tsv). The synthetic buffers are HAND-DERIVED from the BMP file format: BITMAPFILEHEADER (14 bytes), BITMAPINFOHEADER (40) or BITMAPV4HEADER (108, masks at header offsets 40/44/48/52 = R/G/B/A), pixels stored bottom-up as B,G,R,X. */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { decodeBmp } from '../src/image_engine.js'

const FIXTURES = path.join(__dirname, 'fixtures')

interface Bmp32Options {
  compression: number
  pixel: [number, number, number, number]
  alphaMask?: number
}

/** A 2x1 32bpp BMP whose two pixels are both `pixel` (B,G,R,X byte order). */
function bmp32({ compression, pixel, alphaMask }: Bmp32Options): Buffer {
  const dibSize = alphaMask === undefined ? 40 : 108
  const pixelOffset = 14 + dibSize
  const buf = Buffer.alloc(pixelOffset + 8)
  buf[0] = 0x42
  buf[1] = 0x4d
  buf.writeUInt32LE(buf.length, 2)
  buf.writeUInt32LE(pixelOffset, 10)
  buf.writeUInt32LE(dibSize, 14)
  buf.writeInt32LE(2, 18)
  buf.writeInt32LE(1, 22)
  buf.writeUInt16LE(1, 26)
  buf.writeUInt16LE(32, 28)
  buf.writeUInt32LE(compression, 30)
  if (alphaMask !== undefined) {
    buf.writeUInt32LE(0x00ff0000, 14 + 40)
    buf.writeUInt32LE(0x0000ff00, 14 + 44)
    buf.writeUInt32LE(0x000000ff, 14 + 48)
    buf.writeUInt32LE(alphaMask, 14 + 52)
  }
  for (let i = 0; i < 2; i++) Buffer.from(pixel).copy(buf, pixelOffset + i * 4)
  return buf
}

describe('32bpp BMP alpha', () => {
  it('decodes a real GDI GetDIBits BI_RGB capture as opaque', () => {
    const file = fs.readFileSync(path.join(FIXTURES, 'gdi-getdibits32-64x48.bmp'))
    // The capture really has the shape of the bug: BI_RGB, reserved byte 0 in the first pixel.
    expect(file.readUInt32LE(30)).toBe(0)
    expect(file[57]).toBe(0)
    const out = decodeBmp(file)
    expect([out.width, out.height]).toEqual([64, 48])
    const px = (x: number, y: number): number[] => Array.from(out.data.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 4))
    // HAND-DERIVED from the capture script: red fill, blue over the top-left 32x24 quarter.
    expect(px(10, 10)).toEqual([0, 0, 255, 255])
    expect(px(60, 40)).toEqual([255, 0, 0, 255])
    for (let i = 3; i < out.data.length; i += 4) expect(out.data[i]).toBe(255)
  })

  it('keeps a BI_RGB alpha byte that is actually used', () => {
    const out = decodeBmp(bmp32({ compression: 0, pixel: [1, 2, 3, 128] }))
    expect(Array.from(out.data.subarray(0, 4))).toEqual([3, 2, 1, 128])
  })

  it('honours a zero alpha under BI_BITFIELDS with an alpha mask', () => {
    const out = decodeBmp(bmp32({ compression: 3, pixel: [1, 2, 3, 0], alphaMask: 0xff000000 }))
    expect(Array.from(out.data.subarray(0, 4))).toEqual([3, 2, 1, 0])
  })

  it('ignores the fourth byte under BI_BITFIELDS with no alpha mask', () => {
    const out = decodeBmp(bmp32({ compression: 3, pixel: [1, 2, 3, 0], alphaMask: 0 }))
    expect(Array.from(out.data.subarray(0, 4))).toEqual([3, 2, 1, 255])
  })
})

describe('truncated BMP', () => {
  it('throws instead of filling the missing rows with black', () => {
    const file = fs.readFileSync(path.join(FIXTURES, 'gdi-getdibits32-64x48.bmp'))
    expect(() => decodeBmp(file.subarray(0, file.length - 4 * 64 * 10))).toThrow(/truncated/)
  })

  it('throws for a header that promises far more pixel data than the file holds', () => {
    const buf = Buffer.alloc(54 + 1000)
    buf[0] = 0x42
    buf[1] = 0x4d
    buf.writeUInt32LE(54, 10)
    buf.writeUInt32LE(40, 14)
    buf.writeInt32LE(500, 18)
    buf.writeInt32LE(500, 22)
    buf.writeUInt16LE(1, 26)
    buf.writeUInt16LE(24, 28)
    expect(() => decodeBmp(buf)).toThrow(/truncated/)
  })

  it('accepts a 24bpp file whose last row omits its padding', () => {
    const buf = Buffer.alloc(54 + 3)
    buf[0] = 0x42
    buf[1] = 0x4d
    buf.writeUInt32LE(54, 10)
    buf.writeUInt32LE(40, 14)
    buf.writeInt32LE(1, 18)
    buf.writeInt32LE(1, 22)
    buf.writeUInt16LE(1, 26)
    buf.writeUInt16LE(24, 28)
    expect(decodeBmp(buf).data).toHaveLength(4)
  })
})
