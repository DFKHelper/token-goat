import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as UtilModule from '../src/util.js'

// Toggle isCaseInsensitiveFs per test so the case-fold branch runs on every platform (CI Linux is case-sensitive). deleteFileEmbeddings folds path case via sql_path.pathEqClause, which reads this util export; mocking the export reaches the helper cross-module.
vi.mock('../src/util.js', async (importOriginal) => {
  const actual = await importOriginal<typeof UtilModule>()
  return { ...actual, isCaseInsensitiveFs: vi.fn(() => true) }
})

const { deleteFileEmbeddings } = await import('../src/embeddings.js')
const { getDb, closeAllDbs } = await import('../src/db.js')
const { isCaseInsensitiveFs } = await import('../src/util.js')

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-emb-collation-'))
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

// Seed one chunk row (under casing `p`) plus its vector row. chunk_vectors is sqlite-vec's vec0 table when the optional dep is installed, else a plain stand-in; the insert binds a BigInt rowid and a 384-dim blob so it satisfies vec0's strict integer-PK and dimension rules while staying valid for the stand-in.
function seed(dbPath: string, p: string): void {
  const db = getDb(dbPath)
  db.exec('CREATE TABLE IF NOT EXISTS chunk_vectors (rowid INTEGER PRIMARY KEY, embedding BLOB)')
  const info = db
    .prepare('INSERT INTO chunks (file_path, start_line, end_line, text, kind) VALUES (?, ?, ?, ?, ?)')
    .run(p, 1, 1, 'X', 'code')
  db.prepare('INSERT INTO chunk_vectors (rowid, embedding) VALUES (?, ?)').run(BigInt(info.lastInsertRowid), Buffer.alloc(384 * 4))
}

function chunkCount(dbPath: string, p: string): number {
  return (getDb(dbPath).prepare('SELECT COUNT(*) c FROM chunks WHERE file_path = ?').get(p) as { c: number }).c
}

describe('deleteFileEmbeddings path-collation handling', () => {
  it('case-insensitive FS: removes chunks written under a different path casing', () => {
    vi.mocked(isCaseInsensitiveFs).mockReturnValue(true)
    const db = path.join(TMP, 'index.db')
    seed(db, 'c:/proj/Foo.ts') // walker casing
    deleteFileEmbeddings(getDb(db), 'c:/proj/foo.ts') // edit-queue casing

    // Without the COLLATE NOCASE fold the case-variant row survives while a fresh index adds a duplicate alongside it.
    expect(chunkCount(db, 'c:/proj/Foo.ts')).toBe(0)
  })

  it('case-sensitive FS: leaves chunks for a path that differs only in case (a distinct file)', () => {
    vi.mocked(isCaseInsensitiveFs).mockReturnValue(false)
    const db = path.join(TMP, 'index.db')
    seed(db, 'c:/proj/Foo.ts')
    deleteFileEmbeddings(getDb(db), 'c:/proj/foo.ts')

    // On a case-sensitive filesystem Foo.ts and foo.ts are genuinely different files; folding case would wrongly delete an unrelated file's rows.
    expect(chunkCount(db, 'c:/proj/Foo.ts')).toBe(1)
  })
})
