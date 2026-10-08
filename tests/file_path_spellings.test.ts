/** fileRowByIndexKey and filePathSpellingsClause: the one place a caller's spelling of a path is turned into the spellings an index may hold it under. Not every writer stored a forward-slash path, so a lookup that tries one spelling misses rows the others wrote. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeDb, getDb } from '../src/db.js'
import { filePathSpellingsClause, fileRowByIndexKey } from '../src/sql_path.js'

let dir: string
let dbPath: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-spellings-'))
  dbPath = path.join(dir, 'spellings.db')
})

afterEach(() => {
  closeDb(dbPath)
  fs.rmSync(dir, { recursive: true, force: true })
})

// HAND-DERIVED: the rows are written the way an older or foreign writer stored them (a backslash path), which is the case the second spelling exists for.
const SLASH = '/proj/src/a.ts'
const BACKSLASH = '\\proj\\src\\b.ts'

function seed(): void {
  const db = getDb(dbPath)
  for (const p of [SLASH, BACKSLASH]) {
    db.prepare('INSERT INTO files (path, sha, mtime) VALUES (?, ?, ?)').run(p, `sha-${p.length}`, 1)
    db.prepare('INSERT INTO symbols (file_path, name, kind, line_start, line_end) VALUES (?, ?, ?, ?, ?)').run(p, `sym${p.length}`, 'function', 1, 2)
  }
}

describe('fileRowByIndexKey', () => {
  it('finds a row stored under the forward-slash spelling', () => {
    seed()
    expect(fileRowByIndexKey<{ path: string }>(getDb(dbPath), '/proj/src/a.ts', 'path')?.path).toBe(SLASH)
  })

  it('finds a row stored under the other separator when the forward-slash spelling misses', () => {
    seed()
    expect(fileRowByIndexKey<{ path: string }>(getDb(dbPath), '/proj/src/b.ts', 'path')?.path).toBe(BACKSLASH)
  })

  it('returns only the requested columns', () => {
    seed()
    const row = fileRowByIndexKey<{ path: string; sha: string }>(getDb(dbPath), '/proj/src/a.ts', 'path, sha')
    expect(row).toEqual({ path: SLASH, sha: `sha-${SLASH.length}` })
  })

  it('is undefined for a path nobody indexed', () => {
    seed()
    expect(fileRowByIndexKey(getDb(dbPath), '/proj/src/none.ts', 'path')).toBeUndefined()
  })
})

describe('filePathSpellingsClause', () => {
  function symbolsOf(file: string): string[] {
    const { clause, params } = filePathSpellingsClause('file_path', file)
    return (getDb(dbPath).prepare(`SELECT name FROM symbols WHERE ${clause}`).all(...params) as Array<{ name: string }>).map((r) => r.name)
  }

  it('matches symbols stored under either separator', () => {
    seed()
    expect(symbolsOf('/proj/src/a.ts')).toEqual([`sym${SLASH.length}`])
    expect(symbolsOf('/proj/src/b.ts')).toEqual([`sym${BACKSLASH.length}`])
  })

  it('binds one parameter for a bare name and two for a path with a separator', () => {
    expect(filePathSpellingsClause('file_path', 'a.ts').params).toHaveLength(1)
    expect(filePathSpellingsClause('file_path', '/proj/a.ts').params).toHaveLength(2)
  })
})
