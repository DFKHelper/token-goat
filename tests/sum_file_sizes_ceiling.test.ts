/**
 * Regression: sumFileSizes (src/read_commands.ts) summed real on-disk file sizes with no
 * ceiling, feeding recordReadStat's "the agent would have otherwise read this whole file"
 * counterfactual. For a huge file that is false and unbounded -- measured on a real index,
 * five sqlite-query invocations against a 940MB global.db claimed 1.6GB/410.5Mt of savings,
 * 16.7% of the entire all-time ledger from five events. Fix: clamp each file's contribution
 * to SUM_FILE_SIZES_PER_FILE_CEILING (100_000 bytes) before summing.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { runSymbol } from '../src/read_commands.js'
import { summarize } from '../src/stats.js'

const CEILING = 100_000

describe('sumFileSizes per-file ceiling', () => {
  it('caps a huge file contribution to the ceiling instead of its full real size', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-sumfilesizes-big-'))
    try {
      const file = join(root, 'big.ts')
      // Pad well past the ceiling with a comment, then a small real symbol.
      const padding = '// ' + 'x'.repeat(200_000) + '\n'
      writeFileSync(file, padding + 'export function sumFileSizesBigFn9k2() {\n  return 1\n}\n')
      indexFileSync(normalizePath(file))

      const before = summarize(30).by_kind['symbol_lookup']
      const beforeBytes = before?.bytes_saved ?? 0

      const { code } = runSymbol({ name: 'sumFileSizesBigFn9k2' })
      expect(code).toBe(0)

      const after = summarize(30).by_kind['symbol_lookup']
      const delta = (after?.bytes_saved ?? 0) - beforeBytes

      // bytesSaved = fullSourceBytes - emittedBytes, so delta must be well under the real
      // file size (~200KB) and bounded near the ceiling (allow small emitted-text slack).
      expect(delta).toBeLessThanOrEqual(CEILING)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves an under-ceiling file contribution exactly at its real size', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-sumfilesizes-small-'))
    try {
      const file = join(root, 'small.ts')
      const src = 'export function sumFileSizesSmallFn9k2() {\n  return 1\n}\n'
      writeFileSync(file, src)
      indexFileSync(normalizePath(file))

      const before = summarize(30).by_kind['symbol_lookup']
      const beforeBytes = before?.bytes_saved ?? 0

      const { code, text } = runSymbol({ name: 'sumFileSizesSmallFn9k2' })
      expect(code).toBe(0)

      const after = summarize(30).by_kind['symbol_lookup']
      const delta = (after?.bytes_saved ?? 0) - beforeBytes

      const emittedBytes = Buffer.byteLength(text ?? '', 'utf8')
      const expected = Math.max(1, src.length - emittedBytes)
      expect(delta).toBe(expected)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('still sums across multiple files, each independently capped', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-sumfilesizes-multi-'))
    try {
      const fileA = join(root, 'multiA.ts')
      const fileB = join(root, 'multiB.ts')
      const paddingA = '// ' + 'a'.repeat(150_000) + '\n'
      const paddingB = '// ' + 'b'.repeat(150_000) + '\n'
      writeFileSync(fileA, paddingA + 'export function sumFileSizesMultiA9k2() {\n  return 1\n}\n')
      writeFileSync(fileB, paddingB + 'export function sumFileSizesMultiA9k2() {\n  return 2\n}\n')
      indexFileSync(normalizePath(fileA))
      indexFileSync(normalizePath(fileB))

      const before = summarize(30).by_kind['symbol_lookup']
      const beforeBytes = before?.bytes_saved ?? 0

      const { code } = runSymbol({ name: 'sumFileSizesMultiA9k2' })
      expect(code).toBe(0)

      const after = summarize(30).by_kind['symbol_lookup']
      const delta = (after?.bytes_saved ?? 0) - beforeBytes

      // Both files match and are each capped at CEILING, so the sum should exceed a single
      // file's cap (proving accumulation across files still works) while staying well under
      // the real combined size of the two ~150KB files.
      expect(delta).toBeGreaterThan(CEILING)
      expect(delta).toBeLessThanOrEqual(2 * CEILING)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
