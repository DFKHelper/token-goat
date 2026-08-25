import * as zlib from 'node:zlib'

function u16(n: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n)
  return b
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}

/**
 * Builds a single-entry zip-format archive whose local file header AND central directory record
 * both declare `declaredUncompressedSize` bytes of content, while the entry's real DEFLATE
 * stream, once actually decompressed, produces `realPayload.length` bytes -- a forged central
 * directory, the same shape a real zip bomb can carry. fflate's zip reader does not verify
 * CRC-32 on read, so this needs no checksum forgery to parse cleanly; only the size fields lie.
 *
 * Used to prove a decompression-size check that trusts the declared size alone is theatre: call
 * with `declaredUncompressedSize` small and `realPayload` large, and a check gated only on the
 * declared field will wave it through.
 */
export function buildLyingSizeZip(entryName: string, realPayload: Uint8Array, declaredUncompressedSize: number): Uint8Array {
  const nameBytes = Buffer.from(entryName, 'utf-8')
  const compressed = zlib.deflateRawSync(Buffer.from(realPayload.buffer, realPayload.byteOffset, realPayload.byteLength), { level: 1 })

  const localHeader = Buffer.concat([
    u32(0x04034b50),
    u16(20), // version needed to extract
    u16(0), // general purpose bit flag
    u16(8), // compression method: deflate
    u16(0), // last mod time
    u16(0), // last mod date
    u32(0), // crc-32 (unchecked by fflate's reader)
    u32(compressed.length), // compressed size (real)
    u32(declaredUncompressedSize), // uncompressed size (the lie)
    u16(nameBytes.length),
    u16(0), // extra field length
    nameBytes,
  ])

  const centralHeader = Buffer.concat([
    u32(0x02014b50),
    u16(20), // version made by
    u16(20), // version needed to extract
    u16(0), // general purpose bit flag
    u16(8), // compression method
    u16(0), // last mod time
    u16(0), // last mod date
    u32(0), // crc-32
    u32(compressed.length), // compressed size (real)
    u32(declaredUncompressedSize), // uncompressed size (the lie)
    u16(nameBytes.length),
    u16(0), // extra field length
    u16(0), // file comment length
    u16(0), // disk number start
    u16(0), // internal file attributes
    u32(0), // external file attributes
    u32(0), // relative offset of local header (single entry, starts at 0)
    nameBytes,
  ])

  const centralDirOffset = localHeader.length + compressed.length
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0), // disk number
    u16(0), // disk where central directory starts
    u16(1), // central directory records on this disk
    u16(1), // total central directory records
    u32(centralHeader.length), // size of central directory
    u32(centralDirOffset), // offset of start of central directory
    u16(0), // comment length
  ])

  return new Uint8Array(Buffer.concat([localHeader, compressed, centralHeader, eocd]))
}

/** A `sizeMB` payload of zeros -- highly compressible, like a real zip bomb's source, and cheap
 * to build (an already-zeroed buffer, no fill work). */
export function zeroPayload(sizeMB: number): Uint8Array {
  return new Uint8Array(sizeMB * 1024 * 1024)
}
