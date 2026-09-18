import * as fs from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it, vi } from 'vitest'
import omggif from 'omggif'

import { decodeGif, GIF_WEB_PALETTE, quantizeRgbaToIndexed } from '../src/image_engine.js'
import { gifFrameDelta, sliceIndexedRect, unionRects } from '../src/image_gif_encode.js'
import { shrinkImage } from '../src/image_shrink.js'

// FORMAT-DERIVED from omggif's own writer (node_modules/omggif/omggif.js, `GifWriter.addFrame`,
// whose x/y/w/h arguments become the image descriptor's Left/Top/Width/Height and whose
// `opts.disposal` becomes the graphic control extension's disposal field). Built here rather than
// committed because the shrink path needs a source over its 512 KB threshold, and because the
// property under test is the shape of what token-goat writes, not of what any one encoder produced.
// Frame 0 is a full canvas; every frame after it is a genuine sub-rectangle, which is what makes
// the source smaller than a full-canvas re-encode of the same animation.
const W = 1400
const H = 1400
const PATCH = 160
const PATCH_Y = 600
const FRAMES = 8

const SOURCE_PALETTE: number[] = []
for (let i = 0; i < 256; i++) SOURCE_PALETTE.push((i << 16) | ((255 - i) << 8) | ((i * 7) & 0xff))

function patchX(i: number): number {
  return 100 + i * 120
}

function baseIndexes(): number[] {
  const out = new Array<number>(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) out[y * W + x] = (((x * 3 + y * 5) >> 3) % 251) + 1
  }
  return out
}

function deltaOptimisedSource(): Buffer {
  const buf = Buffer.alloc(W * H * 5 * (FRAMES + 1) + 4096)
  const writer = new omggif.GifWriter(buf, W, H, { loop: 0 })
  writer.addFrame(0, 0, W, H, baseIndexes(), { palette: SOURCE_PALETTE, delay: 8, disposal: 1 })
  for (let i = 0; i < FRAMES; i++) {
    writer.addFrame(patchX(i), PATCH_Y, PATCH, PATCH, new Array<number>(PATCH * PATCH).fill(20 + i), {
      palette: SOURCE_PALETTE,
      delay: 8,
      disposal: 1,
    })
  }
  return Buffer.from(buf.subarray(0, writer.end()))
}

function pixelAt(data: Buffer, width: number, x: number, y: number): number[] {
  const off = (y * width + x) * 4
  return [data[off], data[off + 1], data[off + 2], data[off + 3]]
}

/** Pixels of `delivered` that are not what quantizing `expected` to the web palette says they should be, transparency included. */
function countMismatches(expected: Buffer, delivered: Buffer): number {
  const { indexedPixels, transparentIndex } = quantizeRgbaToIndexed(expected, W, H)
  let mismatched = 0
  for (let p = 0; p < W * H; p++) {
    if (transparentIndex !== null && indexedPixels[p] === transparentIndex) {
      if (delivered[p * 4 + 3] !== 0) mismatched++
      continue
    }
    const rgb = GIF_WEB_PALETTE[indexedPixels[p]!]!
    if (
      delivered[p * 4] !== ((rgb >> 16) & 0xff) ||
      delivered[p * 4 + 1] !== ((rgb >> 8) & 0xff) ||
      delivered[p * 4 + 2] !== (rgb & 0xff) ||
      delivered[p * 4 + 3] !== 255
    ) {
      mismatched++
    }
  }
  return mismatched
}

describe('gifFrameDelta', () => {
  // HAND-DERIVED: the boxes below are read off the inputs by hand, not off this function's output.
  it('boxes only the pixels whose colour differs', () => {
    const prev = new Array<number>(16).fill(5)
    const cur = prev.slice()
    cur[1 * 4 + 1] = 9
    cur[2 * 4 + 2] = 9
    const { changed, cleared } = gifFrameDelta(prev, null, cur, null, 4, 4)
    expect(changed).toEqual({ x: 1, y: 1, width: 2, height: 2 })
    expect(cleared).toBe(false)
  })

  it('returns a 1x1 box for an identical frame rather than nothing, so the frame keeps its delay', () => {
    const prev = new Array<number>(16).fill(5)
    const { changed, cleared } = gifFrameDelta(prev, null, prev.slice(), null, 4, 4)
    expect(changed).toEqual({ x: 0, y: 0, width: 1, height: 1 })
    expect(cleared).toBe(false)
  })

  it('does not call a pixel changed when both frames have it transparent under different indexes', () => {
    const prev = new Array<number>(16).fill(5)
    const cur = new Array<number>(16).fill(5)
    prev[0] = 0
    cur[0] = 7
    const { changed } = gifFrameDelta(prev, 0, cur, 7, 4, 4)
    expect(changed).toEqual({ x: 0, y: 0, width: 1, height: 1 })
  })

  it('flags a pixel going opaque -> transparent, and not one going transparent -> opaque', () => {
    const prev = new Array<number>(16).fill(5)
    const cur = prev.slice()
    cur[2 * 4 + 2] = 0
    expect(gifFrameDelta(prev, null, cur, 0, 4, 4)).toEqual({ changed: { x: 2, y: 2, width: 1, height: 1 }, cleared: true })
    expect(gifFrameDelta(cur, 0, prev, null, 4, 4).cleared).toBe(false)
  })
})

describe('sliceIndexedRect and unionRects', () => {
  it('copies a rectangle row-major and hands back the input untouched for a whole canvas', () => {
    const canvas = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
    expect(sliceIndexedRect(canvas, 4, { x: 1, y: 1, width: 2, height: 2 })).toEqual([5, 6, 9, 10])
    expect(sliceIndexedRect(canvas, 4, { x: 0, y: 0, width: 4, height: 3 })).toBe(canvas)
  })

  it('takes the smallest box containing both', () => {
    expect(unionRects({ x: 2, y: 3, width: 2, height: 2 }, { x: 10, y: 1, width: 1, height: 1 })).toEqual({
      x: 2,
      y: 1,
      width: 9,
      height: 4,
    })
  })
})

describe('the shrink path re-encodes animated GIFs as delta frames', () => {
  it('beats a delta-optimised source instead of declining, and writes sub-rectangle frames', async () => {
    const src = deltaOptimisedSource()
    expect(src.length).toBeGreaterThan(512 * 1024)

    const result = await shrinkImage(src)
    // Full-canvas output for this source is several times the input and the size guard declines it,
    // so a regression to full-canvas frames turns this null rather than merely making it larger.
    expect(result).not.toBeNull()
    expect(result!.shrunkBytes).toBeLessThan(src.length)

    const reader = new omggif.GifReader(result!.data)
    expect(reader.numFrames()).toBe(FRAMES + 1)
    expect(reader.frameInfo(0).width).toBe(W)
    for (let i = 0; i < reader.numFrames(); i++) {
      // Every frame quantizes to the same fixed palette, so it is written once as the global colour
      // table; a local table per frame would be 768 bytes each of pure duplication.
      expect(reader.frameInfo(i).has_local_palette).toBe(false)
    }
    for (let i = 1; i < reader.numFrames(); i++) {
      const info = reader.frameInfo(i)
      expect(info.width).toBeLessThan(W)
      // Disposal 1 (leave in place) is the only disposal a delta frame may carry: anything that
      // clears its rectangle erases the region the next frame inherits its unchanged pixels from.
      expect(info.disposal).toBe(1)
      expect(info.delay).toBe(8)
    }
  })

  it('round-trips every frame to the same picture a full-canvas re-encode would have delivered', async () => {
    const src = deltaOptimisedSource()
    const result = await shrinkImage(src)
    expect(result).not.toBeNull()

    const input = decodeGif(src)
    const output = decodeGif(result!.data)
    expect(output.width).toBe(W)
    expect(output.height).toBe(H)
    expect(output.frames).toHaveLength(input.frames.length)

    for (const [i, frame] of input.frames.entries()) {
      const { indexedPixels, transparentIndex } = quantizeRgbaToIndexed(frame.data, W, H)
      expect(transparentIndex).toBeNull()
      const got = output.frames[i]!.data
      let mismatched = 0
      for (let p = 0; p < W * H; p++) {
        const rgb = GIF_WEB_PALETTE[indexedPixels[p]!]!
        if (
          got[p * 4] !== ((rgb >> 16) & 0xff) ||
          got[p * 4 + 1] !== ((rgb >> 8) & 0xff) ||
          got[p * 4 + 2] !== (rgb & 0xff) ||
          got[p * 4 + 3] !== 255
        ) {
          mismatched++
        }
      }
      expect(mismatched).toBe(0)
    }

    // Must not drop, as literal values rather than a count: (10, 10) is outside every patch and has
    // to hold the background colour in every delivered frame, and the centre of patch 3 has to be
    // background before frame 4 paints it and the patch colour from frame 4 onwards. A delta
    // encoder that dropped the unchanged region would blank the first; one that dropped the changed
    // region would blank the second.
    const corner = [0, 255, 85, 255]
    const centreBackground = [109, 146, 85, 255]
    const painted = [0, 255, 170, 255]
    const centre = { x: patchX(3) + PATCH / 2, y: PATCH_Y + PATCH / 2 }
    for (const frame of output.frames) expect(pixelAt(frame.data, W, 10, 10)).toEqual(corner)
    expect(pixelAt(output.frames[3]!.data, W, centre.x, centre.y)).toEqual(centreBackground)
    expect(pixelAt(output.frames[4]!.data, W, centre.x, centre.y)).toEqual(painted)
    expect(pixelAt(output.frames[8]!.data, W, centre.x, centre.y)).toEqual(painted)
  })

  it('clears before a frame whose pixels go transparent, and still delivers every frame exactly', async () => {
    const base = baseIndexes()
    const buf = Buffer.alloc(W * H * 5 * (FRAMES + 1) + 4096)
    const writer = new omggif.GifWriter(buf, W, H, { loop: 0 })
    writer.addFrame(0, 0, W, H, base, { palette: SOURCE_PALETTE, delay: 8, disposal: 1 })
    for (let i = 0; i < FRAMES; i++) {
      // Disposal 2 punches a genuine transparent hole into the composited canvas that follows it,
      // which is the one shape a disposal-1 delta cannot express. Two of them back to back, at
      // different positions, is the case where the frame that has to be disposed is wider than the
      // hole itself: its own box already spans the previous hole, and everything opaque inside that
      // span has to be repainted by the frame after it even though none of it changed.
      writer.addFrame(patchX(i), PATCH_Y, PATCH, PATCH, new Array<number>(PATCH * PATCH).fill(20 + i), {
        palette: SOURCE_PALETTE,
        delay: 8,
        disposal: i === 3 || i === 4 ? 2 : 1,
      })
    }
    const src = Buffer.from(buf.subarray(0, writer.end()))

    const result = await shrinkImage(src)
    expect(result).not.toBeNull()
    expect(result!.shrunkBytes).toBeLessThan(src.length)

    const reader = new omggif.GifReader(result!.data)
    const disposals = Array.from({ length: reader.numFrames() }, (_, i) => reader.frameInfo(i).disposal)
    expect(disposals).toContain(2)

    const input = decodeGif(src)
    const output = decodeGif(result!.data)
    for (const [i, frame] of input.frames.entries()) {
      const { indexedPixels, transparentIndex } = quantizeRgbaToIndexed(frame.data, W, H)
      const got = output.frames[i]!.data
      let mismatched = 0
      for (let p = 0; p < W * H; p++) {
        if (transparentIndex !== null && indexedPixels[p] === transparentIndex) {
          if (got[p * 4 + 3] !== 0) mismatched++
          continue
        }
        const rgb = GIF_WEB_PALETTE[indexedPixels[p]!]!
        if (
          got[p * 4] !== ((rgb >> 16) & 0xff) ||
          got[p * 4 + 1] !== ((rgb >> 8) & 0xff) ||
          got[p * 4 + 2] !== (rgb & 0xff) ||
          got[p * 4 + 3] !== 255
        ) {
          mismatched++
        }
      }
      expect(mismatched).toBe(0)
    }

    // Must not drop, literal: patch 3 is painted in frame 4 and its disposal leaves frame 5 with a
    // genuinely transparent hole there, while a pixel outside the hole keeps the background colour
    // rather than being cleared along with it.
    const centre = { x: patchX(3) + PATCH / 2, y: PATCH_Y + PATCH / 2 }
    expect(pixelAt(output.frames[4]!.data, W, centre.x, centre.y)).toEqual([0, 255, 170, 255])
    expect(pixelAt(output.frames[5]!.data, W, centre.x, centre.y)).toEqual([0, 0, 0, 0])
    expect(pixelAt(output.frames[5]!.data, W, 10, 10)).toEqual([0, 255, 85, 255])
  })

  it('repaints everything a widened clear wiped, not just what changed', async () => {
    // A disposal-3 frame restores an opaque region, so the composited step after it changes two
    // disjoint places at once -- the restored region and whatever the frame painted -- and the box
    // spanning them is full of opaque background that changed nothing. When the frame after that
    // punches a transparent hole, that whole box is what has to be disposed, so the repaint frame
    // has to cover the box and not merely the hole. Measured: covering only the changed box leaves
    // 128,000 background pixels transparent.
    const buf = Buffer.alloc(W * H * 5 * 6 + 4096)
    const writer = new omggif.GifWriter(buf, W, H, { loop: 0 })
    writer.addFrame(0, 0, W, H, baseIndexes(), { palette: SOURCE_PALETTE, delay: 8, disposal: 1 })
    writer.addFrame(100, PATCH_Y, PATCH, PATCH, new Array<number>(PATCH * PATCH).fill(30), {
      palette: SOURCE_PALETTE,
      delay: 8,
      disposal: 3,
    })
    writer.addFrame(900, PATCH_Y, PATCH, PATCH, new Array<number>(PATCH * PATCH).fill(60), {
      palette: SOURCE_PALETTE,
      delay: 8,
      disposal: 2,
    })
    writer.addFrame(1100, PATCH_Y, PATCH, PATCH, new Array<number>(PATCH * PATCH).fill(90), {
      palette: SOURCE_PALETTE,
      delay: 8,
      disposal: 1,
    })
    const src = Buffer.from(buf.subarray(0, writer.end()))

    const result = await shrinkImage(src)
    expect(result).not.toBeNull()
    const input = decodeGif(src)
    const output = decodeGif(result!.data)
    for (const [i, frame] of input.frames.entries()) {
      expect({ frame: i, mismatched: countMismatches(frame.data, output.frames[i]!.data) }).toEqual({
        frame: i,
        mismatched: 0,
      })
    }
    // Must not drop, literal: the background midway between the restored region and the hole is
    // inside the disposed box and has to come back opaque in the last frame.
    expect(pixelAt(output.frames[3]!.data, W, 500, PATCH_Y + PATCH / 2)).toEqual([109, 146, 0, 255])
  })

  it('treats an index that means black in one frame and transparent in the next as a change', async () => {
    // The transparent index the quantizer reserves is index 0, which in a frame with no transparency
    // at all is plain black. Comparing raw indexes between frames therefore reads an opaque black
    // block and the transparent hole that replaces it as identical, and the hole never gets written.
    const BLOCK = 200
    const BLOCK_X = 300
    const palette = SOURCE_PALETTE.slice()
    palette[200] = 0x000000
    const base = baseIndexes()
    for (let y = PATCH_Y; y < PATCH_Y + BLOCK; y++) {
      for (let x = BLOCK_X; x < BLOCK_X + BLOCK; x++) base[y * W + x] = 200
    }
    const buf = Buffer.alloc(W * H * 5 * 5 + 4096)
    const writer = new omggif.GifWriter(buf, W, H, { loop: 0 })
    writer.addFrame(0, 0, W, H, base, { palette, delay: 8, disposal: 1 })
    writer.addFrame(BLOCK_X, PATCH_Y, BLOCK, BLOCK, new Array<number>(BLOCK * BLOCK).fill(200), {
      palette,
      delay: 8,
      disposal: 2,
    })
    writer.addFrame(900, PATCH_Y, PATCH, PATCH, new Array<number>(PATCH * PATCH).fill(60), {
      palette,
      delay: 8,
      disposal: 1,
    })
    const src = Buffer.from(buf.subarray(0, writer.end()))

    const result = await shrinkImage(src)
    expect(result).not.toBeNull()
    const input = decodeGif(src)
    const output = decodeGif(result!.data)
    // The collision the test exists for: the same index 0 in both frames, meaning black in one and
    // transparent in the other.
    expect(quantizeRgbaToIndexed(input.frames[1]!.data, W, H).transparentIndex).toBeNull()
    expect(quantizeRgbaToIndexed(input.frames[2]!.data, W, H).transparentIndex).toBe(0)
    // Must not drop, literal: opaque black while the block is painted, genuinely transparent once
    // its disposal has cleared it.
    expect(pixelAt(output.frames[1]!.data, W, BLOCK_X + 10, PATCH_Y + 10)).toEqual([0, 0, 0, 255])
    expect(pixelAt(output.frames[2]!.data, W, BLOCK_X + 10, PATCH_Y + 10)).toEqual([0, 0, 0, 0])
  })

  it('passes the original image through when the deferred encoder cannot be imported', async () => {
    // The encoder is reached by a dynamic import, so a broken or missing chunk is a runtime failure on a path nothing else can fail on. It must degrade to the same decline the size guard takes -- the original image, unshrunk -- and never surface as a throw out of a hook.
    vi.resetModules()
    vi.doMock('../src/image_gif_encode.js', () => {
      throw new Error('deferred chunk unavailable')
    })
    try {
      const { shrinkImage: withBrokenImport } = await import('../src/image_shrink.js')
      await expect(withBrokenImport(deltaOptimisedSource())).resolves.toBeNull()
    } finally {
      vi.doUnmock('../src/image_gif_encode.js')
      vi.resetModules()
    }
  })

  it('does not enlarge the committed full-canvas fixture into a decline', async () => {
    // tests/fixtures/animated.gif is three full-canvas frames; the delta path must still shrink it.
    const full = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'animated.gif'))
    const result = await shrinkImage(full, { sizeThresholdBytes: 0 })
    expect(result).not.toBeNull()
    expect(result!.shrunkBytes).toBeLessThan(full.length)
  })
})
