import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'
import sharp from 'sharp'

import { sliceImage, diffImages, runImageMeta } from '../src/read_commands.js'
import { run } from '../src/cli.js'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-image-slice-test-'))

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  let output = ''
  const origWrite = process.stdout.write
  process.stdout.write = ((chunk: unknown) => { output += String(chunk); return true }) as typeof process.stdout.write
  try {
    await fn()
  } finally {
    process.stdout.write = origWrite
  }
  return output
}

describe('image-meta enhancements', () => {
  it('calculates aspect ratio and estimated visual tokens', async () => {
    // 840x560 image: 840/560 = 1.5, visual tokens = ceil(840/28) * ceil(560/28) = 30 * 20 = 600
    const png = await sharp({ create: { width: 840, height: 560, channels: 3, background: { r: 100, g: 150, b: 200 } } })
      .png()
      .toBuffer()
    const file = path.join(TMP, 'aspect_tokens.png')
    fs.writeFileSync(file, png)

    const meta = await runImageMeta(file)
    expect(meta.aspectRatio).toBe('3:2')
    expect(meta.visualTokens).toBe(600)

    const output = await captureStdout(() => run(['node', 'token-goat', 'image-meta', file]))
    expect(output).toContain('3:2')
    expect(output).toContain('Visual Tokens: ~600')
  })
})

describe('sliceImage and image-slice CLI', () => {
  it('crops an image to exact sub-coordinates', async () => {
    // 200x200 canvas
    const imgBuffer = await sharp({
      create: { width: 200, height: 200, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
    }).png().toBuffer()
    const file = path.join(TMP, 'slice_source.png')
    fs.writeFileSync(file, imgBuffer)

    const slice = await sliceImage(file, { x: 50, y: 50, width: 80, height: 60 })
    expect(slice.originalWidth).toBe(200)
    expect(slice.originalHeight).toBe(200)
    expect(slice.cropX).toBe(50)
    expect(slice.cropY).toBe(50)
    expect(slice.cropWidth).toBe(80)
    expect(slice.cropHeight).toBe(60)
    expect(slice.format).toBe('png')

    const outFile = path.join(TMP, 'cropped_out.png')
    const cliOutput = await captureStdout(() =>
      run(['node', 'token-goat', 'image-slice', file, '-x', '50', '-y', '50', '-w', '80', '-h', '60', '--out', outFile]),
    )
    expect(cliOutput).toContain('Cropped region: 80x60 at (+50,+50)')
    expect(fs.existsSync(outFile)).toBe(true)

    const meta = await runImageMeta(outFile)
    expect(meta.width).toBe(80)
    expect(meta.height).toBe(60)
  })

  it('clamps coordinates safely when exceeding image bounds', async () => {
    const imgBuffer = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 255, b: 0 } },
    }).png().toBuffer()
    const file = path.join(TMP, 'clamp_test.png')
    fs.writeFileSync(file, imgBuffer)

    const slice = await sliceImage(file, { x: 80, y: 70, width: 50, height: 50 })
    expect(slice.cropX).toBe(80)
    expect(slice.cropY).toBe(70)
    expect(slice.cropWidth).toBe(20) // 100 - 80
    expect(slice.cropHeight).toBe(30) // 100 - 70
  })

  it('supports jpeg format conversion and quality', async () => {
    const imgBuffer = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 255 } },
    }).png().toBuffer()
    const file = path.join(TMP, 'jpeg_conv.png')
    fs.writeFileSync(file, imgBuffer)

    const slice = await sliceImage(file, { format: 'jpeg', quality: 75 })
    expect(slice.format).toBe('jpeg')
    expect(slice.cropWidth).toBe(100)
    expect(slice.cropHeight).toBe(100)
  })
})

describe('diffImages and image-diff CLI', () => {
  it('detects identical images with 0% diff', async () => {
    const img = await sharp({
      create: { width: 50, height: 50, channels: 3, background: { r: 50, g: 50, b: 50 } },
    }).png().toBuffer()
    const fileA = path.join(TMP, 'same_a.png')
    const fileB = path.join(TMP, 'same_b.png')
    fs.writeFileSync(fileA, img)
    fs.writeFileSync(fileB, img)

    const diff = await diffImages(fileA, fileB)
    expect(diff.identical).toBe(true)
    expect(diff.differentPixels).toBe(0)
    expect(diff.diffPercentage).toBe(0)
    expect(diff.boundingBox).toBeNull()

    const cliOutput = await captureStdout(() => run(['node', 'token-goat', 'image-diff', fileA, fileB]))
    expect(cliOutput).toContain('Status: IDENTICAL')
    expect(cliOutput).toContain('0 (0%)')
  })

  it('detects pixel differences and bounding box of changes', async () => {
    const base = await sharp({
      create: { width: 100, height: 100, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
    }).raw().toBuffer()

    const mod = Buffer.from(base)
    // Draw a small 20x10 black box from (30, 40) to (49, 49)
    for (let y = 40; y < 50; y++) {
      for (let x = 30; x < 50; x++) {
        const idx = (y * 100 + x) * 4
        mod[idx] = 0 // R
        mod[idx + 1] = 0 // G
        mod[idx + 2] = 0 // B
      }
    }

    const pngA = await sharp(base, { raw: { width: 100, height: 100, channels: 4 } }).png().toBuffer()
    const pngB = await sharp(mod, { raw: { width: 100, height: 100, channels: 4 } }).png().toBuffer()

    const fileA = path.join(TMP, 'box_a.png')
    const fileB = path.join(TMP, 'box_b.png')
    fs.writeFileSync(fileA, pngA)
    fs.writeFileSync(fileB, pngB)

    const diff = await diffImages(fileA, fileB)
    expect(diff.identical).toBe(false)
    expect(diff.differentPixels).toBe(200) // 20 * 10
    expect(diff.diffPercentage).toBe(2) // 200 / 10000 = 2%
    expect(diff.boundingBox).not.toBeNull()
    expect(diff.boundingBox?.minX).toBe(30)
    expect(diff.boundingBox?.maxX).toBe(49)
    expect(diff.boundingBox?.minY).toBe(40)
    expect(diff.boundingBox?.maxY).toBe(49)
    expect(diff.boundingBox?.width).toBe(20)
    expect(diff.boundingBox?.height).toBe(10)

    const cliOutput = await captureStdout(() => run(['node', 'token-goat', 'image-diff', fileA, fileB]))
    expect(cliOutput).toContain('Status: DIFFERENT')
    expect(cliOutput).toContain('200 (2%)')
    expect(cliOutput).toContain('Changed bounding box: 20x10 at (+30,+40) to (+49,+49)')
  })

  it('respects color tolerance', async () => {
    // 10x10 gray (100, 100, 100) vs (105, 105, 105)
    const imgA = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 100, g: 100, b: 100 } },
    }).png().toBuffer()
    const imgB = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 105, g: 105, b: 105 } },
    }).png().toBuffer()

    const fileA = path.join(TMP, 'tol_a.png')
    const fileB = path.join(TMP, 'tol_b.png')
    fs.writeFileSync(fileA, imgA)
    fs.writeFileSync(fileB, imgB)

    const diffStrict = await diffImages(fileA, fileB, { tolerance: 0 })
    expect(diffStrict.identical).toBe(false)

    const diffTolerant = await diffImages(fileA, fileB, { tolerance: 10 })
    expect(diffTolerant.identical).toBe(true)
  })
})
