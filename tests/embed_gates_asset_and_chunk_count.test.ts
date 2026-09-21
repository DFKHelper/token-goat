/**
 * `token-goat index` enumerates files with `git ls-files`, which returns every tracked file
 * regardless of language -- walkProject's `detectLanguageOfFile() !== 'unknown'` filter is on a
 * different path and never sees them. indexFileEmbeddings then had no check of its own between the
 * document-extraction branch (PDF/DOCX/PPTX/XLSX only) and a generic `decodeSource(readFile)`, so a
 * JPEG fell through to the generic read, decoded to mojibake without failing, and was chunked. On
 * one real machine-wide index that produced 39,477 chunk rows from 333 JPEGs, each carrying a
 * 384-dimensional vector.
 *
 * The second gate is the chunk-count ceiling. Byte size, the only ceiling that existed, does not
 * separate generated data from source: chunk cuts snap to structure, so the twenty worst files on
 * that same index were generated JSON snapshots comfortably under the 500 KB byte threshold, each
 * turning thousands of one-line keys into thousands of near-identical chunks.
 *
 * These drive the real default path -- indexFileSync then indexFileEmbeddings, exactly what
 * cmdIndex and worker.ts::makeIndexer each do per file -- rather than a mock callback.
 */
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs, getDb } from '../src/db.js'
import { assetEmbedSha, canonicalizeIndexPath, indexFileEmbeddings, indexFileSync, isEmbedFresh, maxChunksEmbedSha } from '../src/parser.js'
import { isAvailable, searchSemantic } from '../src/embeddings.js'
import { modelFilesPresent } from '../src/embed_model.js'
import { encodeJpeg } from '../src/image_engine.js'
import { fingerprintFile } from '../src/fingerprint.js'
import { getFileEntry } from '../src/index_reader.js'
import { NON_TEXT_ASSET_SET_ID } from '../src/asset_extensions.js'
import Database from '../src/sqlite_driver.js'

// Mirrors classifyVec0() in tests/embeddings_index_wiring.test.ts: 'absent' (package not installed) is a legitimate platform skip, 'broken' (installed but vec0 will not load) is silent-dead semantic search and must not be swallowed by one.
function vec0Working(): boolean {
  const req = createRequire(import.meta.url)
  try {
    req.resolve('sqlite-vec')
  } catch {
    return false
  }
  try {
    const sqliteVec = req('sqlite-vec') as { load: (db: unknown) => void }
    const probe = new Database(':memory:')
    sqliteVec.load(probe)
    probe.prepare('SELECT vec_version()').get()
    probe.close()
    return true
  } catch {
    return false
  }
}

const canExerciseRealEmbeddings = vec0Working() && isAvailable() && modelFilesPresent()

/**
 * PROVENANCE: CAPTURE -- real JPEG bytes, produced by the repository's own shipping JPEG encoder
 * (src/image_engine.ts::encodeJpeg), which is what token-goat writes to disk when it shrinks an
 * image. Not hand-written from the gate's own extension list: the point of the fixture is that the
 * bytes really are an encoded image, and the assertion below checks that those bytes, decoded as
 * UTF-8, would genuinely have produced chunkable text -- so the gate is what stops them, not an
 * accidentally-empty file.
 */
function realJpegBytes(): Buffer {
  const width = 96
  const height = 96
  const rgba = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      rgba[i] = (x * 7 + y * 3) % 256
      rgba[i + 1] = (x * 13) % 256
      rgba[i + 2] = (y * 17) % 256
      rgba[i + 3] = 255
    }
  }
  return encodeJpeg(width, height, rgba, 90)
}

/**
 * PROVENANCE: HAND-DERIVED -- a generated data snapshot in the shape the census found on a real
 * index (`memory/ads/kw-*-snap.json`): many short top-level keys, each holding a small record.
 * Sized here to clear the ceiling by construction, not copied from the producer under test.
 */
function snapshotJson(keys: number): string {
  const entries = Array.from({ length: keys }, (_, i) => `  "keyword_metric_row_${i}": { "clicks": ${i}, "impressions": ${i * 31}, "cost_micros": ${i * 1013}, "conversions": ${i % 7} }`)
  return `{\n${entries.join(',\n')}\n}\n`
}

let TMP: string
let prevEmbeddings: string | undefined

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-embed-gates-'))
  prevEmbeddings = process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
  if (prevEmbeddings === undefined) delete process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  else process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = prevEmbeddings
})

describe('indexFileEmbeddings refuses files with no embeddable text', () => {
  it('stamps an image as a skipped asset instead of embedding its decoded bytes, without needing the optional embedding deps', async () => {
    const dbPath = path.join(TMP, 'index.db')
    const jpegPath = path.join(TMP, 'photo.jpg')
    const bytes = realJpegBytes()
    fs.writeFileSync(jpegPath, bytes)

    // Calibration for the assertion below: these bytes really do decode into enough text to chunk, so a later "no chunks" result means the gate refused them rather than that there was nothing to refuse.
    expect(bytes.length).toBeGreaterThan(1000)
    expect(bytes.toString('utf8').trim().length).toBeGreaterThan(200)

    indexFileSync(jpegPath, dbPath)
    await indexFileEmbeddings(jpegPath, dbPath, fingerprintFile(jpegPath) ?? undefined)

    const db = getDb(dbPath)
    const chunks = db.prepare('SELECT COUNT(*) c FROM chunks WHERE file_path = ?').get(jpegPath) as { c: number }
    expect(chunks.c).toBe(0)

    const sha = fingerprintFile(jpegPath)
    expect(sha).not.toBeNull()
    expect(getFileEntry(jpegPath, dbPath)?.embedSha).toBe(assetEmbedSha(sha as string))
    // The stamp carries the extension set's identity, not a bare sha: a release that edits the set must re-examine what it skipped.
    expect(getFileEntry(jpegPath, dbPath)?.embedSha).toContain(NON_TEXT_ASSET_SET_ID)
  })

  it('stamps a file that would exceed indexing.max_chunks_per_file with the threshold it was refused under', async () => {
    const dbPath = path.join(TMP, 'index.db')
    const jsonPath = path.join(TMP, 'kw-snapshots.json')
    fs.writeFileSync(jsonPath, snapshotJson(900))

    indexFileSync(jsonPath, dbPath)
    await indexFileEmbeddings(jsonPath, dbPath, fingerprintFile(jsonPath) ?? undefined)

    const db = getDb(dbPath)
    const chunks = db.prepare('SELECT COUNT(*) c FROM chunks WHERE file_path = ?').get(jsonPath) as { c: number }
    expect(chunks.c).toBe(0)

    const sha = fingerprintFile(jsonPath) as string
    expect(getFileEntry(jsonPath, dbPath)?.embedSha).toBe(maxChunksEmbedSha(sha, 600))

    // The file is still fully indexed for symbols: the gate takes it out of `semantic`, never out of `symbol`/`read`/`refs`.
    // Queried by `canonicalizeIndexPath` rather than the raw `jsonPath`: symbol rows are keyed on the canonical spelling `indexFileSync` mints, so a literal `file_path = ?` against `jsonPath` matches nothing wherever the temp dir is reached through an alias.
    const symbols = db.prepare('SELECT COUNT(*) c FROM symbols WHERE file_path = ?').get(canonicalizeIndexPath(jsonPath)) as { c: number }
    expect(symbols.c).toBeGreaterThan(600)
  })

  it('keeps embedding a file just under the ceiling, so the gate is a ceiling and not a blanket refusal of the file type', async () => {
    const dbPath = path.join(TMP, 'index.db')
    const jsonPath = path.join(TMP, 'small-snapshot.json')
    fs.writeFileSync(jsonPath, snapshotJson(20))

    indexFileSync(jsonPath, dbPath)
    await indexFileEmbeddings(jsonPath, dbPath, fingerprintFile(jsonPath) ?? undefined)

    const sha = fingerprintFile(jsonPath) as string
    const embedSha = getFileEntry(jsonPath, dbPath)?.embedSha
    expect(embedSha).not.toContain('maxchunks:')
    expect(embedSha).not.toContain('asset:')
    expect(embedSha).toContain(sha)
  })

  it.skipIf(!canExerciseRealEmbeddings)('writes no chunk row for an image or an oversized snapshot while a normal source file in the same tree still embeds and still resolves through semantic', async () => {
    const dbPath = path.join(TMP, 'index.db')
    const jpegPath = path.join(TMP, 'photo.jpg')
    const jsonPath = path.join(TMP, 'kw-snapshots.json')
    const tsPath = path.join(TMP, 'widget.ts')
    fs.writeFileSync(jpegPath, realJpegBytes())
    fs.writeFileSync(jsonPath, snapshotJson(900))
    fs.writeFileSync(tsPath, 'export function reconcileInventoryLedger(sku: string): number {\n  // Reconciles the warehouse stock ledger against shipped orders for one product.\n  return sku.length\n}\n')

    for (const file of [jpegPath, jsonPath, tsPath]) {
      indexFileSync(file, dbPath)
      await indexFileEmbeddings(file, dbPath, fingerprintFile(file) ?? undefined)
    }

    const db = getDb(dbPath)
    // Canonicalized inside the helper: chunk rows are keyed on the spelling `indexFileEmbeddings` mints, so binding a raw native path would return 0 for every file and the two `toBe(0)` assertions below would pass without the gate they are testing doing anything.
    const countFor = (p: string): number => (db.prepare('SELECT COUNT(*) c FROM chunks WHERE file_path = ?').get(canonicalizeIndexPath(p)) as { c: number }).c
    expect(countFor(jpegPath)).toBe(0)
    expect(countFor(jsonPath)).toBe(0)
    expect(countFor(tsPath)).toBeGreaterThan(0)
    // Nothing else leaked in either: the whole index is exactly the source file's chunks.
    expect((db.prepare('SELECT COUNT(*) c FROM chunks').get() as { c: number }).c).toBe(countFor(tsPath))

    const hits = await searchSemantic(db, 'warehouse stock ledger reconciliation', 5)
    // A hit's `filePath` is read back out of the canonically-keyed chunks table, so it is the canonical spelling and not the native one this test wrote.
    expect(hits.map((h) => h.filePath)).toContain(canonicalizeIndexPath(tsPath))
  })
})

describe('the freshness gate reads the two new markers', () => {
  it('treats an asset stamp as fresh, and stops treating it as fresh once the extension set moves', () => {
    const sha = 'a'.repeat(40)
    expect(isEmbedFresh(assetEmbedSha(sha), sha, true, true, 500, 600)).toBe(true)
    // A stamp taken under a different set id -- what every existing asset stamp becomes the moment a release edits NON_TEXT_ASSET_EXTENSIONS -- must be re-examined, not skipped forever.
    expect(isEmbedFresh(`asset:deadbeef:${sha}`, sha, true, true, 500, 600)).toBe(false)
  })

  it('treats a chunk-ceiling stamp as fresh only while the ceiling is still what it was stamped under, so raising the setting re-embeds what it just admitted', () => {
    const sha = 'b'.repeat(40)
    expect(isEmbedFresh(maxChunksEmbedSha(sha, 600), sha, true, true, 500, 600)).toBe(true)
    expect(isEmbedFresh(maxChunksEmbedSha(sha, 600), sha, true, true, 500, 5000)).toBe(false)
    // 0 is the partially-mocked-config fallback both call sites pass: it must match no marker rather than every one.
    expect(isEmbedFresh(maxChunksEmbedSha(sha, 600), sha, true, true, 500, 0)).toBe(false)
  })
})
