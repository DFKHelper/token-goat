/**
 * Regression coverage for the fixed 10,000-symbol cap in buildEmbeddingBoundaries
 * (src/parser.ts): a file with more than 10,000 symbols used to lose symbol-precise
 * embedding-chunk boundaries for everything past the 10,000th (ordered by line_start,
 * so a contiguous tail), silently folding that tail into one or more generic 'window'
 * chunks instead. Content was never dropped -- chunkFile's trailing-gap fallback still
 * covers every line through end-of-file -- but structural precision was lost for large
 * generated files (API clients, protobuf/OpenAPI output, big constants/fixtures files)
 * with no documented reason for the number and no parity with the sibling markdown
 * branch of the same function, which passes Infinity and documents why.
 *
 * This drives the real production write path for the `symbols` table (indexFileSync,
 * unmocked, real SQLite) and calls the real buildEmbeddingBoundaries (src/parser.ts,
 * exported for this test) directly, so a regression in the fix itself -- not a parallel
 * reimplementation of it -- is what red/green actually proves. It stops short of
 * running the model-backed indexFileEmbeddings at this scale (10,500+ texts through a
 * real ONNX embedding pass is impractically slow for a unit test and this repo's rule
 * is to never fetch the model in a test run); instead it relies on upsertChunks's own
 * 1:1 mapping (src/embeddings.ts::upsertChunks, chunkInsertStmt.run one row per chunk
 * in the array chunkFile returned, no filtering/aggregation beyond its two early-return
 * availability gates) to establish that chunkFile's returned Chunk[] IS exactly what
 * would land in the `chunks` table, row for row, once persisted. A separate, smaller
 * fixture in tests/embeddings_index_wiring.test.ts already proves that wiring is real
 * end to end (not a stubbed callback) at a scale well under this cap.
 *
 * Fixture provenance: HAND-DERIVED. Generated in this file by a loop emitting one
 * single-line `function fnN() { ... }` declaration per symbol, padded past the 50-char
 * MIN_CHUNK_CHARS floor so each stands as its own boundary range instead of folding
 * into a neighbor.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { closeAllDbs, getDb } from '../src/db.js'
import { buildEmbeddingBoundaries, indexFileSync } from '../src/parser.js'
import { chunkFile, type ChunkBoundary } from '../src/embeddings.js'
import { querySymbols } from '../src/index_reader.js'

// One more than the historical buildEmbeddingBoundaries cap of 10,000, so the fixture actually
// crosses the boundary this test exists to cover (2,000 symbols, this repo's own earlier sweep
// of the embeddings write side, was five times below it and could not have found this).
const CAP_UNDER_TEST = 10_000
const SYMBOL_COUNT = 10_500

function buildFixture(count: number): string {
  let out = ''
  for (let i = 0; i < count; i++) {
    // Each function is exactly one line, so symbol i (0-based) sits at file line i + 1 with no
    // gap to its neighbors. The trailing comment pads the line past MIN_CHUNK_CHARS (50 chars)
    // so chunkFile keeps each symbol as its own standalone range instead of folding a
    // too-short one into a neighbor -- a confound unrelated to the cap this test targets.
    out += `function fn${i}() { return ${i} } // padding to clear the min chunk floor\n`
  }
  return out
}

// Mirrors buildEmbeddingBoundaries's own non-markdown branch (src/parser.ts) exactly, at a
// caller-chosen limit, so the pre-fix (10,000) and post-fix (unbounded) behavior can both be
// exercised through the same real querySymbols + chunkFile call chain the private function uses.
function embeddingBoundariesAt(filePath: string, dbPath: string, limit: number): ChunkBoundary[] {
  const symbols = querySymbols({ filePath, limit }, dbPath)
  return symbols.map((s) => ({ start: s.lineStart, end: s.lineEnd, kind: 'symbol' as const }))
}

function chunkKindAtLine(chunks: { startLine: number; endLine: number; kind: string }[], line: number): string {
  const hit = chunks.find((c) => c.startLine <= line && line <= c.endLine)
  if (hit === undefined) throw new Error(`no chunk covers line ${line}`)
  return hit.kind
}

describe('buildEmbeddingBoundaries symbol cap (src/parser.ts)', () => {
  it('a file with more symbols than the query limit still has its symbols table fully populated (production indexFileSync, unaffected by the embedding-boundary cap)', () => {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-embed-cap-'))
    try {
      const dbPath = path.join(TMP, 'index.db')
      const filePath = path.join(TMP, 'huge.ts')
      fs.writeFileSync(filePath, buildFixture(SYMBOL_COUNT))

      indexFileSync(filePath, dbPath)

      const db = getDb(dbPath)
      const row = db.prepare('SELECT COUNT(*) c FROM symbols WHERE file_path = ?').get(filePath) as {
        c: number
      }
      expect(SYMBOL_COUNT).toBeGreaterThan(CAP_UNDER_TEST)
      expect(row.c).toBe(SYMBOL_COUNT)
    } finally {
      closeAllDbs()
      fs.rmSync(TMP, { recursive: true, force: true })
    }
  })

  it('an unbounded querySymbols call returns every symbol, in line order, so the cap does not silently drop a scattered subset', () => {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-embed-cap-'))
    try {
      const dbPath = path.join(TMP, 'index.db')
      const filePath = path.join(TMP, 'huge.ts')
      fs.writeFileSync(filePath, buildFixture(SYMBOL_COUNT))
      indexFileSync(filePath, dbPath)

      const unbounded = embeddingBoundariesAt(filePath, dbPath, Number.MAX_SAFE_INTEGER)
      expect(unbounded).toHaveLength(SYMBOL_COUNT)
      // querySymbols orders by (file_path, line_start): within one file a LIMIT therefore always
      // keeps a contiguous line-ordered prefix, never a scattered subset, whatever the limit is.
      for (let i = 1; i < unbounded.length; i++) {
        expect(unbounded[i]!.start).toBeGreaterThan(unbounded[i - 1]!.start)
      }
      expect(unbounded[0]!.start).toBe(1)
      expect(unbounded[unbounded.length - 1]!.start).toBe(SYMBOL_COUNT)
    } finally {
      closeAllDbs()
      fs.rmSync(TMP, { recursive: true, force: true })
    }
  })

  it('fixed: a symbol past the 10,000 cap still gets its own symbol-kind chunk, matching the markdown sibling which never capped at all', () => {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-embed-cap-'))
    try {
      const dbPath = path.join(TMP, 'index.db')
      const filePath = path.join(TMP, 'huge.ts')
      const content = buildFixture(SYMBOL_COUNT)
      fs.writeFileSync(filePath, content)
      indexFileSync(filePath, dbPath)

      // The real production function (src/parser.ts), exported for this test, not a parallel
      // reimplementation -- exercises the exact wiring indexFileEmbeddings drives in production.
      const boundaries = buildEmbeddingBoundaries(filePath, content, dbPath)
      const chunks = chunkFile(filePath, content, undefined, undefined, boundaries)

      // Positive control: an early symbol, always within any cap, must still resolve as its own
      // symbol-kind chunk. A fix that broke chunking entirely (e.g. returning one giant window
      // chunk) would otherwise still pass a bare "the tail is present" assertion.
      expect(chunkKindAtLine(chunks, 1)).toBe('symbol')

      // The defect line: fn10000 (0-based index 10000, file line 10001) sat just past the old
      // 10,000-row cap and used to land inside a generic 'window' fallback chunk instead of its
      // own symbol boundary. Fixed, it gets one like every other symbol in the file.
      expect(chunkKindAtLine(chunks, 10_001)).toBe('symbol')

      // The last symbol in the file, deep in what used to be the uncapped tail.
      expect(chunkKindAtLine(chunks, SYMBOL_COUNT)).toBe('symbol')

      // No content lost either way: every line of the file is covered by exactly one chunk, no
      // gaps. This holds pre-fix too (chunkFile's trailing-gap fallback already covered it) -- the
      // fix is about structural precision, not about data loss.
      const sorted = [...chunks].sort((a, b) => a.startLine - b.startLine)
      expect(sorted[0]!.startLine).toBe(1)
      expect(sorted[sorted.length - 1]!.endLine).toBe(SYMBOL_COUNT)
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i]!.startLine).toBe(sorted[i - 1]!.endLine + 1)
      }
    } finally {
      closeAllDbs()
      fs.rmSync(TMP, { recursive: true, force: true })
    }
  })

  it('pre-fix behavior for comparison: the old 10,000 cap folded the tail into a window chunk while still covering every line', () => {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-embed-cap-'))
    try {
      const dbPath = path.join(TMP, 'index.db')
      const filePath = path.join(TMP, 'huge.ts')
      const content = buildFixture(SYMBOL_COUNT)
      fs.writeFileSync(filePath, content)
      indexFileSync(filePath, dbPath)

      // Reproduces the exact pre-fix call: querySymbols({ filePath, limit: 10000 }, dbPath).
      const boundaries = embeddingBoundariesAt(filePath, dbPath, CAP_UNDER_TEST)
      expect(boundaries).toHaveLength(CAP_UNDER_TEST)
      const chunks = chunkFile(filePath, content, undefined, undefined, boundaries)

      // The symbol the fix targets: under the old cap it falls outside every symbol boundary and
      // gets folded into the trailing generic window chunk instead of its own.
      expect(chunkKindAtLine(chunks, 10_001)).toBe('window')
      // Still not lost -- the trailing-gap fallback in chunkFile covers it, just at coarser
      // (window, not symbol) granularity. This is why the pre-fix behavior was a precision bug,
      // not a data-loss bug.
      const sorted = [...chunks].sort((a, b) => a.startLine - b.startLine)
      expect(sorted[sorted.length - 1]!.endLine).toBe(SYMBOL_COUNT)
    } finally {
      closeAllDbs()
      fs.rmSync(TMP, { recursive: true, force: true })
    }
  })
})
