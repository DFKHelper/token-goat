import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import omggif from 'omggif'

import { decodeGif, probeBufferMeta, quantizeRgbaToIndexed } from '../src/image_engine.js'
import { preReadImageHandler } from '../src/image_shrink.js'
import { makeHookEvent } from './helpers/hook-event.js'

const here = path.dirname(fileURLToPath(import.meta.url))

// CAPTURE. Real producer output, not written from this repo's own decoder. Generated on this
// machine with ImageMagick 7.1.2-18 Q16-HDRI x64 d4e4b2b:20260322 by rendering three 48x48 PNGs
// (solid #2563eb background, an 8x8 #dc2626 box at y=20 moving x=8 -> 16 -> 24) and running:
// magick -delay 20 -loop 0 d0.png d1.png d2.png -layers Optimize tests/fixtures/animated_delta.gif
// `-layers Optimize` is what makes frames 1 and 2 sub-rectangles (16x8 at y=20) rather than full
// canvases; that delta shape is the whole point of the fixture and is asserted below.
const deltaGif = fs.readFileSync(path.join(here, 'fixtures', 'animated_delta.gif'))

const BACKGROUND_RGBA = [37, 99, 235, 255]

function makeGif(build: (writer: omggif.GifWriter) => void, width: number, height: number): Buffer {
  const buf = Buffer.alloc(width * height * 5 * 8 + 4096)
  const writer = new omggif.GifWriter(buf, width, height, { loop: 0 })
  build(writer)
  return Buffer.from(buf.subarray(0, writer.end()))
}

function pixelAt(data: Buffer, width: number, x: number, y: number): number[] {
  const off = (y * width + x) * 4
  return [data[off], data[off + 1], data[off + 2], data[off + 3]]
}

describe('decodeGif composites delta frames onto the running canvas', () => {
  it('keeps the fixture in the delta shape its provenance describes', () => {
    expect(probeBufferMeta(deltaGif)?.pages).toBe(3)
    // Without this the fixture could silently become full-canvas and the compositing test below
    // would pass on the bug it exists to catch.
    expect(new omggif.GifReader(deltaGif).frameInfo(1).width).toBeLessThan(48)
  })

  it('reproduces frame 0 background outside a later frame rectangle', () => {
    const { frames, width } = decodeGif(deltaGif)
    expect(frames).toHaveLength(3)
    // (2, 2) is outside every sub-rectangle (all of which sit at y=20..27), so frames 1 and 2 never
    // paint it. Before compositing they read [0, 0, 0, 0] there.
    expect(pixelAt(frames[0]!.data, width, 2, 2)).toEqual(BACKGROUND_RGBA)
    expect(pixelAt(frames[1]!.data, width, 2, 2)).toEqual(BACKGROUND_RGBA)
    expect(pixelAt(frames[2]!.data, width, 2, 2)).toEqual(BACKGROUND_RGBA)
  })

  it('does not alias every frame to the last composite', () => {
    const { frames, width } = decodeGif(deltaGif)
    // The box moves, so frame 0 and frame 2 must differ where frame 2's box landed.
    expect(pixelAt(frames[0]!.data, width, 28, 24)).not.toEqual(pixelAt(frames[2]!.data, width, 28, 24))
  })

  it('non-firing: decodes the full-canvas fixture to exactly the same bytes as before compositing', () => {
    // tests/fixtures/animated.gif is three full-canvas opaque frames, which compose to themselves;
    // compositing must not perturb a single byte of what the shrink path already emitted for it.
    const full = fs.readFileSync(path.join(here, 'fixtures', 'animated.gif'))
    const { frames } = decodeGif(full)
    expect(frames.length).toBeGreaterThan(1)
    const reader = new omggif.GifReader(full)
    for (const [i, frame] of frames.entries()) {
      const bare = Buffer.alloc(reader.width * reader.height * 4)
      reader.decodeAndBlitFrameRGBA(i, bare)
      expect(frame.data.equals(bare)).toBe(true)
    }
  })

  it('leaves the single-frame still path on a bare canvas', () => {
    const { frames } = decodeGif(deltaGif, { maxFrames: 1 })
    expect(frames).toHaveLength(1)
    expect(frames[0]!.data.equals(decodeGif(deltaGif).frames[0]!.data)).toBe(true)
  })
})

describe('decodeGif honours frame disposal', () => {
  // FORMAT-DERIVED from omggif's own writer (node_modules/omggif/omggif.js, `GifWriter.addFrame`,
  // whose `opts.disposal` is written into the graphic control extension at omggif.js:159-177). Not
  // a capture: it proves agreement with omggif's encoder, which is also the decoder under test.
  const SIZE = 8
  const RED = 0
  const GREEN = 1
  const BLUE = 2
  const palette = [0xff0000, 0x00ff00, 0x0000ff, 0x000000]

  function rect(base: number, patch: number | null): number[] {
    const px = new Array<number>(SIZE * SIZE).fill(base)
    if (patch !== null) px[2 * SIZE + 2] = patch
    return px
  }

  it('clears a disposal-2 rectangle before the next frame', () => {
    const gif = makeGif((w) => {
      w.addFrame(0, 0, SIZE, SIZE, rect(RED, null), { palette })
      w.addFrame(2, 2, 2, 2, [GREEN, GREEN, GREEN, GREEN], { palette, disposal: 2 })
      w.addFrame(6, 6, 1, 1, [BLUE], { palette, disposal: 1 })
    }, SIZE, SIZE)

    const { frames, width } = decodeGif(gif)
    expect(frames).toHaveLength(3)
    // Frame 2 still shows frame 1's red outside its own 2x2 rectangle.
    expect(pixelAt(frames[1]!.data, width, 0, 0)).toEqual([255, 0, 0, 255])
    expect(pixelAt(frames[1]!.data, width, 2, 2)).toEqual([0, 255, 0, 255])
    // Frame 3 must NOT contain frame 2's green: disposal 2 cleared that rectangle first.
    expect(pixelAt(frames[2]!.data, width, 2, 2)).not.toEqual([0, 255, 0, 255])
    expect(pixelAt(frames[2]!.data, width, 2, 2)).toEqual([0, 0, 0, 0])
    expect(pixelAt(frames[2]!.data, width, 0, 0)).toEqual([255, 0, 0, 255])
  })

  it('restores the pre-frame canvas after a disposal-3 frame', () => {
    const gif = makeGif((w) => {
      w.addFrame(0, 0, SIZE, SIZE, rect(RED, null), { palette })
      w.addFrame(2, 2, 2, 2, [GREEN, GREEN, GREEN, GREEN], { palette, disposal: 3 })
      w.addFrame(6, 6, 1, 1, [BLUE], { palette, disposal: 1 })
    }, SIZE, SIZE)

    const { frames, width } = decodeGif(gif)
    expect(pixelAt(frames[1]!.data, width, 2, 2)).toEqual([0, 255, 0, 255])
    // Disposal 3 restores what was there before frame 2 painted: frame 1's red, not a cleared hole.
    expect(pixelAt(frames[2]!.data, width, 2, 2)).toEqual([255, 0, 0, 255])
    expect(pixelAt(frames[2]!.data, width, 6, 6)).toEqual([0, 0, 255, 255])
  })
})

describe('quantizeRgbaToIndexed reserves an index for transparency', () => {
  it('non-firing: leaves a fully opaque frame untouched', () => {
    const pixels = new Uint8Array(4 * 4 * 4)
    for (let i = 0; i < 16; i++) {
      pixels.set([200, 100, 50, 255], i * 4)
    }
    const { indexedPixels, palette, transparentIndex } = quantizeRgbaToIndexed(pixels, 4, 4)
    expect(indexedPixels).toHaveLength(16)
    expect(palette).toHaveLength(256)
    expect(transparentIndex).toBeNull()
    // Every opaque pixel keeps the plain 8x8x4 index it always had, including no remap away from 0.
    for (const idx of indexedPixels) expect(idx).toBe((6 << 5) | (3 << 2) | 0)
  })

  it('maps alpha below half to the reserved index and moves black off it', () => {
    const pixels = new Uint8Array(4 * 4)
    pixels.set([0, 0, 0, 0], 0)
    pixels.set([0, 0, 0, 255], 4)
    pixels.set([255, 255, 255, 255], 8)
    pixels.set([0, 0, 0, 200], 12)
    const { indexedPixels, transparentIndex } = quantizeRgbaToIndexed(pixels, 4, 1)
    expect(transparentIndex).toBe(0)
    expect(indexedPixels[0]).toBe(0)
    expect(indexedPixels[1]).toBe(1)
    expect(indexedPixels[2]).toBe(255)
    expect(indexedPixels[3]).toBe(1)
  })
})

describe('the shrink path delivers composited, transparency-preserving GIFs', () => {
  const W = 2400
  const H = 600
  const DELTA_W = 960

  function noiseIndexes(n: number, seed: number): number[] {
    const out = new Array<number>(n)
    let s = seed
    for (let i = 0; i < n; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff
      out[i] = 1 + (s % 250)
    }
    return out
  }

  const bigPalette: number[] = []
  for (let i = 0; i < 256; i++) bigPalette.push((i << 16) | ((255 - i) << 8) | ((i * 7) & 0xff))

  function deltaSource(): Buffer {
    return makeGif((w) => {
      w.addFrame(0, 0, W, H, noiseIndexes(W * H, 99), { palette: bigPalette })
      // Large noisy sub-rectangles rather than tiny patches: a delta source whose frames after the
      // first are cheap encodes to less than its own composited re-encode and the shrink declines,
      // which would leave this test never reaching the branch it exists to check.
      w.addFrame(0, 0, DELTA_W, H, noiseIndexes(DELTA_W * H, 31), { palette: bigPalette, disposal: 1 })
      w.addFrame(DELTA_W, 0, DELTA_W, H, noiseIndexes(DELTA_W * H, 77), { palette: bigPalette, disposal: 1 })
    }, W, H)
  }

  async function runHandler(buf: Buffer, tag: string): Promise<{ text: string; gif: Buffer | null }> {
    const dir = fs.mkdtempSync(path.join(process.env.TEMP ?? '/tmp', 'tg-gifc-'))
    const file = path.join(dir, `${tag}.gif`)
    fs.writeFileSync(file, buf)
    const out = await preReadImageHandler(makeHookEvent({ toolName: 'Read', toolInput: { file_path: file } }))
    const text = JSON.stringify(out ?? {})
    const m = /data:image\/gif;base64,([A-Za-z0-9+/=]+)/.exec(text)
    return { text, gif: m ? Buffer.from(m[1]!, 'base64') : null }
  }

  it('does not hand back a mostly black second frame', async () => {
    const src = deltaSource()
    expect(src.length).toBeGreaterThan(512 * 1024)
    const { text, gif } = await runHandler(src, 'delta')

    if (!gif) {
      // Declining is the honest outcome for a delta source whose composited re-encode is larger.
      expect(text).toMatch(/skipped|^\{\}$/)
      return
    }

    const reader = new omggif.GifReader(gif)
    // Must not drop: the notice's dimensions have to be the dimensions actually delivered.
    expect(text).toContain(`${reader.width}x${reader.height} gif`)

    const rgba = Buffer.alloc(reader.width * reader.height * 4)
    reader.decodeAndBlitFrameRGBA(1, rgba)
    let black = 0
    for (let i = 0; i < reader.width * reader.height; i++) {
      if (rgba[i * 4]! < 16 && rgba[i * 4 + 1]! < 16 && rgba[i * 4 + 2]! < 16) black++
    }
    expect(black / (reader.width * reader.height)).toBeLessThan(0.5)
  })

  it('carries a transparent index through to the delivered GIF', async () => {
    const src = makeGif((w) => {
      const frame = noiseIndexes(W * H, 4242)
      for (let y = 0; y < 200; y++) {
        for (let x = 0; x < 200; x++) frame[y * W + x] = 0
      }
      w.addFrame(0, 0, W, H, frame, { palette: bigPalette, transparent: 0 })
      const second = noiseIndexes(W * H, 777)
      for (let y = 0; y < 200; y++) {
        for (let x = 0; x < 200; x++) second[y * W + x] = 0
      }
      w.addFrame(0, 0, W, H, second, { palette: bigPalette, transparent: 0 })
    }, W, H)

    const { gif } = await runHandler(src, 'transparent')
    expect(gif).not.toBeNull()
    const reader = new omggif.GifReader(gif!)
    expect(reader.frameInfo(0).transparent_index).not.toBeNull()

    const rgba = Buffer.alloc(reader.width * reader.height * 4)
    reader.decodeAndBlitFrameRGBA(0, rgba)
    // omggif skips transparent pixels entirely, so the region stays at the zeroed canvas value
    // rather than arriving as an opaque palette-0 black.
    expect(rgba[3]).toBe(0)
  })
})
