/**
 * Built-bundle command matrix, shard 4 of 4 (pre-push / CI tier — slow). See
 * tests/command_matrix_e2e.1.test.ts for the full doc comment (fixture, coverage gate) and
 * tests/helpers/matrix_cases.ts for the shared fixture/case table this shard runs a slice of.
 * Also owns the built-bundle image-shrink/OCR-wiring regression tests below, which need the
 * same shared fixture (dataBase) but are not part of the sharded command case table.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import sharp from 'sharp'

import { afterEachHeartbeatMitigation, cases, cleanupMatrixFixture, dataBase, mkIsolated, run, setupMatrixFixture, shardKeys, tgEnv } from './helpers/matrix_cases.js'

beforeAll(setupMatrixFixture, 120000)
afterAll(cleanupMatrixFixture)
afterEach(afterEachHeartbeatMitigation)

describe('built bundle command matrix (shard 4/4)', () => {
  for (const name of shardKeys(3)) {
    it(`'${name}' produces correct output from the built bundle`, cases[name], 120000)
  }
})

describe('built bundle image shrink (real sharp dlopen through the full CLI import graph)', () => {
  // Regression test: embeddings.ts used to `require('@xenova/transformers')`
  // eagerly at module load time. index_prune.ts (reachable from every real CLI
  // invocation via cmdIndex) imports embeddings.ts, so every run of the built
  // bundle loaded @xenova/transformers — and transitively its own bundled
  // onnxruntime-node and a nested, differently-versioned copy of sharp's native
  // libvips binaries — before image_shrink.ts's own `import('sharp')` ever ran.
  // That poisoned the Windows DLL search order: the top-level sharp's dlopen
  // then failed with ERR_DLOPEN_FAILED, caught and silently swallowed as
  // "sharp unavailable" by loadSharp()'s catch block, so image shrinking was a
  // silent no-op in the shipped binary despite every image_shrink.test.ts case
  // passing (those import image_shrink.ts directly, never through the CLI's
  // full import graph, so @xenova/transformers was never loaded in-process).
  // This spawns the real dist/token-goat.mjs as a separate process and drives
  // it through the actual `hook pre_tool_use` dispatch path with a real
  // oversized image, asserting a genuine shrink happened — not just "no crash".
  it('shrinks an oversized image end-to-end through the built bundle', async () => {
    const side = 700 // 490,000px: comfortably under the default max_image_pixels cap
    const noise = Buffer.allocUnsafe(side * side * 3)
    for (let i = 0; i < noise.length; i++) noise[i] = Math.floor(Math.random() * 256)
    const jpegBuf = await sharp(noise, { raw: { width: side, height: side, channels: 3 } })
      .jpeg({ quality: 100 })
      .toBuffer()
    expect(jpegBuf.length).toBeGreaterThan(512 * 1024) // must clear image_shrink's own threshold

    const imgDir = mkIsolated('tg-matrix-img-')
    const imgPath = path.join(imgDir, 'big.jpg')
    fs.writeFileSync(imgPath, jpegBuf)

    const payload = JSON.stringify({
      tool_name: 'Read',
      tool_input: { file_path: imgPath },
      session_id: 'matrix-image-shrink',
    })
    // OCR is disabled here: this test's whole point is the sharp DLL-poisoning regression,
    // predating OCR entirely. Leaving OCR on would make the assertion depend on real
    // tesseract.js's confidence score for random noise (low, but not a contract) rather than
    // deterministically exercising the pixel-shrink path this test actually targets. OCR's
    // own built-bundle wiring gets its own smoke test below.
    const r = run(['hook', 'pre_tool_use'], {
      input: payload,
      env: { ...tgEnv(dataBase), TOKEN_GOAT_OCR_ENABLED: 'false' },
    })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).not.toContain('sharp unavailable')

    const out = JSON.parse(r.stdout) as {
      hookSpecificOutput?: { additionalContext?: string }
    }
    const context = out.hookSpecificOutput?.additionalContext ?? ''
    expect(context).toContain('smaller')
    expect(context).toMatch(/data:image\/(jpeg|webp);base64,/)
  }, 30000)

  // Regression coverage for the same class of bug the test above guards against, but for
  // OCR's dependency instead of sharp's: 'tesseract.js' must be in esbuild.config.mjs's
  // EXTERNAL_NATIVE_DEPS (see that file's comment) or esbuild would statically inline it into
  // dist/token-goat.mjs, defeating graceful degradation on installs that skip optional deps --
  // a bug that, like the sharp/DLL one above, would pass every image_ocr.test.ts/
  // image_shrink.test.ts case (they import image_ocr.ts/image_shrink.ts directly from src,
  // never through the built bundle) while being silently broken in the shipped binary. This
  // spawns the real dist/token-goat.mjs against a genuinely text-heavy generated image and
  // asserts only that the hook completes cleanly with SOME valid context output -- not that
  // OCR specifically wins over the pixel-shrink path, since a CI runner with no cached
  // eng.traineddata and no outbound network to fetch it is expected to fail open to the
  // shrink path per this feature's own "must fail open" contract, not fail the test.
  it('handles a text-heavy image end-to-end through the built bundle without crashing or hanging (OCR wiring smoke test)', async () => {
    // A dense multi-line "terminal output" SVG, comfortably under the 16M-pixel decode cap
    // (1400x900 = 1.26M) so it isn't rejected before OCR ever gets a chance to run, and
    // rendered with PNG compression disabled so the byte count clears image_shrink's 512KB
    // gate without needing extreme dimensions that would distort the text past legibility.
    const lines = Array.from(
      { length: 30 },
      (_, i) =>
        `<text x="20" y="${30 + i * 28}" font-family="monospace" font-size="22" fill="white">` +
        `line ${i}: npm run build succeeded, tests passed 214/214</text>`,
    ).join('')
    const svg = Buffer.from(`<svg width="1400" height="900" xmlns="http://www.w3.org/2000/svg">` + `<rect width="1400" height="900" fill="black"/>${lines}</svg>`)
    const textPng = await sharp(svg).png({ compressionLevel: 0 }).toBuffer()
    expect(textPng.length).toBeGreaterThan(512 * 1024)

    const imgDir = mkIsolated('tg-matrix-ocr-img-')
    const imgPath = path.join(imgDir, 'text.png')
    fs.writeFileSync(imgPath, textPng)

    const payload = JSON.stringify({
      tool_name: 'Read',
      tool_input: { file_path: imgPath },
      session_id: 'matrix-image-ocr',
    })
    const r = run(['hook', 'pre_tool_use'], { input: payload })
    expect(r.status, r.stderr).toBe(0)

    const out = JSON.parse(r.stdout) as {
      hookSpecificOutput?: { additionalContext?: string }
    }
    const context = out.hookSpecificOutput?.additionalContext ?? ''
    // Either path is acceptable (see comment above); a crash, a hang, or an empty/pass-through
    // response with neither marker is not.
    const gotOcrText = context.includes("OCR'd")
    const gotShrunkImage = /data:image\/(jpeg|webp);base64,/.test(context)
    expect(gotOcrText || gotShrunkImage, `unexpected context output: ${context.slice(0, 200)}`).toBe(true)
  }, 30000)
})
