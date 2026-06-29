import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs, getDb } from '../src/db.js'
import { insertChunkVector, packVec } from '../src/embeddings.js'

type Vec0State = 'working' | 'broken' | 'absent'

// Classify sqlite-vec into three states so a real regression cannot hide behind a skip. 'absent': the optional package is not in node_modules, which is legitimate on a platform where the native build cannot install, so the round-trip skips. 'broken': the package IS installed but its vec0 extension fails to load - that is silent-dead semantic search exactly as before sqlite-vec was declared, a regression, so it must FAIL not skip. 'working': vec0 loads and answers vec_version().
function classifyVec0(): Vec0State {
  const req = createRequire(import.meta.url)
  try {
    req.resolve('sqlite-vec')
  } catch {
    return 'absent'
  }
  try {
    const sqliteVec = req('sqlite-vec') as { load: (db: unknown) => void }
    const Database = req('better-sqlite3') as new (p: string) => {
      prepare: (s: string) => { get: () => unknown }
      close: () => void
    }
    const probe = new Database(':memory:')
    sqliteVec.load(probe)
    probe.prepare('SELECT vec_version()').get()
    probe.close()
    return 'working'
  } catch {
    return 'broken'
  }
}

const vec0State = classifyVec0()

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-emb-vecins-'))
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('sqlite-vec vec0 extension loads when the package is installed', () => {
  // No silent degradation: if sqlite-vec is declared and present in node_modules but vec0 will not load, semantic search is silently dead exactly as it was before the dependency was declared. That is a regression, not a platform skip, so fail loudly. When the package is genuinely absent (an unsupported platform) this passes and the functional round-trip below skips instead.
  it('does not silently degrade to a non-loading vec0 when installed', () => {
    expect(vec0State).not.toBe('broken')
  })
})

describe('insertChunkVector + KNN round-trip on the real vec0 table', () => {
  // Regression: upsertChunks bound chunkResult.lastInsertRowid (a plain JS number) into chunk_vectors, but sqlite-vec's vec0 table declares rowid as a strict INTEGER PRIMARY KEY and rejects a number-bound value ("Only integers are allowed for primary key values"), so the first vector insert threw and the whole storeEmbeddings transaction rolled back - semantic indexing silently produced nothing. This never surfaced because the sqlite-vec dependency was undeclared (vec0 never loaded in production) and the embeddings tests seeded a plain stand-in table that accepts number rowids. insertChunkVector coerces the rowid to BigInt; this drives it against a genuine vec0 table and then runs the production MATCH/k query, so a regression in either the insert bind or the search path fails here.
  it.skipIf(vec0State !== 'working')(
    'stores a vector by real chunk rowid and finds it via the production MATCH/k query',
    () => {
      const dbPath = path.join(TMP, 'index.db')
      const db = getDb(dbPath)
      // getDb created chunk_vectors as a real vec0 virtual table because sqlite-vec loaded; own a rowid via a real chunk row, exactly as upsertChunks does.
      const info = db
        .prepare('INSERT INTO chunks (file_path, start_line, end_line, text, kind) VALUES (?, ?, ?, ?, ?)')
        .run('c:/proj/vec.ts', 1, 5, 'export const fresh = 1', 'code')
      const stmt = db.prepare('INSERT INTO chunk_vectors (rowid, embedding) VALUES (?, ?)')
      const embedding = Array.from({ length: 384 }, (_, i) => (i % 7) * 0.01)

      // Pre-fix this throws "Only integers are allowed for primary key values"; post-fix the BigInt coercion lets vec0 accept the row.
      insertChunkVector(stmt, info.lastInsertRowid, embedding)

      const stored = db
        .prepare('SELECT COUNT(*) c FROM chunk_vectors WHERE rowid = ?')
        .get(Number(info.lastInsertRowid)) as { c: number }
      expect(stored.c).toBe(1)

      // Production KNN path (the exact MATCH + k query searchSimilar runs): query with the same packed vector and assert the row returns as the nearest hit at ~0 distance, proving store -> search works end to end on the real vec0 table.
      const hit = db
        .prepare('SELECT rowid, distance FROM chunk_vectors WHERE embedding MATCH ? AND k = ? ORDER BY distance ASC')
        .get(packVec(embedding), 5) as { rowid: number | bigint; distance: number } | undefined
      expect(hit).toBeDefined()
      expect(Number(hit?.rowid)).toBe(Number(info.lastInsertRowid))
      expect(hit?.distance ?? 1).toBeLessThan(1e-3)
    },
  )
})
