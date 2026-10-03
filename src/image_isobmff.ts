/** Header-only probe for ISO base media (ISOBMFF) still images: AVIF and HEIC/HEIF. Format source: ISO/IEC 14496-12 (box layout), ISO/IEC 23008-12 (HEIF: `meta`, `pitm`, `iprp`/`ipco`/`ipma`, `ispe`, `irot`) and the AV1 Image File Format (AVIF) brands. No pixels are decoded; the engine has no AVIF/HEIC decoder, so these formats are probe-only. Every box walk is bounded by the buffer: a size that is below its own header, or runs past its parent, ends the walk, so hostile input cannot loop or read out of range. */

export interface IsoBmffMeta {
  width: number
  height: number
  format: 'avif' | 'heic' | 'heif'
}

interface Box {
  type: string
  /** Offset of the first byte after the box header (for a FullBox, the version/flags word). */
  body: number
  /** Offset one past the box's last byte. */
  end: number
}

const AVIF_BRANDS = new Set(['avif', 'avis'])
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'hevs'])
const HEIF_GENERIC_BRANDS = new Set(['mif1', 'msf1'])
const FULLBOX_PREFIX = 4

/** Boxes in `[start, end)` of `buf`; stops at the first malformed size instead of guessing. */
function readBoxes(buf: Buffer, start: number, end: number): Box[] {
  const boxes: Box[] = []
  const limit = Math.min(end, buf.length)
  let pos = start
  while (pos + 8 <= limit) {
    let size = buf.readUInt32BE(pos)
    const type = buf.toString('latin1', pos + 4, pos + 8)
    let header = 8
    if (size === 1) {
      if (pos + 16 > limit) break
      const large = buf.readBigUInt64BE(pos + 8)
      if (large > BigInt(limit - pos)) break
      size = Number(large)
      header = 16
    } else if (size === 0) {
      size = limit - pos
    }
    if (size < header || pos + size > limit) break
    boxes.push({ type, body: pos + header, end: pos + size })
    pos += size
  }
  return boxes
}

function findBox(boxes: Box[], type: string): Box | undefined {
  return boxes.find((b) => b.type === type)
}

function classifyBrands(buf: Buffer, ftyp: Box): IsoBmffMeta['format'] | null {
  // ftyp body: major_brand(4) minor_version(4) compatible_brands(4 each).
  if (ftyp.end - ftyp.body < 8) return null
  const brands = [buf.toString('latin1', ftyp.body, ftyp.body + 4)]
  for (let p = ftyp.body + 8; p + 4 <= ftyp.end; p += 4) brands.push(buf.toString('latin1', p, p + 4))
  if (brands.some((b) => AVIF_BRANDS.has(b))) return 'avif'
  if (brands.some((b) => HEIC_BRANDS.has(b))) return 'heic'
  if (brands.some((b) => HEIF_GENERIC_BRANDS.has(b))) return 'heif'
  return null
}

/** Item id from `pitm`, or null when the box is absent or short. */
function primaryItemId(buf: Buffer, children: Box[]): number | null {
  const pitm = findBox(children, 'pitm')
  if (pitm === undefined || pitm.end - pitm.body < FULLBOX_PREFIX + 2) return null
  const version = buf[pitm.body]!
  if (version === 0) return buf.readUInt16BE(pitm.body + FULLBOX_PREFIX)
  if (pitm.end - pitm.body < FULLBOX_PREFIX + 4) return null
  return buf.readUInt32BE(pitm.body + FULLBOX_PREFIX)
}

/** 1-based `ipco` property indices associated with `itemId` in `ipma`, or null when the item has none. */
function itemProperties(buf: Buffer, ipma: Box, itemId: number): number[] | null {
  if (ipma.end - ipma.body < FULLBOX_PREFIX + 4) return null
  const version = buf[ipma.body]!
  const wide = (buf.readUIntBE(ipma.body + 1, 3) & 1) === 1
  const entryCount = buf.readUInt32BE(ipma.body + FULLBOX_PREFIX)
  let pos = ipma.body + FULLBOX_PREFIX + 4
  const idBytes = version < 1 ? 2 : 4
  const assocBytes = wide ? 2 : 1
  for (let e = 0; e < entryCount; e++) {
    if (pos + idBytes + 1 > ipma.end) return null
    const id = idBytes === 2 ? buf.readUInt16BE(pos) : buf.readUInt32BE(pos)
    const count = buf[pos + idBytes]!
    pos += idBytes + 1
    if (pos + count * assocBytes > ipma.end) return null
    if (id === itemId) {
      const out: number[] = []
      for (let a = 0; a < count; a++) {
        const at = pos + a * assocBytes
        out.push(wide ? buf.readUInt16BE(at) & 0x7fff : buf[at]! & 0x7f)
      }
      return out
    }
    pos += count * assocBytes
  }
  return null
}

/** Probe `buf` as AVIF/HEIC/HEIF. Returns null when it is not an ISOBMFF still-image file or carries no readable `ispe`. Width and height are the display geometry: an `irot` of 90 or 270 degrees on the primary item swaps them, the way the JPEG probe reports EXIF-rotated images. */
export function probeIsoBmffMeta(buf: Buffer): IsoBmffMeta | null {
  if (buf.length < 16 || buf.toString('latin1', 4, 8) !== 'ftyp') return null
  const top = readBoxes(buf, 0, buf.length)
  const ftyp = top[0]
  if (ftyp === undefined || ftyp.type !== 'ftyp') return null
  const format = classifyBrands(buf, ftyp)
  if (format === null) return null

  const meta = findBox(top, 'meta')
  if (meta === undefined || meta.end - meta.body < FULLBOX_PREFIX) return null
  const metaChildren = readBoxes(buf, meta.body + FULLBOX_PREFIX, meta.end)
  const iprp = findBox(metaChildren, 'iprp')
  if (iprp === undefined) return null
  const iprpChildren = readBoxes(buf, iprp.body, iprp.end)
  const ipco = findBox(iprpChildren, 'ipco')
  if (ipco === undefined) return null
  const props = readBoxes(buf, ipco.body, ipco.end)

  // Properties the primary item is associated with, so a thumbnail or a grid tile's smaller `ispe` is never mistaken for the image. Without `pitm`/`ipma` the largest `ispe` stands in: the primary item is the largest image in practice.
  const ipma = findBox(iprpChildren, 'ipma')
  const itemId = primaryItemId(buf, metaChildren)
  const wanted = ipma !== undefined && itemId !== null ? itemProperties(buf, ipma, itemId) : null
  const candidates = wanted === null ? props : wanted.map((index) => props[index - 1]).filter((b): b is Box => b !== undefined)

  let width = 0
  let height = 0
  let rotated = false
  for (const prop of candidates) {
    if (prop.type === 'ispe' && prop.end - prop.body >= FULLBOX_PREFIX + 8) {
      const w = buf.readUInt32BE(prop.body + FULLBOX_PREFIX)
      const h = buf.readUInt32BE(prop.body + FULLBOX_PREFIX + 4)
      if (wanted !== null || w * h > width * height) {
        width = w
        height = h
      }
    } else if (prop.type === 'irot' && prop.end - prop.body >= 1 && wanted !== null) {
      rotated = (buf[prop.body]! & 3) % 2 === 1
    }
  }
  if (width <= 0 || height <= 0) return null
  return rotated ? { width: height, height: width, format } : { width, height, format }
}
