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
const { pathEqClause } = await import('../src/sql_path.js')

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

  // Correctness, not just perf: a plain mixed-ASCII-case input must still resolve through
  // pathEqClause's TG_LOWER()-backed branch after the expression-index fix below -- this locks
  // in the everyday case (not just the non-ASCII edge case above) alongside the index-usage
  // assertion.
  it('case-insensitive FS: matches a path differing only by ASCII casing (Foo.ts vs foo.ts)', () => {
    const db = path.join(TMP, 'index.db')
    seed(db, 'c:/proj/Foo.ts') // walker casing
    deleteFileEmbeddings(getDb(db), 'c:/proj/foo.ts') // edit-queue casing, different ASCII case
    expect(chunkCount(db, 'c:/proj/Foo.ts')).toBe(0)
  })
})

describe('pathEqClause query plan (full table scan fix)', () => {
  // Regression: TG_LOWER() is a custom SQL function, so a plain column index cannot satisfy a
  // `TG_LOWER(column) = ?` WHERE clause -- every pathEqClause()-built query used to be a full
  // table SCAN on the case-insensitive-filesystem branch, regardless of table size. db.ts adds
  // an expression index (`CREATE INDEX ... ON chunks(TG_LOWER(file_path))`) that SQLite matches
  // against pathEqClause's exact output text. Build the clause the same way every real caller
  // does (parser.ts, embeddings.ts, index_reader.ts) and confirm via EXPLAIN QUERY PLAN that the
  // resulting SQL uses SEARCH, not SCAN -- this is the assertion that locks the perf fix in so
  // it cannot silently regress back to a full scan.
  it('a query built from pathEqClause uses SEARCH (not SCAN), not a full table scan', () => {
    const db = getDb(path.join(TMP, 'plan.db'))
    const clause = pathEqClause('file_path')
    expect(clause).toBe('TG_LOWER(file_path) = ?')

    const plan = db
      .prepare(`EXPLAIN QUERY PLAN SELECT * FROM chunks WHERE ${clause}`)
      .all('c:/proj/foo.ts') as Array<{ detail: string }>
    const detail = plan.map((row) => row.detail).join(' | ')
    expect(detail).toMatch(/SEARCH/)
    expect(detail).not.toMatch(/SCAN/)
  })

  it('case-sensitive FS: pathEqClause builds a plain raw-column comparison, already covered by the ordinary column index', () => {
    vi.mocked(isCaseInsensitiveFs).mockReturnValue(false)
    expect(pathEqClause('file_path')).toBe('file_path = ?')
  })
})
