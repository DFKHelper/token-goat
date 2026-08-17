import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs, getDb } from '../src/db.js'
import { deleteFileEmbeddings } from '../src/embeddings.js'

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-emb-vecplan-'))
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

// chunk_vectors is sqlite-vec's vec0 table when the optional dep is installed; CREATE TABLE IF NOT EXISTS is a no-op against the real vec0 table and creates a plain stand-in otherwise, so these tests run on every platform.
function ensureChunkVectors(db: ReturnType<typeof getDb>): void {
  db.prepare('CREATE TABLE IF NOT EXISTS chunk_vectors (rowid INTEGER PRIMARY KEY, embedding BLOB)').run()
}

// Record every SQL string handed to prepare() while still returning the real statement. The shape of the chunk_vectors DELETE is the thing under test, and it is not observable from the resulting rows -- a subquery and a point delete remove exactly the same vectors.
function recordingDb(db: ReturnType<typeof getDb>): { db: ReturnType<typeof getDb>; sql: string[] } {
  const sql: string[] = []
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (text: string) => {
          sql.push(text)
          return target.prepare(text)
        }
      }
      return Reflect.get(target, prop, receiver) as unknown
    },
  })
  return { db: proxy as ReturnType<typeof getDb>, sql }
}

describe('deleteFileEmbeddings deletes vectors by rowid, never by subquery', () => {
  // Regression: the vector delete used `WHERE rowid IN (SELECT id FROM chunks WHERE ...)`. chunk_vectors is a vec0 virtual table whose xBestIndex only recognises an equality constraint on rowid -- a subquery is opaque to it, so SQLite planned `SCAN chunk_vectors` and walked every vector in the whole index once per file reindexed. Nothing failed and no row count changed; reindexing just got linearly slower as the index grew (152ms versus 23ms for 60 files against a 16k-vector index). Only the statement shape distinguishes the two, so that is what this asserts.
  it('issues a point delete per id rather than one subquery delete', () => {
    const real = getDb(path.join(TMP, 'index.db'))
    ensureChunkVectors(real)
    const insert = real.prepare('INSERT INTO chunks (file_path, start_line, end_line, text, kind) VALUES (?, ?, ?, ?, ?)')
    for (let i = 0; i < 3; i++) insert.run('c:/proj/a.ts', i, i + 1, 'x', 'code')

    const { db, sql } = recordingDb(real)
    deleteFileEmbeddings(db, 'c:/proj/a.ts')

    const vectorDeletes = sql.filter((s) => /DELETE\s+FROM\s+chunk_vectors/i.test(s))
    expect(vectorDeletes).toHaveLength(1)
    expect(vectorDeletes[0]).toMatch(/WHERE\s+rowid\s*=\s*\?/i)
    expect(vectorDeletes[0]).not.toMatch(/SELECT/i)
  })

  // Anti-vacuity: the assertion above would also hold if the vector delete were dropped entirely, so pin that the vectors really do go.
  it('still removes exactly the target file\'s vector rows', () => {
    const db = getDb(path.join(TMP, 'index.db'))
    ensureChunkVectors(db)
    const insert = db.prepare('INSERT INTO chunks (file_path, start_line, end_line, text, kind) VALUES (?, ?, ?, ?, ?)')
    const insertVector = db.prepare('INSERT INTO chunk_vectors (rowid, embedding) VALUES (?, ?)')
    const seeded: Record<string, number[]> = { 'c:/proj/a.ts': [], 'c:/proj/b.ts': [] }
    for (const f of Object.keys(seeded)) {
      for (let i = 0; i < 2; i++) {
        const info = insert.run(f, i, i + 1, 'x', 'code')
        insertVector.run(BigInt(info.lastInsertRowid), Buffer.alloc(384 * 4))
        seeded[f]!.push(Number(info.lastInsertRowid))
      }
    }

    deleteFileEmbeddings(db, 'c:/proj/a.ts')

    const left = db.prepare('SELECT rowid FROM chunk_vectors ORDER BY rowid').pluck().all().map(Number)
    expect(left).toEqual(seeded['c:/proj/b.ts'])
  })
})
