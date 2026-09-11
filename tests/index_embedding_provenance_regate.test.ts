/**
 * Regression: `token-goat index` must notice that the embedding stack changed under the vectors
 * already in the index.
 *
 * `files.embed_sha` records WHICH CONTENT was embedded, never WHICH STACK embedded it. The stack's
 * identity lives in the `embedding_provenance` row, and `ensureEmbeddingProvenance` is the only
 * thing that compares it and discards vectors that no longer match. Its only callers were
 * `upsertChunks` and `searchSemantic`, both of which sit downstream of the per-file freshness gate
 * in `cmdIndex` (and in the worker's `makeIndexer`). So after an onnxruntime major.minor upgrade --
 * a runtime input change that needs no edit to this repo at all -- a whole-index run read every
 * bare `embed_sha` as fresh, printed "Skipped N unchanged file(s)", and left every vector from the
 * previous stack in place. The warning that stack change prints tells the user to "Run
 * `token-goat index` to rebuild them", and that command did nothing.
 *
 * Driven through the REAL `cmdIndex`, the shipping path for the CLI `index` command, with no
 * injected index callback: `tests/embeddings_provenance.test.ts` already calls
 * `ensureEmbeddingProvenance` directly, which is exactly the injected-seam trap CLAUDE.md names --
 * it supplies the call the shipping path omitted, so it stayed green while the index path was dead.
 *
 * The embedding backend is the one thing stubbed (`setPipelineFnForTesting`, the same seam
 * `tests/embed_oversize_threshold_regate.test.ts` uses): it is not what this test is about, and
 * leaving it real would fetch a model over the network.
 */
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_DIM, embeddingProvenance, isAvailable, setPipelineFnForTesting } from '../src/embeddings.js'
import { cmdIndex } from '../src/cli.js'
import { closeAllDbs, getDb } from '../src/db.js'
import { drainOnce, pendingEmbeddings } from '../src/worker.js'
import { normalizePath } from '../src/paths.js'

// HAND-DERIVED: three one-line exported functions, long enough to produce at least one chunk and
// far under any size threshold. Computed from the chunker's minimum, not read off its output.
const SOURCE =
  Array.from({ length: 40 }, (_, i) => `export function provenanceRegateFn${i}(): number { return ${i} }`).join('\n') +
  '\n'

// A chunk row that only the previous stack could have written. Its survival is the whole assertion:
// nothing in the re-embed path would ever produce this text.
const OLD_STACK_CHUNK_TEXT = 'vectors written by the previous embedding stack'

// Same three-state classification tests/embeddings_vec_insert.test.ts uses, for the same reason:
// 'absent' is a legitimate platform outcome and skips, 'broken' would be silent-dead semantic
// search and must fail rather than hide.
function classifyVec0(): 'working' | 'broken' | 'absent' {
  const req = createRequire(import.meta.url)
  try {
    req.resolve('sqlite-vec')
  } catch {
    return 'absent'
  }
  try {
    const sqliteVec = req('sqlite-vec') as { load: (db: unknown) => void }
    const probe = new Database(':memory:')
    sqliteVec.load(probe)
    probe.prepare('SELECT vec_version()').get()
    probe.close()
    return 'working'
  } catch {
    return 'broken'
  }
}

const canExerciseRealEmbed = classifyVec0() === 'working' && isAvailable()

let TMP: string
let dbPath: string
let prevEmbeddingsEnv: string | undefined

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-prov-regate-'))
  dbPath = path.join(TMP, 'index.db')
  prevEmbeddingsEnv = process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  // The suite forces embeddings off (tests/setup/isolate-home.ts); the gate under test only runs
  // with them on, because the disabled branch short-circuits above it.
  process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
  setPipelineFnForTesting(
    (async () => async (text: string) => ({
      data: Float32Array.from({ length: DEFAULT_DIM }, (_, i) => ((text.length + i) % 17) / 1700),
    })) as never,
  )
})

afterEach(() => {
  setPipelineFnForTesting(null)
  if (prevEmbeddingsEnv === undefined) {
    delete process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  } else {
    process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = prevEmbeddingsEnv
  }
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('token-goat index re-embeds after the embedding stack changes', () => {
  it.skipIf(!canExerciseRealEmbed)(
    'discards vectors stamped by a previous stack instead of reading every file as fresh',
    async () => {
      const src = path.join(TMP, 'provenance_regate.ts')
      fs.writeFileSync(src, SOURCE, 'utf8')

      await cmdIndex(TMP, { walk: true, dbPath })

      const db = getDb(dbPath)
      const chunkCount = db.prepare('SELECT COUNT(*) AS c FROM chunks').get() as { c: number }
      // The real embed path ran, so what follows is a stack change under live vectors rather than
      // a freshness check over an empty index.
      expect(chunkCount.c).toBeGreaterThan(0)

      // The stack changes: an onnxruntime major.minor upgrade leaves exactly this state behind --
      // the stored provenance names a stack that is no longer the running one, and every vector in
      // the index came from it.
      db.prepare('UPDATE embedding_provenance SET provenance = ? WHERE id = 1').run(
        'Xenova/bge-small-en-v1.5@ea104dacec62/onnxruntime-node@0.0',
      )
      const filePath = db.prepare('SELECT file_path FROM chunks LIMIT 1').pluck().get() as string
      db.prepare('INSERT INTO chunks (file_path, start_line, end_line, text, kind) VALUES (?, ?, ?, ?, ?)').run(
        filePath,
        1,
        1,
        OLD_STACK_CHUNK_TEXT,
        'window',
      )
      closeAllDbs()

      // The user does what the stack-change warning tells them to do. Content is untouched, so
      // every per-file content gate still says "unchanged".
      await cmdIndex(TMP, { walk: true, dbPath })

      const after = getDb(dbPath)
      const survivors = after
        .prepare('SELECT COUNT(*) AS c FROM chunks WHERE text = ?')
        .get(OLD_STACK_CHUNK_TEXT) as { c: number }
      // Pre-fix this was 1: the run skipped every file, so nothing ever compared the provenance.
      expect(survivors.c).toBe(0)
      // Re-embedded, not merely emptied -- a wipe with no rebuild would also satisfy the line above.
      const rebuilt = after.prepare('SELECT COUNT(*) AS c FROM chunks').get() as { c: number }
      expect(rebuilt.c).toBeGreaterThan(0)
      const stored = after.prepare('SELECT provenance FROM embedding_provenance WHERE id = 1').pluck().get()
      expect(stored).toBe(embeddingProvenance())
    },
  )

  it.skipIf(!canExerciseRealEmbed)(
    'holds for the background worker drain too, on its real default indexer',
    async () => {
      // drainOnce with no injected index callback, so makeIndexer's shipping default runs -- the
      // second of the two places that consulted embed_sha without ever checking the stack.
      fs.mkdirSync(path.join(TMP, 'queue'), { recursive: true })
      const workerDb = path.join(TMP, 'global.db')
      const src = normalizePath(path.join(TMP, 'worker_provenance_regate.ts'))
      fs.writeFileSync(src, SOURCE, 'utf8')
      fs.writeFileSync(path.join(TMP, 'queue', 'dirty.txt'), `${src}\n`)

      expect(drainOnce(TMP)).toBe(1)
      await pendingEmbeddings()

      const db = getDb(workerDb)
      expect((db.prepare('SELECT COUNT(*) AS c FROM chunks').get() as { c: number }).c).toBeGreaterThan(0)
      db.prepare('UPDATE embedding_provenance SET provenance = ? WHERE id = 1').run(
        'Xenova/bge-small-en-v1.5@ea104dacec62/onnxruntime-node@0.0',
      )
      const filePath = db.prepare('SELECT file_path FROM chunks LIMIT 1').pluck().get() as string
      db.prepare('INSERT INTO chunks (file_path, start_line, end_line, text, kind) VALUES (?, ?, ?, ?, ?)').run(
        filePath,
        1,
        1,
        OLD_STACK_CHUNK_TEXT,
        'window',
      )

      // The daemon restarts, which is what actually happens when the inference runtime is upgraded
      // under it: the provenance check is memoized per database per process, and correctly so,
      // since a running process's own stack cannot change beneath it.
      closeAllDbs()

      // The file is touched again with its content untouched: every per-file content gate still
      // says "unchanged", which is the state the stale stack hid behind.
      fs.writeFileSync(path.join(TMP, 'queue', 'dirty.txt'), `${src}\n`)
      drainOnce(TMP)
      await pendingEmbeddings()

      const after = getDb(workerDb)
      const survivors = after
        .prepare('SELECT COUNT(*) AS c FROM chunks WHERE text = ?')
        .get(OLD_STACK_CHUNK_TEXT) as { c: number }
      expect(survivors.c).toBe(0)
      expect((after.prepare('SELECT COUNT(*) AS c FROM chunks').get() as { c: number }).c).toBeGreaterThan(0)
      expect(after.prepare('SELECT provenance FROM embedding_provenance WHERE id = 1').pluck().get()).toBe(
        embeddingProvenance(),
      )
    },
  )
})
