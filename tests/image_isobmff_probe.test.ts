/** AVIF / HEIC / HEIF header probing. Fixture provenance: the two .avif files are CAPTURE (real encoder output, rows in tests/fixtures/PROVENANCE.tsv). No HEIC encoder exists in this environment (ImageMagick has no HEIC encode delegate, ffmpeg has no HEIF muxer), so the HEIC, irot, primary-item and hostile files are FORMAT-DERIVED: assembled byte by byte below from ISO/IEC 14496-12 (box header: u32 size, 4cc type, size 1 = u64 largesize, size 0 = to end of file; FullBox = 1 byte version + 3 bytes flags) and ISO/IEC 23008-12 (ftyp brands, meta, pitm, iprp/ipco/ipma, ispe = FullBox + u32 width + u32 height, irot = 1 byte angle). */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { probeIsoBmffMeta } from '../src/image_isobmff.js'
import { canShrinkFormat, imageQualifiesForShrink, probeImageMeta, shrinkImage } from '../src/image_shrink.js'
import { runImageMeta } from '../src/read_commands.js'

const FIXTURES = path.join(__dirname, 'fixtures')

function u32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}

function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts)
  return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body])
}

const fullBox = (type: string, version: number, flags: number, ...parts: Buffer[]): Buffer =>
  box(type, Buffer.from([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...parts)

const ispe = (w: number, h: number): Buffer => fullBox('ispe', 0, 0, u32(w), u32(h))
const irot = (angle: number): Buffer => box('irot', Buffer.from([angle]))
const ftyp = (major: string, ...compat: string[]): Buffer =>
  box('ftyp', Buffer.from(major, 'latin1'), u32(0), ...compat.map((c) => Buffer.from(c, 'latin1')))

/** ipma v0 with 1-byte associations: one entry per `[itemId, ...1-based property indices]`. */
function ipma(...items: number[][]): Buffer {
  const entries = items.map(([id, ...props]) => Buffer.concat([Buffer.from([id! >> 8, id! & 255, props.length]), Buffer.from(props)]))
  return fullBox('ipma', 0, 0, u32(items.length), ...entries)
}

function heif(major: string, compat: string[], props: Buffer[], assoc: Buffer | null, primary: number | null): Buffer {
  const pitm = primary === null ? [] : [fullBox('pitm', 0, 0, Buffer.from([primary >> 8, primary & 255]))]
  const iprp = box('iprp', box('ipco', ...props), ...(assoc === null ? [] : [assoc]))
  return Buffer.concat([ftyp(major, ...compat), fullBox('meta', 0, 0, ...pitm, iprp)])
}

describe('probeImageMeta on ISO-BMFF images', () => {
  it('reads a real ImageMagick AVIF', async () => {
    const meta = await probeImageMeta(fs.readFileSync(path.join(FIXTURES, 'magick-7.1.2-red-30x20.avif')))
    expect(meta).toEqual({ width: 30, height: 20, format: 'avif', pages: 1 })
  })

  it('reads a real ffmpeg AVIF', async () => {
    const meta = await probeImageMeta(fs.readFileSync(path.join(FIXTURES, 'ffmpeg-8-red-30x20.avif')))
    expect(meta).toEqual({ width: 30, height: 20, format: 'avif', pages: 1 })
  })

  it.each([
    ['avif', ['mif1']],
    ['avis', ['msf1']],
  ])('classifies major brand %s as avif', async (major, compat) => {
    expect((await probeImageMeta(heif(major, compat, [ispe(64, 48)], null, null)))?.format).toBe('avif')
  })

  it.each(['heic', 'heix', 'hevc', 'heim', 'heis'])('classifies major brand %s as heic', async (major) => {
    expect(await probeImageMeta(heif(major, ['mif1'], [ispe(4032, 3024)], null, null))).toEqual({ width: 4032, height: 3024, format: 'heic', pages: 1 })
  })

  it('classifies a bare mif1 file as heif, and mif1 with an avif compatible brand as avif', async () => {
    expect((await probeImageMeta(heif('mif1', ['miaf'], [ispe(10, 12)], null, null)))?.format).toBe('heif')
    expect((await probeImageMeta(heif('mif1', ['avif'], [ispe(10, 12)], null, null)))?.format).toBe('avif')
  })

  it('reports the primary item geometry, not a smaller thumbnail listed first', async () => {
    // Item 1 is a 160x120 thumbnail (property 1), item 2 the 4032x3024 primary (property 2); pitm names item 2.
    const bytes = heif('heic', ['mif1'], [ispe(160, 120), ispe(4032, 3024)], ipma([1, 1], [2, 2]), 2)
    expect(await probeImageMeta(bytes)).toMatchObject({ width: 4032, height: 3024 })
    // Naming the thumbnail primary instead must flip the answer, so the item lookup is what decides.
    const thumb = heif('heic', ['mif1'], [ispe(160, 120), ispe(4032, 3024)], ipma([1, 1], [2, 2]), 1)
    expect(await probeImageMeta(thumb)).toMatchObject({ width: 160, height: 120 })
  })

  it('falls back to the largest ispe when pitm/ipma are absent', async () => {
    expect(await probeImageMeta(heif('heic', [], [ispe(160, 120), ispe(800, 600), ispe(320, 240)], null, null))).toMatchObject({ width: 800, height: 600 })
  })

  it('swaps the dimensions for a 90 or 270 degree irot on the primary item, not for 180', async () => {
    const rot = (angle: number) => probeImageMeta(heif('heic', [], [ispe(400, 300), irot(angle)], ipma([1, 1, 2]), 1))
    expect(await rot(1)).toMatchObject({ width: 300, height: 400 })
    expect(await rot(3)).toMatchObject({ width: 300, height: 400 })
    expect(await rot(2)).toMatchObject({ width: 400, height: 300 })
  })

  it('reads a 64-bit largesize box header', async () => {
    const inner = box('ipco', ispe(50, 40))
    const large = Buffer.concat([u32(1), Buffer.from('iprp'), u32(0), u32(16 + inner.length), inner])
    const meta = fullBox('meta', 0, 0, large)
    expect(await probeImageMeta(Buffer.concat([ftyp('avif'), meta]))).toMatchObject({ width: 50, height: 40, format: 'avif' })
  })
})

describe('probeIsoBmffMeta on malformed input terminates and returns null', () => {
  const good = heif('avif', ['mif1'], [ispe(30, 20)], ipma([1, 1]), 1)

  it('never throws on any truncation of a valid file, and rejects the cut-off ones', () => {
    for (let n = 0; n < good.length; n++) expect(() => probeIsoBmffMeta(good.subarray(0, n))).not.toThrow()
    expect(probeIsoBmffMeta(good)).not.toBeNull()
    expect(probeIsoBmffMeta(good.subarray(0, good.length - 1))).toBeNull()
  })

  it('refuses ftyp-only, garbage after ftyp and an unknown brand', () => {
    expect(probeIsoBmffMeta(ftyp('avif'))).toBeNull()
    expect(probeIsoBmffMeta(Buffer.concat([ftyp('avif'), Buffer.alloc(64, 0xff)]))).toBeNull()
    expect(probeIsoBmffMeta(heif('isom', ['mp41'], [ispe(30, 20)], null, null))).toBeNull()
  })

  it('does not loop on a zero-size, sub-header or zero-length box', () => {
    const zeroSize = Buffer.concat([ftyp('avif'), Buffer.from([0, 0, 0, 0, 0x6d, 0x65, 0x74, 0x61, 0, 0, 0, 0, 0, 0, 0, 0])])
    expect(probeIsoBmffMeta(zeroSize)).toBeNull()
    const subHeader = Buffer.concat([ftyp('avif'), fullBox('meta', 0, 0, Buffer.from([0, 0, 0, 4, 0x6a, 0x75, 0x6e, 0x6b, 0, 0, 0, 0]))])
    expect(probeIsoBmffMeta(subHeader)).toBeNull()
  })

  it('refuses a size past the buffer, a 64-bit size larger than the file and a short ispe', () => {
    const over = Buffer.from(good)
    over.writeUInt32BE(0x7fffffff, over.indexOf(Buffer.from('meta')) - 4)
    expect(probeIsoBmffMeta(over)).toBeNull()
    const hugeLarge = Buffer.concat([ftyp('avif'), u32(1), Buffer.from('meta'), u32(0xffffffff), u32(0xffffffff)])
    expect(probeIsoBmffMeta(hugeLarge)).toBeNull()
    expect(probeIsoBmffMeta(heif('avif', [], [box('ispe', Buffer.alloc(6))], null, null))).toBeNull()
  })

  it('survives an ipma that claims far more entries than it holds', () => {
    const lying = fullBox('ipma', 0, 0, u32(0xffffffff), Buffer.from([0, 9, 1, 1]))
    expect(() => probeIsoBmffMeta(heif('avif', [], [ispe(30, 20)], lying, 1))).not.toThrow()
  })

  it('returns null for a zero-dimension ispe', () => {
    expect(probeIsoBmffMeta(heif('avif', [], [ispe(0, 20)], null, null))).toBeNull()
  })
})

describe('AVIF through the shrink and image-meta paths', () => {
  const avifPath = path.join(FIXTURES, 'magick-7.1.2-red-30x20.avif')

  it('is probe-only: not shrinkable, not a shrink candidate, and shrinkImage passes it through', async () => {
    const data = fs.readFileSync(avifPath)
    expect(canShrinkFormat('avif')).toBe(false)
    expect(canShrinkFormat('heic')).toBe(false)
    expect(await imageQualifiesForShrink(data)).toBe(false)
    expect(await shrinkImage(data, { sizeThresholdBytes: 0 })).toBeNull()
  })

  it('image-meta reports real dimensions and format, readable but not shrinkable', async () => {
    const meta = await runImageMeta(avifPath)
    expect(meta).toMatchObject({ width: 30, height: 20, format: 'avif', decodable: true, shrinkable: false, wouldShrink: false, shrunkBytes: null })
  })

  it('image-meta on a truncated ftyp file fails cleanly as an unreadable image', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-isobmff-'))
    try {
      const file = path.join(dir, 'broken.avif')
      fs.writeFileSync(file, ftyp('avif').subarray(0, 14))
      await expect(runImageMeta(file)).rejects.toThrow(`${file} is not a readable image`)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
