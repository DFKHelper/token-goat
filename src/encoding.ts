/**
 * Source file character encoding and BOM detection / transcoding.
 *
 * Extracted from src/util.ts as part of modular decomposition.
 */

export type SourceEncoding = 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be' | 'utf32le' | 'utf32be'

/** Strip leading Unicode byte order mark if present. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Which encoding `buf` declares through its leading byte-order mark.
 *
 * Order matters: UTF-32LE begins `FF FE 00 00`, whose first two bytes are exactly the UTF-16LE
 * mark, so the four-byte forms have to be tested first or a UTF-32 file decodes as UTF-16 and
 * comes back interleaved with NULs -- the same failure this whole helper exists to remove.
 *
 * A file with no mark is reported as `utf8` and decoded as UTF-8 exactly as before. Mark-less
 * UTF-16 is not guessed at: heuristics on byte distribution misfire on binary, and a wrong guess
 * is worse than the honest empty result.
 */
export function detectSourceEncoding(buf: Buffer): SourceEncoding {
  if (buf.length >= 4) {
    if (buf[0] === 0xff && buf[1] === 0xfe && buf[2] === 0x00 && buf[3] === 0x00) return 'utf32le'
    if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0xfe && buf[3] === 0xff) return 'utf32be'
  }
  if (buf.length >= 2) {
    if (buf[0] === 0xff && buf[1] === 0xfe) return 'utf16le'
    if (buf[0] === 0xfe && buf[1] === 0xff) return 'utf16be'
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf8-bom'
  return 'utf8'
}

/**
 * Decode a source file's bytes to text, honoring a byte-order mark.
 *
 * `buf.toString('utf8')` is right for almost every file and wrong for the ones Windows produces by
 * accident: PowerShell 5.1 writes UTF-16LE for `>` redirection and `Out-File`, so a script, log, or
 * generated document created that way is UTF-16 with a BOM. Decoded as UTF-8 those bytes become the
 * text interleaved with NULs, which parses to nothing at all -- the file indexes with zero symbols
 * and is reported as indexed, and `read` on it emits the doubled, NUL-laced mojibake into the
 * model's context.
 *
 * The mark itself is never part of the returned text, including for UTF-8: U+FEFF at the head of a
 * file is an encoding marker, not content, and leaving it in shifts every column on the first line
 * and stops a heading or shebang from matching at position 0.
 */
export function decodeSource(buf: Buffer): string {
  switch (detectSourceEncoding(buf)) {
    case 'utf32le':
      return decodeUtf32(buf.subarray(4), true)
    case 'utf32be':
      return decodeUtf32(buf.subarray(4), false)
    case 'utf16le':
      return buf.subarray(2).toString('utf16le')
    case 'utf16be':
      return swap16(buf.subarray(2)).toString('utf16le')
    case 'utf8-bom':
      return buf.subarray(3).toString('utf8')
    default:
      return buf.toString('utf8')
  }
}

/**
 * Re-encode `text` in `encoding`, mark included, so a command that rewrites a file puts it back the
 * way it found it.
 *
 * Without this, reading a UTF-16 file correctly and writing it back as UTF-8 would silently convert
 * it -- worse than never having read it, since the caller asked to edit one section and got the
 * whole file re-encoded.
 */
export function encodeSource(text: string, encoding: SourceEncoding): Buffer {
  switch (encoding) {
    case 'utf32le':
      return Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x00]), encodeUtf32(text, true)])
    case 'utf32be':
      return Buffer.concat([Buffer.from([0x00, 0x00, 0xfe, 0xff]), encodeUtf32(text, false)])
    case 'utf16le':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
    case 'utf16be':
      return Buffer.concat([Buffer.from([0xfe, 0xff]), swap16(Buffer.from(text, 'utf16le'))])
    case 'utf8-bom':
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])
    default:
      return Buffer.from(text, 'utf8')
  }
}

/** Byte-swapped copy, for big-endian UTF-16: Node decodes only the little-endian form. Copies rather than swapping in place, because the input may be a view onto a buffer a caller still holds. */
function swap16(buf: Buffer): Buffer {
  const out = Buffer.from(buf)
  return out.subarray(0, out.length - (out.length % 2)).swap16()
}

/** UTF-32 has no Node decoder, so its code points are read one 4-byte unit at a time. A trailing partial unit is dropped, and a unit outside the Unicode range becomes U+FFFD rather than throwing on a truncated or corrupt file. */
function decodeUtf32(buf: Buffer, littleEndian: boolean): string {
  const points: number[] = []
  for (let i = 0; i + 4 <= buf.length; i += 4) {
    const cp = littleEndian ? buf.readUInt32LE(i) : buf.readUInt32BE(i)
    points.push(cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? 0xfffd : cp)
  }
  return String.fromCodePoint(...points)
}

/** Counterpart to {@link decodeUtf32}. */
function encodeUtf32(text: string, littleEndian: boolean): Buffer {
  const points = [...text]
  const out = Buffer.alloc(points.length * 4)
  points.forEach((ch, i) => {
    const cp = ch.codePointAt(0) ?? 0xfffd
    if (littleEndian) out.writeUInt32LE(cp, i * 4)
    else out.writeUInt32BE(cp, i * 4)
  })
  return out
}
