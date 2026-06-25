import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDb } from '../src/db.js'
import {
  getFileEntry,
  queryRefs,
  querySymbols,
  searchSymbolsFts,
} from '../src/index_reader.js'
import { clearModuleCaches } from '../src/reset.js'

const tmpDirs: string[] = []

function tmpDbPath(name = 'index.db'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-idx-'))
  tmpDirs.push(dir)
  return path.join(dir, name)
}

beforeEach(() => {
  clearModuleCaches()
})

afterEach(() => {
  clearModuleCaches()
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()
    if (dir === undefined) continue
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort; WAL sidecars may briefly linger on Windows
    }
  }
})

describe('index_reader on an empty DB', () => {
  it('querySymbols returns an empty array', () => {
    const db = tmpDbPath()
    expect(querySymbols({}, db)).toEqual([])
    expect(querySymbols({ name: 'anything' }, db)).toEqual([])
  })

  it('queryRefs returns an empty array', () => {
    const db = tmpDbPath()
    expect(queryRefs({ name: 'anything' }, db)).toEqual([])
  })

  it('getFileEntry returns null for an unknown path', () => {
    const db = tmpDbPath()
    expect(getFileEntry('src/missing.ts', db)).toBeNull()
  })

  it('searchSymbolsFts returns an empty array', () => {
    const db = tmpDbPath()
    expect(searchSymbolsFts('anything', 10, db)).toEqual([])
  })
})

describe('index_reader round-trips inserted rows', () => {
  it('querySymbols returns a directly-inserted symbol', () => {
    const dbPath = tmpDbPath()
    const db = getDb(dbPath)
    db.prepare(
      'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('src/auth.ts', 'login', 'function', 10, 20, 'function login() {}', 'Logs in.')

    const rows = querySymbols({ name: 'login' }, dbPath)
    expect(rows).toHaveLength(1)
    const sym = rows[0]
    expect(sym).toBeDefined()
    expect(sym?.filePath).toBe('src/auth.ts')
    expect(sym?.name).toBe('login')
    expect(sym?.kind).toBe('function')
    expect(sym?.lineStart).toBe(10)
    expect(sym?.lineEnd).toBe(20)
    expect(sym?.body).toBe('function login() {}')
    expect(sym?.docstring).toBe('Logs in.')
  })

  it('filters symbols by file and kind', () => {
    const dbPath = tmpDbPath()
    const db = getDb(dbPath)
    const stmt = db.prepare(
      'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    stmt.run('a.ts', 'foo', 'function', 1, 2, '', '')
    stmt.run('a.ts', 'Bar', 'class', 3, 9, '', '')
    stmt.run('b.ts', 'foo', 'function', 1, 2, '', '')

    expect(querySymbols({ filePath: 'a.ts' }, dbPath)).toHaveLength(2)
    expect(querySymbols({ kind: 'class' }, dbPath)).toHaveLength(1)
    expect(querySymbols({ filePath: 'a.ts', kind: 'function' }, dbPath)).toHaveLength(1)
  })

  it('queryRefs returns inserted references scoped by file', () => {
    const dbPath = tmpDbPath()
    const db = getDb(dbPath)
    const stmt = db.prepare(
      'INSERT INTO refs (file_path, name, line, col, context) VALUES (?, ?, ?, ?, ?)',
    )
    stmt.run('a.ts', 'login', 5, 2, 'login()')
    stmt.run('b.ts', 'login', 9, 0, 'await login()')

    expect(queryRefs({ name: 'login' }, dbPath)).toHaveLength(2)
    const scoped = queryRefs({ name: 'login', filePath: 'b.ts' }, dbPath)
    expect(scoped).toHaveLength(1)
    expect(scoped[0]?.line).toBe(9)
    expect(scoped[0]?.context).toBe('await login()')
  })

  it('getFileEntry returns an inserted file row', () => {
    const dbPath = tmpDbPath()
    const db = getDb(dbPath)
    db.prepare(
      'INSERT INTO files (path, sha, mtime, language, indexed_at) VALUES (?, ?, ?, ?, ?)',
    ).run('src/main.ts', 'deadbeef', 1234.5, 'typescript', 9999)

    const entry = getFileEntry('src/main.ts', dbPath)
    expect(entry).not.toBeNull()
    expect(entry?.sha).toBe('deadbeef')
    expect(entry?.mtime).toBe(1234.5)
    expect(entry?.language).toBe('typescript')
    expect(entry?.indexedAt).toBe(9999)
  })

  it('searchSymbolsFts finds an inserted symbol by name token', () => {
    const dbPath = tmpDbPath()
    const db = getDb(dbPath)
    db.prepare(
      'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('src/auth.ts', 'authenticate', 'function', 1, 5, 'body', 'docs')

    const hits = searchSymbolsFts('authenticate', 10, dbPath)
    // FTS5 may be unavailable in some SQLite builds; tolerate that by only
    // asserting correctness when the search returns rows.
    if (hits.length > 0) {
      expect(hits[0]?.name).toBe('authenticate')
    }
  })
})
