import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as UtilModule from '../src/util.js'

// Force the case-insensitive-FS branch on every platform (CI Linux is case-sensitive), same
// pattern as embeddings_collation.test.ts. deleteFileEmbeddings folds the query param via
// foldPath() and reads the pathEqClause() SQL clause internally, so mocking isCaseInsensitiveFs
// exercises pathEqClause's TG_LOWER()-backed branch end-to-end.
vi.mock('../src/util.js', async (importOriginal) => {
  const actual = await importOriginal<typeof UtilModule>()
  return { ...actual, isCaseInsensitiveFs: vi.fn(() => true) }
})

const { deleteFileEmbeddings } = await import('../src/embeddings.js')
const { getDb, closeAllDbs } = await import('../src/db.js')
const { isCaseInsensitiveFs } = await import('../src/util.js')

let TMP: string

beforeEach(() => {
  vi.mocked(isCaseInsensitiveFs).mockReturnValue(true)
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-sql-path-'))
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

function seed(dbPath: string, p: string): void {
  const db = getDb(dbPath)
  db.exec('CREATE TABLE IF NOT EXISTS chunk_vectors (rowid INTEGER PRIMARY KEY, embedding BLOB)')
  db.prepare('INSERT INTO chunks (file_path, start_line, end_line, text, kind) VALUES (?, ?, ?, ?, ?)').run(
    p,
    1,
    1,
    'X',
    'code',
  )
}

function chunkCount(dbPath: string, p: string): number {
  return (getDb(dbPath).prepare('SELECT COUNT(*) c FROM chunks WHERE file_path = ?').get(p) as { c: number }).c
}

describe('pathEqClause non-ASCII case folding (TG_LOWER)', () => {
  // Sanity check that this pair actually exercises the gap: SQLite's built-in LOWER() only
  // folds ASCII A-Z, so LOWER('Ä') stays 'Ä' (not 'ä') in a default build. If this assertion
  // ever starts failing, the codepoint pair below no longer proves anything and needs swapping.
  it('confirms the vanilla SQL LOWER() function does NOT fold Ä to ä (the gap being closed)', () => {
    const db = getDb(path.join(TMP, 'lower-check.db'))
    const row = db.prepare('SELECT LOWER(?) v').get('Ä') as { v: string }
    expect(row.v).not.toBe('ä')
  })

  it('case-insensitive FS: matches a path differing only by non-ASCII casing (Ä vs ä)', () => {
    const db = path.join(TMP, 'index.db')
    seed(db, 'c:/proj/Ätest.ts') // walker casing
    deleteFileEmbeddings(getDb(db), 'c:/proj/ätest.ts') // edit-queue casing, different non-ASCII case

    // A LOWER()-based pathEqClause (the pre-fix bug) folds only ASCII, so 'Ätest.ts' stays
    // 'Ätest.ts' while the JS-side foldPath() param is already 'ätest.ts' -- they never match
    // and the row survives. TG_LOWER() folds both sides identically, so it must be gone.
    expect(chunkCount(db, 'c:/proj/Ätest.ts')).toBe(0)
  })
})
