import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs, getDb } from '../src/db.js'
import { deleteFileEmbeddings } from '../src/embeddings.js'

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-emb-varlim-'))
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

// chunk_vectors is sqlite-vec's vec0 table when the optional dep is installed; CREATE TABLE IF NOT EXISTS is a no-op against the real vec0 table and creates a plain stand-in otherwise, so these tests run on every platform. The variable-limit bug lives in the chunk_vectors DELETE's bound-parameter count and reproduces against either table shape.
function ensureChunkVectors(db: ReturnType<typeof getDb>): void {
  db.prepare('CREATE TABLE IF NOT EXISTS chunk_vectors (rowid INTEGER PRIMARY KEY, embedding BLOB)').run()
}

describe('deleteFileEmbeddings does not overflow the SQL bound-parameter limit', () => {
  // Regression: the old body expanded `DELETE FROM chunk_vectors WHERE rowid IN (?, ?, ...)` to one parameter per chunk id, so a file with > SQLITE_MAX_VARIABLE_NUMBER (32766) chunks threw "too many SQL variables". The current body deletes one rowid per statement, so it binds a single id at a time. Seed 32767 chunk rows (one over the limit) for one file and assert the delete neither throws nor leaves chunks behind.
  it('deletes a file whose chunk count exceeds 32766 without throwing', () => {
    const db = getDb(path.join(TMP, 'index.db'))
    ensureChunkVectors(db)
    const N = 32767
    const insert = db.prepare('INSERT INTO chunks (file_path, start_line, end_line, text, kind) VALUES (?, ?, ?, ?, ?)')
    const seed = db.transaction(() => {
      for (let i = 0; i < N; i++) insert.run('c:/proj/huge.ts', i, i + 1, 'x', 'code')
    })
    seed()
    expect(() => deleteFileEmbeddings(db, 'c:/proj/huge.ts')).not.toThrow()
    const left = db.prepare('SELECT COUNT(*) c FROM chunks WHERE file_path = ?').get('c:/proj/huge.ts') as { c: number }
    expect(left.c).toBe(0)
  })

  // The delete must remove exactly the target file's chunks and leave every other file's chunks intact.
  it('removes only the target file\'s chunks, leaving other files untouched', () => {
    const db = getDb(path.join(TMP, 'index.db'))
    ensureChunkVectors(db)
    const insert = db.prepare('INSERT INTO chunks (file_path, start_line, end_line, text, kind) VALUES (?, ?, ?, ?, ?)')
    for (const f of ['c:/proj/a.ts', 'c:/proj/b.ts', 'c:/proj/c.ts']) {
      insert.run(f, 1, 2, 'x', 'code')
      insert.run(f, 3, 4, 'y', 'code')
    }
    deleteFileEmbeddings(db, 'c:/proj/b.ts')
    const b = db.prepare('SELECT COUNT(*) c FROM chunks WHERE file_path = ?').get('c:/proj/b.ts') as { c: number }
    const a = db.prepare('SELECT COUNT(*) c FROM chunks WHERE file_path = ?').get('c:/proj/a.ts') as { c: number }
    const c = db.prepare('SELECT COUNT(*) c FROM chunks WHERE file_path = ?').get('c:/proj/c.ts') as { c: number }
    expect(b.c).toBe(0)
    expect(a.c).toBe(2)
    expect(c.c).toBe(2)
  })
})
