/** Image slicing, difference calculation, and compact visual layout inspection.
 * Zero external dependencies: pure TypeScript/JS using the internal decoders in `image_engine.ts`
 * and `image_shrink.ts`.
 */

import * as fs from 'node:fs'
import { isImagePath } from './asset_extensions.js'
import { couldNotReadError } from './could_not_read.js'
import { echoedValue } from './hint_suggestion_guard.js'
import {
  applyExifOrientation,
  encodeJpeg,
  encodePng,
} from './image_engine.js'
import { canShrinkFormat, probeImageMeta, SINGLE_FRAME_DECODERS } from './image_shrink.js'

export interface ImageSliceOptions {
  /** X offset in pixels (0-based) */
  readonly x?: number
  /** Y offset in pixels (0-based) */
  readonly y?: number
  /** Width in pixels */
  readonly width?: number
  /** Height in pixels */
  readonly height?: number
  /** Output format: png or jpeg (default: png) */
  readonly format?: 'png' | 'jpeg'
  /** Quality when encoding jpeg (1-100, default: 85) */
  readonly quality?: number
}

export interface ImageSliceResult {
  readonly originalWidth: number
  readonly originalHeight: number
  readonly cropX: number
  readonly cropY: number
  readonly cropWidth: number
  readonly cropHeight: number
  readonly format: 'png' | 'jpeg'
  readonly data: Buffer
  readonly bytes: number
}

export interface ImageDiffResult {
  readonly width: number
  readonly height: number
  readonly totalPixels: number
  readonly differentPixels: number
  readonly diffPercentage: number
  readonly identical: boolean
  readonly boundingBox: {
    readonly minX: number
    readonly minY: number
    readonly maxX: number
    readonly maxY: number
    readonly width: number
    readonly height: number
  } | null
}

function decodeImageRgba(data: Buffer, format: string | null, orientation?: number): { width: number; height: number; data: Uint8Array } {
  const decode = SINGLE_FRAME_DECODERS.get(format ?? '')
  if (!decode) {
    throw new Error(`Unsupported image format for decoding: ${format ?? 'unknown'}`)
  }
  const decoded = decode(data)
  if (!decoded) {
    throw new Error(`Failed to decode image format: ${format ?? 'unknown'}`)
  }

  return applyExifOrientation(decoded.data, decoded.width, decoded.height, orientation)
}

/** Crop/slice an image to a specific bounding sub-rectangle without full image token overhead. */
export async function sliceImage(filePath: string, opts: ImageSliceOptions = {}): Promise<ImageSliceResult> {
  if (!fs.existsSync(filePath)) {
    throw couldNotReadError(filePath)
  }
  if (!isImagePath(filePath)) {
    throw new Error(`Not an image file: ${filePath}`)
  }

  const rawBytes = fs.readFileSync(filePath)
  const probe = await probeImageMeta(rawBytes)
  if (!probe || probe.width <= 0 || probe.height <= 0) {
    throw new Error(`${filePath} is not a readable image`)
  }

  if (!canShrinkFormat(probe.format)) {
    throw new Error(`Cannot slice image format ${echoedValue(probe.format ?? 'unknown')}: decoder unavailable`)
  }

  const decoded = decodeImageRgba(rawBytes, probe.format, probe.orientation)

  const origW = decoded.width
  const origH = decoded.height

  const cropX = Math.max(0, Math.min(origW - 1, Math.floor(opts.x ?? 0)))
  const cropY = Math.max(0, Math.min(origH - 1, Math.floor(opts.y ?? 0)))
  let cropW = opts.width !== undefined ? Math.floor(opts.width) : origW - cropX
  let cropH = opts.height !== undefined ? Math.floor(opts.height) : origH - cropY

  if (cropW <= 0) cropW = 1
  if (cropH <= 0) cropH = 1

  if (cropX + cropW > origW) cropW = origW - cropX
  if (cropY + cropH > origH) cropH = origH - cropY

  const targetFormat = opts.format ?? 'png'
  const croppedRgba = Buffer.alloc(cropW * cropH * 4)

  for (let dy = 0; dy < cropH; dy++) {
    const srcY = cropY + dy
    const srcRowOffset = (srcY * origW + cropX) * 4
    const dstRowOffset = dy * cropW * 4
    Buffer.from(decoded.data.buffer, decoded.data.byteOffset + srcRowOffset, cropW * 4).copy(
      croppedRgba,
      dstRowOffset,
    )
  }

  const outData = targetFormat === 'jpeg'
    ? encodeJpeg(cropW, cropH, croppedRgba, opts.quality ?? 85)
    : encodePng(cropW, cropH, croppedRgba)

  return {
    originalWidth: origW,
    originalHeight: origH,
    cropX,
    cropY,
    cropWidth: cropW,
    cropHeight: cropH,
    format: targetFormat,
    data: outData,
    bytes: outData.length,
  }
}

/** Compute pixel difference and spatial change bounding box between two images. */
export async function diffImages(
  fileA: string,
  fileB: string,
  opts: { tolerance?: number } = {},
): Promise<ImageDiffResult> {
  if (!fs.existsSync(fileA)) throw couldNotReadError(fileA)
  if (!fs.existsSync(fileB)) throw couldNotReadError(fileB)
  if (!isImagePath(fileA)) throw new Error(`Not an image file: ${fileA}`)
  if (!isImagePath(fileB)) throw new Error(`Not an image file: ${fileB}`)

  const bytesA = fs.readFileSync(fileA)
  const bytesB = fs.readFileSync(fileB)

  const probeA = await probeImageMeta(bytesA)
  const probeB = await probeImageMeta(bytesB)

  if (!probeA || probeA.width <= 0 || probeA.height <= 0) throw new Error(`${fileA} is not a readable image`)
  if (!probeB || probeB.width <= 0 || probeB.height <= 0) throw new Error(`${fileB} is not a readable image`)

  const decodedA = decodeImageRgba(bytesA, probeA.format, probeA.orientation)
  const decodedB = decodeImageRgba(bytesB, probeB.format, probeB.orientation)

  if (decodedA.width !== decodedB.width || decodedA.height !== decodedB.height) {
    throw new Error(
      `Image dimensions do not match for diff: ${decodedA.width}x${decodedA.height} vs ${decodedB.width}x${decodedB.height}`,
    )
  }

  const width = decodedA.width
  const height = decodedA.height
  const totalPixels = width * height
  const tolerance = opts.tolerance ?? 0 // 0-255 per channel difference threshold

  let diffPixels = 0
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  const dataA = decodedA.data
  const dataB = decodedB.data

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4
      const dr = Math.abs((dataA[idx] ?? 0) - (dataB[idx] ?? 0))
      const dg = Math.abs((dataA[idx + 1] ?? 0) - (dataB[idx + 1] ?? 0))
      const db = Math.abs((dataA[idx + 2] ?? 0) - (dataB[idx + 2] ?? 0))
      const da = Math.abs((dataA[idx + 3] ?? 255) - (dataB[idx + 3] ?? 255))

      if (dr > tolerance || dg > tolerance || db > tolerance || da > tolerance) {
        diffPixels++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }

  const diffPercentage = totalPixels > 0 ? Number(((diffPixels / totalPixels) * 100).toFixed(2)) : 0
  const identical = diffPixels === 0

  return {
    width,
    height,
    totalPixels,
    differentPixels: diffPixels,
    diffPercentage,
    identical,
    boundingBox: identical
      ? null
      : {
          minX,
          minY,
          maxX,
          maxY,
          width: maxX - minX + 1,
          height: maxY - minY + 1,
        },
  }
}
