/**
 * `indexing.max_chunks_per_file` used to be checked at exactly one place: the character-budget cut
 * (`chunkFile(...).length`) taken in parser.ts just before `embedIndexFile`. But embeddings.ts's
 * `indexFile` throws that cut away and re-cuts with the model's own tokenizer whenever
 * `embeddingsDepsAvailable(db)` is true, and the token cut is strictly finer (it flushes on a token
 * budget as well as a char one). So a file could clear the ceiling on the coarse count and still
 * store several times the ceiling in `chunks` rows. The `isEmbeddableDocument` branch returned
 * before ever reaching that gate, so documents were embedded with no ceiling at all.
 *
 * Every test in tests/embed_gates_asset_and_chunk_count.test.ts runs with
 * `embeddingsDepsAvailable === false`, which is precisely the branch where the token re-cut does not
 * execute, and its over-cap fixture blows the ceiling on the char count -- so the gate there fires
 * before the re-cut could ever matter. These tests therefore run only with real embeddings present
 * and assert, in the body, that the char cut did NOT exceed the cap, so a zero-chunk result can only
 * mean the post-embed enforcement caught what actually landed.
 *
 * PROVENANCE: CAPTURE for every figure below. The fixture sizes and the expected chunk counts were
 * measured by running the real pipeline (`indexFileSync` -> `indexFileEmbeddings` with the real
 * all-MiniLM-L6-v2 tokenizer) against these exact fixtures and reading `SELECT COUNT(*) FROM chunks`
 * off the resulting SQLite index, before any assertion here was written: prose(80) -> char cut 4,
 * stored 9; prose(20) -> char cut 1, stored 3; the 100-paragraph .docx -> char cut 4, stored 12.
 * Nothing here is read off the cap's own source. The .docx bytes come from
 * tests/helpers/ooxml_fixtures.ts::buildDocxFixture, whose own provenance line is FORMAT-DERIVED
 * from ECMA-376, and they are passed through the shipping extractor
 * (src/doc_embed_extract.ts::extractEmbeddableDocumentText) rather than hand-decoded here.
 */

import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs, getDb } from '../src/db.js'
import { buildEmbeddingBoundaries, indexFileEmbeddings, indexFileSync, maxChunksEmbedSha } from '../src/parser.js'
import { chunkFile, embeddingsDepsAvailable, isAvailable } from '../src/embeddings.js'
import { extractEmbeddableDocumentText, isEmbeddableDocument } from '../src/doc_embed_extract.js'
import { modelFilesPresent } from '../src/embed_model.js'
import { fingerprintFile } from '../src/fingerprint.js'
import { getFileEntry } from '../src/index_reader.js'
import { configPath } from '../src/constants.js'
import { loadConfig } from '../src/config.js'
import { buildDocxFixture } from './helpers/ooxml_fixtures.js'
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

// The ceiling this file installs. Chosen so the char cut of every over-cap fixture sits comfortably below it while the token cut sits comfortably above -- see the measured figures in the header.
const CAP = 6

// PROVENANCE: HAND-DERIVED shape -- ordinary English prose, one sentence per line, with a varying index so no two lines are identical (identical lines would let a deduplicating chunker collapse them and change the counts for a reason unrelated to the cap). Deliberately contains no markdown headings and no parseable symbols, so buildEmbeddingBoundaries returns an empty boundary list and chunkFile falls back to its plain sliding window -- the same cut embeddings.ts then re-does with the tokenizer.
function prose(paragraphs: number): string {
  const lines: string[] = []
  for (let i = 0; i < paragraphs; i++) {
    lines.push(
      `Paragraph ${i}: the indexer walks the project tree and extracts symbols, references and section headings from every tracked source file, then hands the resulting spans to the chunker so that each stored vector covers one coherent region of code rather than an arbitrary window of characters number ${i}.`,
    )
  }
  return lines.join('\n')
}

function storedChunkCount(dbPath: string): number {
  return (getDb(dbPath).prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n
}

let TMP: string
let prevEmbeddings: string | undefined
let prevConfigText: string | null

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-stored-chunk-cap-'))
  prevEmbeddings = process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
  // loadConfig keys its cache on a content hash of this file, so writing it is enough to invalidate; the assertion in each test confirms the value really took effect rather than assuming it. TOKEN_GOAT_HOME is isolated for the run by tests/setup/isolate-home.ts, so this is not a real ~/.token-goat, but it IS shared with other test files in the same run -- hence the restore in afterEach.
  const p = configPath()
  prevConfigText = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, `[indexing]\nmax_chunks_per_file = ${CAP}\n`)
})

afterEach(() => {
  closeAllDbs()
  const p = configPath()
  if (prevConfigText === null) fs.rmSync(p, { force: true })
  else fs.writeFileSync(p, prevConfigText)
  fs.rmSync(TMP, { recursive: true, force: true })
  if (prevEmbeddings === undefined) delete process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  else process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = prevEmbeddings
})

describe('max_chunks_per_file is enforced against the rows that were actually stored', () => {
  it.skipIf(!canExerciseRealEmbeddings)(
    'drops a file whose token re-cut exceeds the cap even though its char cut cleared it',
    async () => {
      expect(loadConfig().indexing.max_chunks_per_file).toBe(CAP)

      const dbPath = path.join(TMP, 'index.db')
      const filePath = path.join(TMP, 'notes.txt')
      const content = prose(80)
      fs.writeFileSync(filePath, content)
      indexFileSync(filePath, dbPath)
      const db = getDb(dbPath)

      // Calibration 1: the token re-cut only runs on this branch, and it is the branch the existing coverage never enters. Without this the test would silently degrade into a duplicate of the deps-absent tests.
      expect(embeddingsDepsAvailable(db)).toBe(true)

      // Calibration 2: the cheap pre-count gate in parser.ts measures exactly this and must NOT reject the file, or the zero-chunk result below would prove nothing about the post-embed enforcement.
      const boundaries = buildEmbeddingBoundaries(filePath, content, dbPath)
      const charCut = chunkFile(filePath, content, undefined, undefined, boundaries).length
      expect(charCut).toBe(4)
      expect(charCut).toBeLessThanOrEqual(CAP)

      const sha = fingerprintFile(filePath) ?? undefined
      expect(sha).toBeTypeOf('string')
      await indexFileEmbeddings(filePath, dbPath, sha)

      // The token cut stores 9 rows for this fixture, 3 over the cap, so every one of them must be gone and the file must carry the threshold-bearing marker that records why.
      expect(storedChunkCount(dbPath)).toBe(0)
      expect(getFileEntry(filePath, dbPath)?.embedSha).toBe(maxChunksEmbedSha(sha as string, CAP))
    },
    120_000,
  )

  it.skipIf(!canExerciseRealEmbeddings)(
    'drops an embeddable document whose stored chunks exceed the cap, a branch that never reached the pre-count gate at all',
    async () => {
      expect(loadConfig().indexing.max_chunks_per_file).toBe(CAP)

      const dbPath = path.join(TMP, 'index.db')
      const filePath = path.join(TMP, 'report.docx')
      const paragraphs = Array.from({ length: 100 }, (_, i) => ({
        text: `Paragraph ${i}: the indexer walks the project tree and extracts symbols, references and section headings from every tracked source file, then hands the resulting spans to the chunker so that each stored vector covers one coherent region of prose rather than an arbitrary window of characters number ${i}.`,
      }))
      fs.writeFileSync(filePath, buildDocxFixture(paragraphs))
      expect(isEmbeddableDocument(filePath)).toBe(true)

      indexFileSync(filePath, dbPath)
      const db = getDb(dbPath)
      expect(embeddingsDepsAvailable(db)).toBe(true)

      // The document branch embeds the EXTRACTED text with an empty boundary list. Same calibration as above, measured the same way the source branch would have measured it: even the coarse count this branch never took would have waved the file through.
      const extracted = await extractEmbeddableDocumentText(filePath)
      expect(typeof extracted).toBe('string')
      const charCut = chunkFile(filePath, extracted as string, undefined, undefined, []).length
      expect(charCut).toBe(4)
      expect(charCut).toBeLessThanOrEqual(CAP)

      const sha = fingerprintFile(filePath) ?? undefined
      expect(sha).toBeTypeOf('string')
      await indexFileEmbeddings(filePath, dbPath, sha)

      // Measured at 12 stored rows before this enforcement existed, twice the cap.
      expect(storedChunkCount(dbPath)).toBe(0)
      expect(getFileEntry(filePath, dbPath)?.embedSha).toBe(maxChunksEmbedSha(sha as string, CAP))
    },
    120_000,
  )

  it.skipIf(!canExerciseRealEmbeddings)(
    'still embeds a file that is under the cap on both cuts, so the enforcement is a ceiling and not a blanket refusal',
    async () => {
      expect(loadConfig().indexing.max_chunks_per_file).toBe(CAP)

      const dbPath = path.join(TMP, 'index.db')
      const filePath = path.join(TMP, 'notes.txt')
      const content = prose(20)
      fs.writeFileSync(filePath, content)
      indexFileSync(filePath, dbPath)
      const db = getDb(dbPath)
      expect(embeddingsDepsAvailable(db)).toBe(true)

      const boundaries = buildEmbeddingBoundaries(filePath, content, dbPath)
      expect(chunkFile(filePath, content, undefined, undefined, boundaries).length).toBe(1)

      const sha = fingerprintFile(filePath) ?? undefined
      await indexFileEmbeddings(filePath, dbPath, sha)

      // The token cut stored 3 rows here when measured, under the cap, so they survive and the file is stamped with the bare sha rather than the max-chunks marker. Asserted as a non-empty count within the cap rather than as the literal 3: the enforcement guarantees the bound, not the tokenizer's exact output, and pinning the exact number would fail this test for a model or MAX_CHUNK_TOKENS change that has nothing to do with the ceiling.
      const stored = storedChunkCount(dbPath)
      expect(stored).toBeGreaterThan(0)
      expect(stored).toBeLessThanOrEqual(CAP)
      expect(getFileEntry(filePath, dbPath)?.embedSha).toBe(sha)
    },
    120_000,
  )
})
