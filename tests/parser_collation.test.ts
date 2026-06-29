import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as UtilModule from '../src/util.js'

// Toggle isCaseInsensitiveFs per test so the case-fold branch is exercised on every platform (CI Linux is case-sensitive; a real cross-casing reindex can't even be staged there). Other util exports are preserved — parser.js and db.js both import from this module.
vi.mock('../src/util.js', async (importOriginal) => {
  const actual = await importOriginal<typeof UtilModule>()
  return { ...actual, isCaseInsensitiveFs: vi.fn(() => true) }
})

const { deleteFileRows } = await import('../src/parser.js')
const { getDb, closeAllDbs } = await import('../src/db.js')
const { isCaseInsensitiveFs } = await import('../src/util.js')

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-collation-'))
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

/** Seed one symbol, ref, and files row under the given path casing. */
function seed(dbPath: string, p: string): void {
  const conn = getDb(dbPath)
  conn
    .prepare(
      'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(p, 'login', 'function', 1, 1, '', '')
  conn
    .prepare('INSERT INTO refs (file_path, name, line, col, context) VALUES (?, ?, ?, ?, ?)')
    .run(p, 'helper', 1, 1, 'driver')
  conn
    .prepare('INSERT INTO files (path, sha, mtime, language, indexed_at) VALUES (?, ?, ?, ?, ?)')
    .run(p, 'sha', 0, 'typescript', 0)
}

/** Count rows that still carry the exact (binary) path casing `p`. */
function survivors(dbPath: string, p: string): { symbols: number; refs: number; files: number } {
  const conn = getDb(dbPath)
  const n = (sql: string) => (conn.prepare(sql).get(p) as { c: number }).c
  return {
    symbols: n('SELECT COUNT(*) c FROM symbols WHERE file_path = ?'),
    refs: n('SELECT COUNT(*) c FROM refs WHERE file_path = ?'),
    files: n('SELECT COUNT(*) c FROM files WHERE path = ?'),
  }
}

describe('deleteFileRows path-collation handling', () => {
  it('case-insensitive FS: removes rows written under a different path casing', () => {
    vi.mocked(isCaseInsensitiveFs).mockReturnValue(true)
    const db = path.join(TMP, 'index.db')
    seed(db, 'c:/proj/Foo.ts') // walker casing
    deleteFileRows(getDb(db), 'c:/proj/foo.ts') // edit-queue casing

    // Without the COLLATE NOCASE fold these case-variant rows would survive and a NOCASE read would return them as duplicates of the freshly-indexed file.
    expect(survivors(db, 'c:/proj/Foo.ts')).toEqual({ symbols: 0, refs: 0, files: 0 })
  })

  it('case-sensitive FS: leaves rows for a path that differs only in case (a distinct file)', () => {
    vi.mocked(isCaseInsensitiveFs).mockReturnValue(false)
    const db = path.join(TMP, 'index.db')
    seed(db, 'c:/proj/Foo.ts')
    deleteFileRows(getDb(db), 'c:/proj/foo.ts')

    // On a case-sensitive filesystem Foo.ts and foo.ts are genuinely different files; folding case here would wrongly delete an unrelated file's rows.
    expect(survivors(db, 'c:/proj/Foo.ts')).toEqual({ symbols: 1, refs: 1, files: 1 })
  })
})
