/** Re-encode an already-decoded animated GIF as delta frames. Split out of image_shrink.ts and reached only through a dynamic import so it stays out of the hook entry's eager set: every tool call parses that set, and an animated-GIF re-encoder is needed by a vanishingly small fraction of them. Nothing here may be imported statically from a module the hook path reaches, or the split buys nothing. */

import omggif from 'omggif'

import {
  assertDecodableSize,
  type DecodedAnimatedGif,
  GIF_WEB_PALETTE,
  quantizeRgbaToIndexed,
  resizeRgba,
} from './image_engine.js'

/** A pixel rectangle inside a frame canvas. */
export interface PixelRect {
  x: number
  y: number
  width: number
  height: number
}

/** What a GIF writer has to store for one frame, given that the previous frame is already on the canvas: the box of everything that changed, and whether any of it is a pixel going transparent. */
export interface GifFrameDelta {
  changed: PixelRect
  cleared: boolean
}

/** The smallest rectangle containing both. */
export function unionRects(a: PixelRect, b: PixelRect): PixelRect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y }
}

/** How `cur` differs from `prev`, two quantized frames of the same size, so `cur` can be written as a sub-rectangle over a canvas that already holds `prev`. Transparency is part of the comparison, because a pixel's index only means a colour when that index is not the frame's reserved transparent one -- index 0 is plain black in a frame that reserves nothing and the transparent slot in a frame that does. A pixel going opaque -> transparent sets `cleared`: a frame is blitted with its transparent pixels skipped, so the opaque pixel underneath would simply survive, and the only remedy the format offers is disposal 2 on the frame before it. An all-identical frame returns a 1x1 `changed` box rather than nothing, so the frame still exists to carry its own delay. */
export function gifFrameDelta(
  prev: ArrayLike<number>,
  prevTransparentIndex: number | null,
  cur: ArrayLike<number>,
  curTransparentIndex: number | null,
  width: number,
  height: number,
): GifFrameDelta {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  let cleared = false

  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      const i = row + x
      const curIdx = cur[i] ?? 0
      const prevIdx = prev[i] ?? 0
      const curClear = curTransparentIndex !== null && curIdx === curTransparentIndex
      if (curClear === (prevTransparentIndex !== null && prevIdx === prevTransparentIndex) && (curClear || curIdx === prevIdx)) continue
      if (curClear) cleared = true
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }

  if (maxX < 0) return { changed: { x: 0, y: 0, width: 1, height: 1 }, cleared: false }
  return { changed: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }, cleared }
}

/** Copy one rectangle out of a full-canvas indexed frame, row-major, as the pixel array a GIF writer expects for a sub-rectangle frame. Returns the input itself when the rectangle is the whole canvas, since no copy is needed then. */
export function sliceIndexedRect(indexed: number[], canvasWidth: number, rect: { x: number; y: number; width: number; height: number }): number[] {
  if (rect.x === 0 && rect.y === 0 && rect.width === canvasWidth && rect.height * canvasWidth === indexed.length) return indexed
  const out = new Array<number>(rect.width * rect.height)
  for (let row = 0; row < rect.height; row++) {
    const src = (rect.y + row) * canvasWidth + rect.x
    const dst = row * rect.width
    for (let col = 0; col < rect.width; col++) out[dst + col] = indexed[src + col] ?? 0
  }
  return out
}

/** Resize and re-encode every frame of `decoded` to `targetW` x `targetH`, as a GIF whose frames after the first are sub-rectangles of what changed. decodeGif hands back frames already composited to full canvas, so re-encoding each one as a full-canvas frame throws away the delta encoding the input almost certainly had and lands above the original byte count, where the caller's guard declines and the image ships unshrunk. Each frame after the first is therefore diffed against the previous output frame and written as the bounding box of what changed. A delta frame is written with disposal 1 (leave in place): any disposal that clears the frame's own rectangle would erase exactly the region the next frame inherits its unchanged pixels from. The input's own disposal is deliberately not carried over -- it describes the input's sub-rectangles, and these frames are a different decomposition of the same animation. The one shape disposal 1 cannot express is a pixel going opaque -> transparent: a frame is blitted with its transparent pixels skipped, so the opaque pixel underneath would survive. The only remedy the format offers is disposal 2 on the frame before it, which clears that frame's own rectangle -- so the earlier frame is widened to span its own box and everything that changed, written with disposal 2, and the current frame is written over that same widened box so it repaints everything the clear wiped. That is why each frame is held back one iteration: its disposal is not known until the frame after it has been quantized. */
export function encodeAnimatedGifDelta(decoded: DecodedAnimatedGif, targetW: number, targetH: number): Buffer {
  // The decode ceiling bounds the frames going in; it does not bound what comes out. This buffer is a second allocation of the same shape -- five bytes per pixel per frame -- and at a 1568x1568 output it passes the ceiling at 25 frames, so peak memory was the sum of two budgets with only one of them checked. Sized and checked here rather than left to the input bound, which is the wrong number for it.
  assertDecodableSize('GIF output', targetW, targetH, 5, decoded.frames.length)
  const outBuf = Buffer.alloc(targetW * targetH * 5 * decoded.frames.length + 4096)
  // Every frame quantizes to the same fixed palette, so it is declared once as the global colour table and no frame carries a local one; that is also the palette each sub-rectangle below is written against.
  const gifWriter = new omggif.GifWriter(outBuf, targetW, targetH, { loop: 0, palette: GIF_WEB_PALETTE })

  let pending: { rect: PixelRect; pixels: number[]; canvas: number[]; transparent: number | null; delay: number } | null = null

  const writePending = (disposal: number): void => {
    if (pending === null) return
    gifWriter.addFrame(pending.rect.x, pending.rect.y, pending.rect.width, pending.rect.height, pending.pixels, {
      delay: pending.delay,
      disposal,
      ...(pending.transparent === null ? {} : { transparent: pending.transparent }),
    })
    pending = null
  }

  for (const frame of decoded.frames) {
    const resizedFrameRgba = resizeRgba(frame.data, frame.width, frame.height, targetW, targetH)
    const { indexedPixels, transparentIndex } = quantizeRgbaToIndexed(resizedFrameRgba, targetW, targetH)
    let rect: PixelRect = { x: 0, y: 0, width: targetW, height: targetH }

    if (pending !== null) {
      const delta = gifFrameDelta(pending.canvas, pending.transparent, indexedPixels, transparentIndex, targetW, targetH)
      rect = delta.changed
      if (delta.cleared) {
        rect = unionRects(pending.rect, delta.changed)
        pending = { ...pending, rect, pixels: sliceIndexedRect(pending.canvas, targetW, rect) }
        writePending(2)
      } else {
        writePending(1)
      }
    }

    pending = {
      rect,
      pixels: sliceIndexedRect(indexedPixels, targetW, rect),
      canvas: indexedPixels,
      transparent: transparentIndex,
      delay: frame.delay,
    }
  }
  writePending(1)

  return outBuf.subarray(0, gifWriter.end())
}
