/**
 * The image decoders against files built to abuse them.
 *
 * Every buffer in `image_engine.ts` is sized from a number in the file's own header, and until the
 * decoders were bounded the file chose how much memory token-goat allocated and how long it ran.
 * That surface arrived with the move off sharp: libvips enforced `limitInputPixels` inside the
 * decode, whereas `image_shrink.max_image_pixels` is a check on the header's `width * height` run
 * in front of hand-rolled decoders that had no limits of their own. It never saw a frame count or a
 * compression ratio, so three of the five files below pass it with room to spare.
 *
 * Fixture provenance: HAND-DERIVED. Every file here is assembled byte by byte in this file from the
 * published container formats -- GIF89a (w3.org/Graphics/GIF/spec-gif89a.txt), PNG (w3.org/TR/png),
 * BMP's BITMAPINFOHEADER, TIFF 6.0 section 2 -- and not from anything this repo emits. That
 * direction matters here more than usual: a fixture produced by our own encoder can only describe
 * images we already write correctly, and every defect in this file is about a file we would never
 * have produced ourselves. The numbers quoted in the comments are measurements taken against the
 * decoders before they were bounded, not estimates.
 */

import * as zlib from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { decodeBmp, decodeGif, decodePng, probeBufferMeta } from '../src/image_engine.js'

// --- PNG construction -------------------------------------------------------------------------

const CRC_TABLE: number[] = []
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c >>> 0
}

function crc32(b: Buffer): number {
  let c = 0xffffffff
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([len, typed, crc])
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function png(opts: {
  width: number
  height: number
  bitDepth?: number
  colorType?: number
  interlace?: number
  raw: Buffer
}): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(opts.width, 0)
  ihdr.writeUInt32BE(opts.height, 4)
  ihdr[8] = opts.bitDepth ?? 8
  ihdr[9] = opts.colorType ?? 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = opts.interlace ?? 0
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(opts.raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** One filter byte plus `width * 4` sample bytes per row: what an 8-bit RGBA image really contains. */
function honestRgbaRows(width: number, height: number, fill = 0x40): Buffer {
  const rowSize = 1 + width * 4
  const raw = Buffer.alloc(rowSize * height, fill)
  for (let y = 0; y < height; y++) raw[y * rowSize] = 0
  return raw
}

// --- GIF construction -------------------------------------------------------------------------

/**
 * A GIF declaring a `width` x `height` canvas and `frames` frames, each frame a 1x1 sub-image.
 *
 * The sub-frame is 1x1 so the *file* stays tiny while each decoded frame is a full canvas. That
 * asymmetry is the whole attack: the cost of declaring a frame is about 23 bytes, and the cost of
 * decoding one is `width * height * 4`.
 */
function gif(width: number, height: number, frames: number): Buffer {
  const parts: Buffer[] = [Buffer.from('GIF89a', 'ascii')]
  const lsd = Buffer.alloc(7)
  lsd.writeUInt16LE(width, 0)
  lsd.writeUInt16LE(height, 2)
  lsd[4] = 0x80
  parts.push(lsd, Buffer.from([0, 0, 0, 255, 255, 255]))
  for (let i = 0; i < frames; i++) {
    parts.push(Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00]))
    const id = Buffer.alloc(10)
    id[0] = 0x2c
    id.writeUInt16LE(1, 5)
    id.writeUInt16LE(1, 7)
    parts.push(id, Buffer.from([0x02, 0x02, 0x4c, 0x01, 0x00]))
  }
  parts.push(Buffer.from([0x3b]))
  return Buffer.concat(parts)
}

// --- BMP construction -------------------------------------------------------------------------

function bmp(width: number, height: number, bpp: number): Buffer {
  const buf = Buffer.alloc(58)
  buf[0] = 0x42
  buf[1] = 0x4d
  buf.writeUInt32LE(58, 2)
  buf.writeUInt32LE(54, 10)
  buf.writeUInt32LE(40, 14)
  buf.writeInt32LE(width, 18)
  buf.writeInt32LE(height, 22)
  buf.writeUInt16LE(1, 26)
  buf.writeUInt16LE(bpp, 28)
  buf.writeUInt32LE(0, 30)
  return buf
}

describe('decoders refuse to allocate on a header they cannot vouch for', () => {
  it('rejects a GIF whose frame count would allocate gigabytes from a few kilobytes', () => {
    const bomb = gif(1600, 1600, 500)
    // The scale is the finding. Both of these are asserted rather than described, so a future
    // change that makes the file large or the canvas small quietly stops testing the attack.
    expect(bomb.length).toBeLessThan(16 * 1024)
    expect(1600 * 1600).toBeLessThan(16_000_000)

    expect(
      () => decodeGif(bomb),
      'A 1600x1600 GIF declaring 500 frames decoded without complaint. Each frame is a full canvas ' +
        'and all of them are retained, so this allocates about 5.1 GB from an 11.5 KB file, and it ' +
        'clears image_shrink.max_image_pixels because that gate only ever multiplies width by height.',
    ).toThrow(/decode ceiling/)
  })

  it('still decodes an animation small enough to be honest', () => {
    // The other side of the bound. A ceiling that rejects everything would pass the test above
    // while removing the feature, and nothing in that test could tell the difference.
    const ok = decodeGif(gif(48, 48, 3))
    expect(ok.frames).toHaveLength(3)
    expect(ok.width).toBe(48)
  })

  it('rejects a PNG whose image data expands past what its own dimensions allow', () => {
    // 64x64 needs 64 * (1 + 256) = 16,448 bytes of scanline. This supplies 8 MB of zeros, which
    // deflates to a few kilobytes -- the same shape as the 510 KB / 512 MB file measured against
    // the unbounded decoder, at a size that is quick to build in a test.
    const overlong = png({ width: 64, height: 64, raw: Buffer.alloc(8 * 1024 * 1024) })
    expect(overlong.length).toBeLessThan(64 * 1024)

    expect(
      () => decodePng(overlong),
      'The IDAT inflated to far more than 64x64 can hold and nothing objected. inflateSync with no ' +
        'maxOutputLength lets the compressed stream choose the allocation, which is unbounded: the ' +
        'pixel gate has already passed by this point and never looks at the stream at all.',
    ).toThrow(/exceeds the \d+ bytes/)
  })

  it('still decodes a PNG whose image data is exactly the size its dimensions call for', () => {
    const honest = decodePng(png({ width: 8, height: 4, raw: honestRgbaRows(8, 4) }))
    expect(honest.width).toBe(8)
    expect(honest.height).toBe(4)
    expect(honest.data).toHaveLength(8 * 4 * 4)
  })

  it('does not hang on a TIFF whose page chain points at itself', () => {
    // Synchronous, allocation-free, and therefore never killed: measured before the fix, this
    // 64-byte file held the thread indefinitely. In a pre-read hook that is an agent whose Read
    // never returns, which is why this asserts on elapsed time rather than only on the value.
    const buf = Buffer.alloc(64)
    buf[0] = 0x49
    buf[1] = 0x49
    buf[2] = 0x2a
    buf.writeUInt32LE(8, 4)
    buf.writeUInt16LE(2, 8)
    buf.writeUInt16LE(0x0100, 10)
    buf.writeUInt16LE(3, 12)
    buf.writeUInt32LE(1, 14)
    buf.writeUInt16LE(4, 18)
    buf.writeUInt16LE(0x0101, 22)
    buf.writeUInt16LE(3, 24)
    buf.writeUInt32LE(1, 26)
    buf.writeUInt16LE(4, 30)
    buf.writeUInt32LE(8, 34) // next IFD: this IFD

    const started = Date.now()
    const meta = probeBufferMeta(buf)
    const elapsed = Date.now() - started
    expect(elapsed, 'probeBufferMeta followed the self-referencing IFD chain instead of stopping').toBeLessThan(1000)
    expect(meta?.format).toBe('tiff')
    expect(meta?.pages, 'the self-reference should be visited once, not counted repeatedly').toBe(1)
  })
})

describe('decoders refuse input they would otherwise decode into the wrong picture', () => {
  // These are not availability bugs. Each of them returned successfully with wrong pixels, which
  // shrinkImage would re-encode and hand to the model as the contents of the file. Throwing means
  // the shrink is skipped and the untouched original is what the model sees.

  it.each([
    [16, 'two bytes per sample, read as one'],
    [4, 'two pixels packed per byte'],
    [2, 'four pixels packed per byte'],
    [1, 'eight pixels packed per byte'],
  ])('refuses a %i-bit PNG rather than decoding it as 8-bit (%s)', (bitDepth) => {
    // Measured at 16-bit before the fix: an opaque red pixel came back as [255, 255, 0, 0], a
    // transparent yellow. No error, no signal -- just a different image.
    expect(() => decodePng(png({ width: 2, height: 1, bitDepth, raw: Buffer.alloc(64) }))).toThrow(
      /Unsupported PNG bit depth/,
    )
  })

  it('refuses an interlaced PNG rather than decoding it as progressive', () => {
    expect(() =>
      decodePng(png({ width: 8, height: 4, interlace: 1, raw: honestRgbaRows(8, 4) })),
    ).toThrow(/interlace/)
  })

  it.each([8, 16, 4, 1])('refuses a %i-bit BMP rather than returning a blank image', (bpp) => {
    // The pixel loop only has branches for 24 and 32. Every other depth fell straight through it
    // and returned the zero-filled buffer, which is a fully transparent image reported as a success.
    expect(() => decodeBmp(bmp(1, 1, bpp))).toThrow(/Unsupported BMP bit depth/)
  })

  it('refuses a BMP whose signed width is negative', () => {
    // width * height goes negative, which passes any `> limit` test, and the allocation then throws
    // somewhere less obvious. The dimensions are checked for validity, not merely for size.
    expect(() => decodeBmp(bmp(-4, 4, 24))).toThrow(/Invalid BMP dimensions/)
  })

  it('still decodes the depths it does support', () => {
    for (const bpp of [24, 32]) {
      const out = decodeBmp(bmp(1, 1, bpp))
      expect(out.width).toBe(1)
      expect(out.data).toHaveLength(4)
    }
  })
})
