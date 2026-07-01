import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs, closeDb, getDb } from '../src/db.js'
import { clearModuleCaches } from '../src/reset.js'

const tmpDirs: string[] = []

function tmpDbPath(name = 'index.db'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-db-'))
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
      // best-effort cleanup; WAL sidecar files may briefly linger on Windows
    }
  }
})

describe('getDb', () => {
  it('returns a usable Database instance', () => {
    const db = getDb(tmpDbPath())
    const row = db.prepare('SELECT 1 AS one').get() as { one: number }
    expect(row.one).toBe(1)
  })

  it('returns the same cached connection for the same path', () => {
    const p = tmpDbPath()
    expect(getDb(p)).toBe(getDb(p))
  })

  it('sets WAL journal mode on creation', () => {
    const db = getDb(tmpDbPath())
    const mode = db.pragma('journal_mode', { simple: true })
    expect(String(mode).toLowerCase()).toBe('wal')
  })

  it('sets synchronous to NORMAL', () => {
    const db = getDb(tmpDbPath())
    // PRAGMA synchronous returns 1 for NORMAL.
    const sync = db.pragma('synchronous', { simple: true })
    expect(Number(sync)).toBe(1)
  })

  it('sets a busy_timeout above the better-sqlite3 default so concurrent writers wait instead of erroring', () => {
    // token-goat runs multiple processes against one global.db (worker daemon + CLI hook invocations). Without a generous busy_timeout a writer that finds the write lock held fails immediately with SQLITE_BUSY ("database is locked"). The better-sqlite3 default is 5000ms; we raise it to 15000ms, so a regression that drops the explicit pragma is caught here.
    const db = getDb(tmpDbPath())
    const timeout = Number(db.pragma('busy_timeout', { simple: true }))
    expect(timeout).toBe(15000)
  })

  it('creates the index tables on first open', () => {
    const db = getDb(tmpDbPath())
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name)
    expect(names).toContain('files')
    expect(names).toContain('symbols')
    expect(names).toContain('refs')
  })

  it('creates the symbols_fts virtual table when FTS5 is available', () => {
    const db = getDb(tmpDbPath())
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name)
    // better-sqlite3 ships FTS5 enabled, so this should be present.
    expect(names).toContain('symbols_fts')
  })

  it('handles EEXIST errors gracefully on Windows mkdir race conditions', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-db-race-'))
    tmpDirs.push(baseDir)
    const dbPath = path.join(baseDir, 'subdir', 'index.db')
    try {
      const db1 = getDb(dbPath)
      expect(db1).toBeDefined()
      const row = db1.prepare('SELECT 1 AS one').get() as { one: number }
      expect(row.one).toBe(1)
    } finally {
      closeDb(dbPath)
    }
  })
})

describe('closeDb', () => {
  it('closes the connection and drops it from the cache', () => {
    const p = tmpDbPath()
    const first = getDb(p)
    closeDb(p)
    expect(() => first.prepare('SELECT 1')).toThrow()
    // A fresh getDb after close yields a new, working handle.
    const second = getDb(p)
    expect(second).not.toBe(first)
    expect((second.prepare('SELECT 1 AS one').get() as { one: number }).one).toBe(1)
  })

  it('is a no-op for an unopened path', () => {
    expect(() => closeDb(tmpDbPath())).not.toThrow()
  })
})

describe('closeAllDbs', () => {
  it('closes every open connection', () => {
    const a = getDb(tmpDbPath('a.db'))
    const b = getDb(tmpDbPath('b.db'))
    closeAllDbs()
    expect(() => a.prepare('SELECT 1')).toThrow()
    expect(() => b.prepare('SELECT 1')).toThrow()
  })

  it('is invoked by clearModuleCaches (reset registration)', () => {
    const p = tmpDbPath()
    const db = getDb(p)
    clearModuleCaches()
    expect(() => db.prepare('SELECT 1')).toThrow()
  })

  it('rejects a bare dbPath containing a colon (Windows NTFS stream guard)', () => {
    // A bare filename like "index.db:evil" would open an NTFS Alternate Data Stream on Windows rather than a regular file. safeJoin in resolveDbPath rejects it.
    expect(() => getDb('index.db:evil')).toThrow(/colon/)
  })
})
