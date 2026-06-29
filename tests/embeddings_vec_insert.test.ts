import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs, getDb } from '../src/db.js'
import { insertChunkVector } from '../src/embeddings.js'

// Detect whether sqlite-vec's vec0 extension actually loads here. It is an optional dependency: present on dev machines and the Windows pre-push gate, absent on platforms where the native build cannot install. The regression below only has meaning against a real vec0 table (a plain stand-in accepts a number rowid and hides the bug), so skip cleanly when vec0 is unavailable rather than asserting against a stand-in.
function detectVec0(): boolean {
  try {
    const req = createRequire(import.meta.url)
    const sqliteVec = req('sqlite-vec') as { load: (db: unknown) => void }
    const Database = req('better-sqlite3') as new (p: string) => { prepare: (s: string) => { get: () => unknown }; close: () => void }
    const probe = new Database(':memory:')
    sqliteVec.load(probe)
    probe.prepare('SELECT vec_version()').get()
    probe.close()
    return true
  } catch {
    return false
  }
}

const vec0Available = detectVec0()

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-emb-vecins-'))
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('insertChunkVector binds the rowid for the real vec0 chunk_vectors table', () => {
  // Regression: upsertChunks bound chunkResult.lastInsertRowid (a plain JS number) into chunk_vectors, but sqlite-vec's vec0 table declares rowid as a strict INTEGER PRIMARY KEY and rejects a number-bound value ("Only integers are allowed for primary key values"), so the first vector insert threw and the whole storeEmbeddings transaction rolled back - semantic indexing silently produced nothing. This never surfaced because the only sqlite-vec dependency was undeclared (so vec0 never loaded in production) and the embeddings tests seeded a plain stand-in table that accepts number rowids. insertChunkVector coerces the rowid to BigInt; this drives it against a genuine vec0 table so a regression to a number bind fails here.
  it.skipIf(!vec0Available)(
    'inserts a vector keyed by a real chunk rowid into the strict integer-PK vec0 table',
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

      const row = db
        .prepare('SELECT COUNT(*) c FROM chunk_vectors WHERE rowid = ?')
        .get(Number(info.lastInsertRowid)) as { c: number }
      expect(row.c).toBe(1)
    },
  )
})
