/** A -wal file must not stay at its peak size once its log has been folded back. Found on a real global.db: a 5.0 GB -wal beside a 5.0 GB database of which only 704 frames were live, left by a whole-database VACUUM whose truncating checkpoint a concurrent reader refused. Both tests drive the production paths (getDb's connection set-up, the worker's idleReclaim) and wait on no clock: every step is a statement that has returned. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs, getDb, WAL_SIZE_LIMIT_BYTES } from '../src/db.js'
import { clearModuleCaches } from '../src/reset.js'
import Database from '../src/sqlite_driver.js'
import { idleReclaim } from '../src/worker.js'

const tmpDirs: string[] = []

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-walsize-'))
  tmpDirs.push(dir)
  return path.join(dir, 'global.db')
}

function walBytes(dbPath: string): number {
  try {
    return fs.statSync(`${dbPath}-wal`).size
  } catch {
    return 0
  }
}

/** The schema cookie, which VACUUM raises by one (it rebuilds the file and writes the cookie back incremented) and nothing else in these tests touches, so it says whether a vacuum ran. */
function schemaCookie(db: ReturnType<typeof getDb>): number {
  return Number(db.pragma('schema_version', { simple: true }))
}

beforeEach(() => {
  clearModuleCaches()
})

afterEach(() => {
  closeAllDbs()
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

describe('the -wal file after a one-off large write', () => {
  it('is cut back to the size limit once the reader that pinned it has gone and the log restarts', () => {
    const dbPath = tmpDbPath()
    const db = getDb(dbPath)
    db.exec('CREATE TABLE payload (id INTEGER PRIMARY KEY, body BLOB)')

    // A second connection holding a read snapshot: the checkpoint cannot fold frames written after it began, which is what a refused truncating checkpoint leaves behind.
    const reader = new Database(dbPath)
    reader.exec('BEGIN')
    reader.prepare('SELECT count(*) AS c FROM payload').get()

    const rows = Math.ceil(WAL_SIZE_LIMIT_BYTES / (1024 * 1024)) + 16
    db.transaction(() => {
      const insert = db.prepare('INSERT INTO payload (body) VALUES (zeroblob(1048576))')
      for (let i = 0; i < rows; i++) insert.run()
    }).immediate()
    expect(walBytes(dbPath)).toBeGreaterThan(WAL_SIZE_LIMIT_BYTES)

    reader.exec('COMMIT')
    reader.close()

    // The first commit after the reader leaves runs the automatic checkpoint that folds the old log; the next write is the one that restarts the log, and that restart is where SQLite applies journal_size_limit.
    db.prepare('INSERT INTO payload (body) VALUES (zeroblob(16))').run()
    db.prepare('INSERT INTO payload (body) VALUES (zeroblob(16))').run()

    expect(walBytes(dbPath)).toBeLessThanOrEqual(WAL_SIZE_LIMIT_BYTES)
  })
})

describe('idleReclaim', () => {
  function filledDb(dbPath: string, deleteShare: number): ReturnType<typeof getDb> {
    const db = getDb(dbPath)
    db.exec('CREATE TABLE payload (id INTEGER PRIMARY KEY, body BLOB)')
    db.transaction(() => {
      const insert = db.prepare('INSERT INTO payload (body) VALUES (zeroblob(65536))')
      for (let i = 0; i < 40; i++) insert.run()
    }).immediate()
    if (deleteShare > 0) db.prepare('DELETE FROM payload WHERE id <= ?').run(Math.floor(40 * deleteShare))
    return db
  }

  it('leaves a database with no free pages alone, so the idle pass does not rewrite it through the log', () => {
    const dbPath = tmpDbPath()
    const db = filledDb(dbPath, 0)
    const before = schemaCookie(db)

    expect(idleReclaim(dbPath)).toBe(true)

    expect(schemaCookie(db)).toBe(before)
  })

  it('vacuums a database whose free pages are a large share of the file', () => {
    const dbPath = tmpDbPath()
    const db = filledDb(dbPath, 0.75)
    const before = schemaCookie(db)
    const pagesBefore = Number(db.pragma('page_count', { simple: true }))

    expect(idleReclaim(dbPath)).toBe(true)

    expect(schemaCookie(db)).toBe(before + 1)
    expect(Number(db.pragma('page_count', { simple: true }))).toBeLessThan(pagesBefore)
  })

  it('reports a missing database as not yet done, so the next cycle tries again', () => {
    expect(idleReclaim(tmpDbPath())).toBe(false)
  })
})
