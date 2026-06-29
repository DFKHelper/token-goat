import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs, getDb } from '../src/db.js'
import * as embeddings from '../src/embeddings.js'

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-emb-reindex-'))
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('embeddings.indexFile reindex replaces prior chunks', () => {
  // Regression: indexFile appended new chunks without removing the file's prior chunk rows, so reindexing a changed file accumulated stale chunks (and an emptied file kept all of them). The fix deletes the file's existing embeddings before inserting. upsertChunks no-ops when the embed model is unavailable (CI), so this asserts on the seeded stale marker's removal, which is independent of embed availability.
  it("removes a file's stale chunk rows before inserting (does not append)", async () => {
    const dbPath = path.join(TMP, 'index.db')
    const db = getDb(dbPath)
    // chunk_vectors is sqlite-vec's vec0 table when the optional dep is installed, else absent; CREATE TABLE IF NOT EXISTS is a no-op against the real vec0 table and a plain stand-in otherwise. The seed below binds a BigInt rowid and a 384-dim blob so it satisfies vec0's strict integer-PK and dimension rules while staying valid for the stand-in.
    db.exec('CREATE TABLE IF NOT EXISTS chunk_vectors (rowid INTEGER PRIMARY KEY, embedding BLOB)')

    const file = 'c:/proj/stale.ts'
    // Seed one stale chunk (as a prior index pass would have left) plus its vector row.
    const info = db
      .prepare('INSERT INTO chunks (file_path, start_line, end_line, text, kind) VALUES (?, ?, ?, ?, ?)')
      .run(file, 1, 1, 'STALE_MARKER', 'code')
    const staleId = Number(info.lastInsertRowid)
    db.prepare('INSERT INTO chunk_vectors (rowid, embedding) VALUES (?, ?)').run(BigInt(staleId), Buffer.alloc(384 * 4))

    // Reindex the same path with new content; the pre-insert delete must drop the stale rows.
    await embeddings.indexFile(db, file, 'export const fresh = 1\n')

    const chunkRows = db
      .prepare('SELECT COUNT(*) c FROM chunks WHERE file_path = ? AND text = ?')
      .get(file, 'STALE_MARKER') as { c: number }
    expect(chunkRows.c).toBe(0)
    const vecRows = db
      .prepare('SELECT COUNT(*) c FROM chunk_vectors WHERE rowid = ?')
      .get(staleId) as { c: number }
    expect(vecRows.c).toBe(0)
  })
})
