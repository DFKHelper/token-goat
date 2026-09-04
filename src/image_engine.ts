/**
 * Pure TypeScript / JavaScript Image Processing Engine for token-goat.
 *
 * Provides zero-native-dependency image metadata extraction, decoding, resampling,
 * and re-encoding for PNG, JPEG, GIF, BMP, WebP, TIFF, and SVG formats.
 *
 * No native decoder, so none of the C buffer-overflow classes that come with one. That is not the
 * same as being safe on untrusted input, and the difference is what {@link MAX_DECODED_BYTES} and
 * its call sites below exist for: every buffer here is sized from a number an attacker wrote in a
 * file header, and a size check is the only thing standing between that number and the allocator.
 */

import * as zlib from "node:zlib"
import jpeg from "jpeg-js"
import omggif from "omggif"

/**
 * Ceiling on the pixel buffer a single decode may allocate, in bytes.
 *
 * Every decoder below sizes its output from the image's own header, so without a ceiling the file
 * chooses how much memory token-goat allocates. Measured on this engine before the ceiling existed:
 * a 3.7 KB GIF declaring a 1600x1600 canvas and 160 frames allocated 1,562 MB, linearly, because
 * each frame is a full canvas and all of them are held at once -- 500 frames fits in 11.5 KB and
 * comes to 5.1 GB. `image_shrink.max_image_pixels` does not stop it: that gate is `width * height`
 * and never looks at the frame count, so 1600x1600 passes with 84% of the budget to spare.
 *
 * 256 MB is four times the largest still the default 16 MP gate admits (16,000,000 x 4 bytes of
 * RGBA = 61 MB), so no single image that passes that gate is refused here. What it bounds is the
 * multi-frame case, where roughly 26 frames fit at the 1568px resize target and around 130 at
 * 800x600. Refusing is cheap: {@link shrinkImage} catches the throw and returns null, which passes
 * the original file through to the model untouched. Declining to shrink a very long animation is a
 * better outcome than allocating gigabytes to do it.
 */
const MAX_DECODED_BYTES = 256 * 1024 * 1024

/**
 * Throw unless a `width * height * bytesPerPixel * frames` buffer is within {@link MAX_DECODED_BYTES}.
 *
 * Takes the dimensions rather than the product so the multiplication happens here, where it is
 * checked, instead of at each call site where an overflow to `Infinity` or a negative from a signed
 * header field would be passed in already collapsed to something that compares as safe.
 *
 * Exported because the decoders are not the only place a frame count sizes a buffer: the animated
 * branch of {@link shrinkImage} allocates its GIF output the same way, and one ceiling covering
 * both is the only way peak memory is actually the number this file advertises.
 */
export function assertDecodableSize(
  what: string,
  width: number,
  height: number,
  bytesPerPixel: number,
  frames = 1,
): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || frames <= 0) {
    throw new Error(`Invalid ${what} dimensions: ${width}x${height} (${frames} frame(s))`)
  }
  const bytes = width * height * bytesPerPixel * frames
  if (bytes > MAX_DECODED_BYTES) {
    throw new Error(
      `${what} would allocate ${Math.round(bytes / 1048576)}MB, over the ${MAX_DECODED_BYTES / 1048576}MB decode ceiling`,
    )
  }
}

export interface ImageMeta {
  width: number
  height: number
  format: string | null
  pages: number
}

export interface DecodedImage {
  width: number
  height: number
  data: Buffer
}

export interface AnimatedGifFrame {
  width: number
  height: number
  x: number
  y: number
  delay: number
  disposal: number
  data: Buffer
}

export interface DecodedAnimatedGif {
  width: number
  height: number
  frames: AnimatedGifFrame[]
}

const CRC_TABLE = new Int32Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
  }
  CRC_TABLE[i] = c
}

function crc32(buf: Uint8Array): number {
  let crc = -1
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i] ?? 0
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  }
  return (crc ^ -1) >>> 0
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

export function probeBufferMeta(buf: Buffer): ImageMeta | null {
  if (buf.length < 8) return null

  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    if (buf.length < 24) return null
    const width = buf.readUInt32BE(16)
    const height = buf.readUInt32BE(20)
    return { width, height, format: "png", pages: 1 }
  }

  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let pos = 2
    let width = 0
    let height = 0
    let orientation = 1

    while (pos < buf.length - 1) {
      if (buf[pos] !== 0xff) {
        pos++
        continue
      }
      const marker = buf[pos + 1]
      if (marker === undefined) break
      pos += 2

      if (marker === 0xd8 || marker === 0xd9 || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
        continue
      }

      if (pos + 2 > buf.length) break
      const length = buf.readUInt16BE(pos)
      if (length < 2 || pos + length > buf.length) break

      if (marker === 0xe1 && length >= 14) {
        const exifHeader = buf.toString("ascii", pos + 2, pos + 6)
        if (exifHeader === "Exif") {
          const tiffStart = pos + 8
          if (tiffStart + 8 <= buf.length) {
            const isLE = buf[tiffStart] === 0x49 && buf[tiffStart + 1] === 0x49
            const ifdOffset = isLE ? buf.readUInt32LE(tiffStart + 4) : buf.readUInt32BE(tiffStart + 4)
            let ifdPos = tiffStart + ifdOffset
            if (ifdPos + 2 <= buf.length) {
              const numEntries = isLE ? buf.readUInt16LE(ifdPos) : buf.readUInt16BE(ifdPos)
              ifdPos += 2
              for (let e = 0; e < numEntries && ifdPos + 12 <= buf.length; e++, ifdPos += 12) {
                const tag = isLE ? buf.readUInt16LE(ifdPos) : buf.readUInt16BE(ifdPos)
                if (tag === 0x0112) {
                  orientation = isLE ? buf.readUInt16LE(ifdPos + 8) : buf.readUInt16BE(ifdPos + 8)
                  break
                }
              }
            }
          }
        }
      }

      const isSof = (marker >= 0xc0 && marker <= 0xc3) ||
                    (marker >= 0xc5 && marker <= 0xc7) ||
                    (marker >= 0xc9 && marker <= 0xcb) ||
                    (marker >= 0xcd && marker <= 0xcf)
      if (isSof && length >= 7) {
        height = buf.readUInt16BE(pos + 3)
        width = buf.readUInt16BE(pos + 5)
        break
      }

      pos += length
    }

    if (width > 0 && height > 0) {
      if (orientation >= 5 && orientation <= 8) {
        return { width: height, height: width, format: "jpeg", pages: 1 }
      }
      return { width, height, format: "jpeg", pages: 1 }
    }
    return null
  }

  const gifSig = buf.toString("ascii", 0, 6)
  if (gifSig === "GIF87a" || gifSig === "GIF89a") {
    const width = buf.readUInt16LE(6)
    const height = buf.readUInt16LE(8)
    let pages: number
    try {
      const reader = new omggif.GifReader(buf)
      pages = reader.numFrames()
    } catch {
      let count = 0
      for (let i = 13; i < buf.length - 9; i++) {
        if (buf[i] === 0x2c) count++
      }
      pages = Math.max(1, count)
    }
    return { width, height, format: "gif", pages }
  }

  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const chunkType = buf.toString("ascii", 12, 16)
    if (chunkType === "VP8 " && buf.length >= 30) {
      const width = buf.readUInt16LE(26) & 0x3fff
      const height = buf.readUInt16LE(28) & 0x3fff
      return { width, height, format: "webp", pages: 1 }
    }
    if (chunkType === "VP8L" && buf.length >= 25) {
      const b1 = buf[21] ?? 0
      const b2 = buf[22] ?? 0
      const b3 = buf[23] ?? 0
      const b4 = buf[24] ?? 0
      const width = 1 + (((b2 & 0x3f) << 8) | b1)
      const height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6))
      return { width, height, format: "webp", pages: 1 }
    }
    if (chunkType === "VP8X" && buf.length >= 30) {
      const b24 = buf[24] ?? 0
      const b25 = buf[25] ?? 0
      const b26 = buf[26] ?? 0
      const b27 = buf[27] ?? 0
      const b28 = buf[28] ?? 0
      const b29 = buf[29] ?? 0
      const b20 = buf[20] ?? 0
      const width = 1 + (b24 | (b25 << 8) | (b26 << 16))
      const height = 1 + (b27 | (b28 << 8) | (b29 << 16))
      const isAnimated = (b20 & 0x02) !== 0
      let pages = 1
      if (isAnimated) {
        let count = 0
        let pos = 30
        while (pos < buf.length - 8) {
          const type = buf.toString("ascii", pos, pos + 4)
          const len = buf.readUInt32LE(pos + 4)
          if (type === "ANMF") count++
          pos += 8 + len + (len & 1)
        }
        pages = Math.max(1, count)
      }
      return { width, height, format: "webp", pages }
    }
  }

  if (buf[0] === 0x42 && buf[1] === 0x4d && buf.length >= 26) {
    const width = buf.readInt32LE(18)
    const height = Math.abs(buf.readInt32LE(22))
    return { width, height, format: "bmp", pages: 1 }
  }

  const isTiffLE = buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00
  const isTiffBE = buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a
  if (isTiffLE || isTiffBE) {
    const isLE = isTiffLE
    let ifdOffset = isLE ? buf.readUInt32LE(4) : buf.readUInt32BE(4)
    let width = 0
    let height = 0
    let pages = 0

    // A TIFF's pages are a linked list, each IFD holding the offset of the next, and nothing in the
    // format stops that offset pointing at an IFD already visited. Following it without remembering
    // where it has been is an unbreakable loop: measured before this set existed, a 64-byte file
    // whose only IFD pointed at itself never returned. It is a synchronous loop with no allocation,
    // so it does not run out of memory and get killed -- it holds the thread forever, which for a
    // pre-read hook means the agent's Read never comes back at all.
    const seenIfdOffsets = new Set<number>()

    while (ifdOffset > 0 && ifdOffset + 2 <= buf.length) {
      if (seenIfdOffsets.has(ifdOffset)) break
      seenIfdOffsets.add(ifdOffset)
      pages++
      const numEntries = isLE ? buf.readUInt16LE(ifdOffset) : buf.readUInt16BE(ifdOffset)
      let ifdPos = ifdOffset + 2
      for (let e = 0; e < numEntries && ifdPos + 12 <= buf.length; e++, ifdPos += 12) {
        const tag = isLE ? buf.readUInt16LE(ifdPos) : buf.readUInt16BE(ifdPos)
        if (tag === 0x0100 && width === 0) {
          const type = isLE ? buf.readUInt16LE(ifdPos + 2) : buf.readUInt16BE(ifdPos + 2)
          width = type === 3 ? (isLE ? buf.readUInt16LE(ifdPos + 8) : buf.readUInt16BE(ifdPos + 8))
                             : (isLE ? buf.readUInt32LE(ifdPos + 8) : buf.readUInt32BE(ifdPos + 8))
        } else if (tag === 0x0101 && height === 0) {
          const type = isLE ? buf.readUInt16LE(ifdPos + 2) : buf.readUInt16BE(ifdPos + 2)
          height = type === 3 ? (isLE ? buf.readUInt16LE(ifdPos + 8) : buf.readUInt16BE(ifdPos + 8))
                              : (isLE ? buf.readUInt32LE(ifdPos + 8) : buf.readUInt32BE(ifdPos + 8))
        }
      }
      const nextIfdPos = ifdOffset + 2 + numEntries * 12
      if (nextIfdPos + 4 <= buf.length) {
        ifdOffset = isLE ? buf.readUInt32LE(nextIfdPos) : buf.readUInt32BE(nextIfdPos)
      } else {
        break
      }
    }
    if (width > 0 && height > 0) {
      return { width, height, format: "tiff", pages: Math.max(1, pages) }
    }
  }

  const sample = buf.subarray(0, Math.min(buf.length, 4096)).toString("utf8")
  if (sample.includes("<svg")) {
    const widthMatch = /width=["']([0-9.]+)(px)?["']/i.exec(sample)
    const heightMatch = /height=["']([0-9.]+)(px)?["']/i.exec(sample)
    const viewBoxMatch = /viewBox=["']([0-9. -]+)["']/i.exec(sample)

    let width = (widthMatch && widthMatch[1]) ? parseFloat(widthMatch[1]) : 0
    let height = (heightMatch && heightMatch[1]) ? parseFloat(heightMatch[1]) : 0

    if ((!width || !height) && viewBoxMatch && viewBoxMatch[1]) {
      const parts = viewBoxMatch[1].trim().split(/[\s,]+/).map(parseFloat)
      if (parts.length === 4 && parts[2] !== undefined && parts[3] !== undefined) {
        width = parts[2]
        height = parts[3]
      }
    }

    if (width > 0 && height > 0) {
      return { width: Math.round(width), height: Math.round(height), format: "svg", pages: 1 }
    }
    return { width: 100, height: 100, format: "svg", pages: 1 }
  }

  return null
}

export function decodePng(buf: Buffer): DecodedImage {
  if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
    throw new Error("Invalid PNG signature")
  }

  let pos = 8
  let width = 0
  let height = 0
  let colorType = 6
  const idatChunks: Buffer[] = []
  let palette: Buffer | null = null
  let trns: Buffer | null = null

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString("ascii", pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    pos += 8 + len + 4

    if (type === "IHDR") {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const bitDepth = data[8] ?? 8
      colorType = data[9] ?? 6
      // Only 8 bits per sample. The row loop below indexes samples as single bytes, so a 16-bit
      // image read as 8-bit does not fail -- it silently returns the wrong picture. Measured: a
      // 16-bit opaque red pixel came back as [255, 255, 0, 0], a transparent yellow. Sub-byte
      // depths (1, 2, 4) pack several pixels into one byte and are wrong the same way. Handing the
      // model a corrupted image while reporting success is worse than not shrinking it, and
      // throwing here means shrinkImage passes the untouched original through instead.
      if (bitDepth !== 8) {
        throw new Error("Unsupported PNG bit depth: " + bitDepth)
      }
      // Adam7 stores the image as seven interleaved sub-images. The row loop assumes one pass over
      // full-width scanlines, so an interlaced file decodes to noise for the same reason.
      const interlace = data[12] ?? 0
      if (interlace !== 0) {
        throw new Error("Unsupported PNG interlace method: " + interlace)
      }
    } else if (type === "PLTE") {
      palette = data
    } else if (type === "tRNS") {
      trns = data
    } else if (type === "IDAT") {
      idatChunks.push(data)
    } else if (type === "IEND") {
      break
    }
  }

  if (width === 0 || height === 0) {
    throw new Error("Missing PNG IHDR chunk")
  }

  let bpp = 4
  if (colorType === 0) bpp = 1
  else if (colorType === 2) bpp = 3
  else if (colorType === 3) bpp = 1
  else if (colorType === 4) bpp = 2
  else if (colorType === 6) bpp = 4

  assertDecodableSize("PNG", width, height, 4)

  const rowBytes = width * bpp
  const rowSize = 1 + rowBytes

  // A non-interlaced PNG's zlib stream is exactly one filter byte plus one row of samples per
  // scanline. That is a bound the file cannot argue with, so it is the bound used, rather than a
  // round number: anything past it is not data this image could need.
  //
  // Without it the IDAT decides the allocation, and it can be enormously smaller than what it
  // expands to. Measured on this decoder before the bound: a 510 KB PNG declaring 4000x4000 -- 16
  // MP exactly, so it clears the pixel gate -- inflated to 512 MB, took 1,025 MB of external memory
  // once the concatenation is counted, and needed 61 MB. 512 MB was the figure chosen for the test
  // file, not a limit the code imposed; nothing here stopped it going higher.
  const maxRawBytes = height * rowSize
  const compressed = Buffer.concat(idatChunks)
  let decompressed: Buffer
  try {
    decompressed = zlib.inflateSync(compressed, { maxOutputLength: maxRawBytes })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`PNG image data exceeds the ${maxRawBytes} bytes its ${width}x${height} header allows: ${msg}`, {
      cause: err,
    })
  }

  const outRgba = Buffer.alloc(width * height * 4)
  const priorRow = Buffer.alloc(rowBytes)
  const currRow = Buffer.alloc(rowBytes)

  for (let y = 0; y < height; y++) {
    const filter = decompressed[y * rowSize] ?? 0
    const rawOffset = y * rowSize + 1

    for (let x = 0; x < rowBytes; x++) {
      const rawVal = decompressed[rawOffset + x] ?? 0
      const a = x >= bpp ? (currRow[x - bpp] ?? 0) : 0
      const b = priorRow[x] ?? 0
      const c = x >= bpp ? (priorRow[x - bpp] ?? 0) : 0

      let val = rawVal
      if (filter === 0) {
        val = rawVal
      } else if (filter === 1) {
        val = (rawVal + a) & 0xff
      } else if (filter === 2) {
        val = (rawVal + b) & 0xff
      } else if (filter === 3) {
        val = (rawVal + Math.floor((a + b) / 2)) & 0xff
      } else if (filter === 4) {
        val = (rawVal + paethPredictor(a, b, c)) & 0xff
      }

      currRow[x] = val
    }

    for (let x = 0; x < width; x++) {
      const outIdx = (y * width + x) * 4
      if (colorType === 6) {
        outRgba[outIdx] = currRow[x * 4] ?? 0
        outRgba[outIdx + 1] = currRow[x * 4 + 1] ?? 0
        outRgba[outIdx + 2] = currRow[x * 4 + 2] ?? 0
        outRgba[outIdx + 3] = currRow[x * 4 + 3] ?? 255
      } else if (colorType === 2) {
        outRgba[outIdx] = currRow[x * 3] ?? 0
        outRgba[outIdx + 1] = currRow[x * 3 + 1] ?? 0
        outRgba[outIdx + 2] = currRow[x * 3 + 2] ?? 0
        outRgba[outIdx + 3] = 255
      } else if (colorType === 0) {
        const g = currRow[x] ?? 0
        outRgba[outIdx] = g
        outRgba[outIdx + 1] = g
        outRgba[outIdx + 2] = g
        outRgba[outIdx + 3] = 255
      } else if (colorType === 4) {
        const g = currRow[x * 2] ?? 0
        outRgba[outIdx] = g
        outRgba[outIdx + 1] = g
        outRgba[outIdx + 2] = g
        outRgba[outIdx + 3] = currRow[x * 2 + 1] ?? 255
      } else if (colorType === 3 && palette) {
        const pVal = currRow[x] ?? 0
        const pIdx = pVal * 3
        outRgba[outIdx] = palette[pIdx] ?? 0
        outRgba[outIdx + 1] = palette[pIdx + 1] ?? 0
        outRgba[outIdx + 2] = palette[pIdx + 2] ?? 0
        outRgba[outIdx + 3] = trns && trns.length > pVal ? (trns[pVal] ?? 255) : 255
      }
    }

    currRow.copy(priorRow)
  }

  return { width, height, data: outRgba }
}

function makePngChunk(type: string, data: Uint8Array): Buffer {
  const len = data.length
  const chunk = Buffer.alloc(8 + len + 4)
  chunk.writeUInt32BE(len, 0)
  chunk.write(type, 4, 4, "ascii")
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(chunk, 8)
  const typeAndData = chunk.subarray(4, 8 + len)
  chunk.writeUInt32BE(crc32(typeAndData), 8 + len)
  return chunk
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const rowSize = 1 + width * 4
  const rawData = Buffer.alloc(rowSize * height)
  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize
    rawData[rowOffset] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(rawData, rowOffset + 1)
  }

  const idatData = zlib.deflateSync(rawData, { level: 6 })
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdrChunk = makePngChunk("IHDR", ihdr)
  const idatChunk = makePngChunk("IDAT", idatData)
  const iendChunk = makePngChunk("IEND", Buffer.alloc(0))

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk])
}

export function decodeBmp(buf: Buffer): DecodedImage {
  if (buf.length < 54 || buf[0] !== 0x42 || buf[1] !== 0x4d) {
    throw new Error("Invalid BMP signature")
  }
  const pixelOffset = buf.readUInt32LE(10)
  const width = buf.readInt32LE(18)
  let height = buf.readInt32LE(22)
  const topDown = height < 0
  height = Math.abs(height)
  const bpp = buf.readUInt16LE(28)
  const compression = buf.readUInt32LE(30)

  if (compression !== 0 && compression !== 3) {
    throw new Error("Unsupported BMP compression: " + compression)
  }

  // Only 24- and 32-bit BMPs have a branch in the pixel loop below. Every other depth fell through
  // it and returned the zero-filled buffer: a fully transparent image, with no error, which
  // shrinkImage would then re-encode and hand to the model as the file's contents.
  if (bpp !== 24 && bpp !== 32) {
    throw new Error("Unsupported BMP bit depth: " + bpp)
  }

  // BMP stores both dimensions signed, and width is used unmodified. A negative one makes the
  // product negative, which slips under a `> limit` test, so the check has to be for a valid size
  // rather than merely a small one -- assertDecodableSize rejects on sign and finiteness first.
  assertDecodableSize("BMP", width, height, 4)

  const outRgba = Buffer.alloc(width * height * 4)
  const rowStride = Math.floor((bpp * width + 31) / 32) * 4

  for (let y = 0; y < height; y++) {
    const srcY = topDown ? y : (height - 1 - y)
    const rowOffset = pixelOffset + srcY * rowStride
    for (let x = 0; x < width; x++) {
      const outIdx = (y * width + x) * 4
      if (bpp === 24) {
        const pxOffset = rowOffset + x * 3
        outRgba[outIdx] = buf[pxOffset + 2] ?? 0
        outRgba[outIdx + 1] = buf[pxOffset + 1] ?? 0
        outRgba[outIdx + 2] = buf[pxOffset] ?? 0
        outRgba[outIdx + 3] = 255
      } else if (bpp === 32) {
        const pxOffset = rowOffset + x * 4
        outRgba[outIdx] = buf[pxOffset + 2] ?? 0
        outRgba[outIdx + 1] = buf[pxOffset + 1] ?? 0
        outRgba[outIdx + 2] = buf[pxOffset] ?? 0
        outRgba[outIdx + 3] = buf[pxOffset + 3] ?? 255
      }
    }
  }

  return { width, height, data: outRgba }
}

/**
 * Decode a GIF's frames.
 *
 * `maxFrames` stops after that many. A caller that wants a still out of an animation should pass 1
 * rather than take `frames[0]` from a full decode, which pays for every frame to use one.
 */
export function decodeGif(buf: Buffer, opts?: { maxFrames?: number }): DecodedAnimatedGif {
  const reader = new omggif.GifReader(buf)
  const width = reader.width
  const height = reader.height
  const wanted = Math.min(reader.numFrames(), opts?.maxFrames ?? Number.POSITIVE_INFINITY)

  // Every frame is a full canvas and every one is kept, so the cost is the canvas times the frame
  // count, not the canvas. Frames are cheap to declare -- an empty 1x1 sub-frame is about 23 bytes
  // -- so the ratio between the file and what it costs to decode is effectively unbounded. This is
  // the one check that has to happen before the loop rather than inside it: catching it on frame
  // 400 means 399 canvases have already been allocated.
  //
  // The ceiling doubles as a time budget, which is why raising it would not simply buy more
  // capability. Measured end to end through the pre-read hook, a 1600x1600 frame costs about 87 ms
  // to decode, resize and quantize; 256 MB of canvas is 26 such frames, or roughly 2.3 seconds,
  // which is already as long as a hook standing between an agent and its Read ought to take. A
  // larger ceiling would mostly convert an out-of-memory into a wait.
  assertDecodableSize("GIF", width, height, 4, wanted)

  const frames: AnimatedGifFrame[] = []

  for (let i = 0; i < wanted; i++) {
    const frameInfo = reader.frameInfo(i)
    const frameRgba = Buffer.alloc(width * height * 4)
    reader.decodeAndBlitFrameRGBA(i, frameRgba)
    frames.push({
      width,
      height,
      x: frameInfo.x,
      y: frameInfo.y,
      delay: frameInfo.delay,
      disposal: frameInfo.disposal,
      data: frameRgba,
    })
  }

  return { width, height, frames }
}

export function encodeGif(width: number, height: number, rgba: Uint8Array): Buffer {
  const buf = Buffer.alloc(width * height * 5 + 1024)
  const gifWriter = new omggif.GifWriter(buf, width, height, { loop: 0 })
  const { indexedPixels, palette } = quantizeRgbaToIndexed(rgba, width, height)
  gifWriter.addFrame(0, 0, width, height, indexedPixels, { palette })
  return buf.subarray(0, gifWriter.end())
}

export function quantizeRgbaToIndexed(rgba: Uint8Array, width: number, height: number): { indexedPixels: number[]; palette: number[] } {
  const palette: number[] = []
  for (let r = 0; r < 8; r++) {
    for (let g = 0; g < 8; g++) {
      for (let b = 0; b < 4; b++) {
        const red = Math.round((r / 7) * 255)
        const green = Math.round((g / 7) * 255)
        const blue = Math.round((b / 3) * 255)
        palette.push((red << 16) | (green << 8) | blue)
      }
    }
  }

  const numPixels = width * height
  const indexedPixels: number[] = new Array(numPixels)
  for (let i = 0; i < numPixels; i++) {
    const r = rgba[i * 4] ?? 0
    const g = rgba[i * 4 + 1] ?? 0
    const b = rgba[i * 4 + 2] ?? 0
    const rIdx = Math.min(7, Math.floor((r / 256) * 8))
    const gIdx = Math.min(7, Math.floor((g / 256) * 8))
    const bIdx = Math.min(3, Math.floor((b / 256) * 4))
    indexedPixels[i] = (rIdx << 5) | (gIdx << 2) | bIdx
  }

  return { indexedPixels, palette }
}

export function decodeJpeg(buf: Buffer): DecodedImage {
  const decoded = jpeg.decode(buf, { useTArray: true })
  return {
    width: decoded.width,
    height: decoded.height,
    data: Buffer.from(decoded.data),
  }
}

export function encodeJpeg(width: number, height: number, rgba: Uint8Array, quality: number = 80): Buffer {
  const encoded = jpeg.encode({
    data: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength),
    width,
    height,
  }, quality)
  return encoded.data
}

export function resizeRgba(
  srcRgba: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Buffer {
  if (srcW === dstW && srcH === dstH) {
    return Buffer.from(srcRgba.buffer, srcRgba.byteOffset, srcRgba.byteLength)
  }

  const dst = Buffer.alloc(dstW * dstH * 4)
  const scaleX = srcW / dstW
  const scaleY = srcH / dstH

  for (let dy = 0; dy < dstH; dy++) {
    const srcY = (dy + 0.5) * scaleY - 0.5
    const y0 = Math.max(0, Math.min(srcH - 1, Math.floor(srcY)))
    const y1 = Math.max(0, Math.min(srcH - 1, y0 + 1))
    const fy = Math.max(0, Math.min(1, srcY - y0))
    const fy1 = 1 - fy

    const dstRowOffset = dy * dstW * 4
    const srcRow0 = y0 * srcW * 4
    const srcRow1 = y1 * srcW * 4

    for (let dx = 0; dx < dstW; dx++) {
      const srcX = (dx + 0.5) * scaleX - 0.5
      const x0 = Math.max(0, Math.min(srcW - 1, Math.floor(srcX)))
      const x1 = Math.max(0, Math.min(srcW - 1, x0 + 1))
      const fx = Math.max(0, Math.min(1, srcX - x0))
      const fx1 = 1 - fx

      const w00 = fx1 * fy1
      const w10 = fx * fy1
      const w01 = fx1 * fy
      const w11 = fx * fy

      const idx00 = srcRow0 + x0 * 4
      const idx10 = srcRow0 + x1 * 4
      const idx01 = srcRow1 + x0 * 4
      const idx11 = srcRow1 + x1 * 4

      const p00_r = srcRgba[idx00] ?? 0
      const p00_g = srcRgba[idx00 + 1] ?? 0
      const p00_b = srcRgba[idx00 + 2] ?? 0
      const p00_a = srcRgba[idx00 + 3] ?? 255

      const p10_r = srcRgba[idx10] ?? 0
      const p10_g = srcRgba[idx10 + 1] ?? 0
      const p10_b = srcRgba[idx10 + 2] ?? 0
      const p10_a = srcRgba[idx10 + 3] ?? 255

      const p01_r = srcRgba[idx01] ?? 0
      const p01_g = srcRgba[idx01 + 1] ?? 0
      const p01_b = srcRgba[idx01 + 2] ?? 0
      const p01_a = srcRgba[idx01 + 3] ?? 255

      const p11_r = srcRgba[idx11] ?? 0
      const p11_g = srcRgba[idx11 + 1] ?? 0
      const p11_b = srcRgba[idx11 + 2] ?? 0
      const p11_a = srcRgba[idx11 + 3] ?? 255

      const dstIdx = dstRowOffset + dx * 4
      dst[dstIdx] = Math.round(w00 * p00_r + w10 * p10_r + w01 * p01_r + w11 * p11_r)
      dst[dstIdx + 1] = Math.round(w00 * p00_g + w10 * p10_g + w01 * p01_g + w11 * p11_g)
      dst[dstIdx + 2] = Math.round(w00 * p00_b + w10 * p10_b + w01 * p01_b + w11 * p11_b)
      dst[dstIdx + 3] = Math.round(w00 * p00_a + w10 * p10_a + w01 * p01_a + w11 * p11_a)
    }
  }

  return dst
}

export function calculateFitInside(width: number, height: number, maxDimension: number): { width: number; height: number } {
  if (width <= maxDimension && height <= maxDimension) {
    return { width, height }
  }
  const scale = maxDimension / Math.max(width, height)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}
