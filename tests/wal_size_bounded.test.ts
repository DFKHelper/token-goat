/** A -wal file must not stay at its peak size once its log has been folded back. Found on a real global.db: a 5.0 GB -wal beside a 5.0 GB database of which only 704 frames were live, left by a whole-database VACUUM whose truncating checkpoint a concurrent reader refused. The tests drive the production paths (getDb's connection set-up, the per-call telemetry connection in stats.ts, the worker's idleReclaim) and wait on no clock: every step is a statement that has returned. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeAllDbs, getDb, WAL_SIZE_LIMIT_BYTES } from '../src/db.js'
import { clearModuleCaches } from '../src/reset.js'
import Database from '../src/sqlite_driver.js'
import type { SqliteDatabase } from '../src/sqlite_driver.js'
import type * as DbModule from '../src/db.js'
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

/** Run `body` with a second connection holding an open read snapshot of `dbPath`, the state in which a truncating checkpoint is refused. The reader is closed on every path; a close failure is reported unless the body already failed, whose error is the one worth seeing. */
function withPinningReader(dbPath: string, body: (reader: SqliteDatabase) => void): void {
  const reader = new Database(dbPath)
  let failure: { error: unknown } | undefined
  try {
    reader.exec('BEGIN')
    reader.prepare('SELECT count(*) AS c FROM payload').get()
    body(reader)
  } catch (error) {
    failure = { error }
  }
  try {
    reader.close()
  } catch (closeError) {
    failure ??= { error: closeError }
  }
  if (failure !== undefined) throw failure.error
}

/** Grow the log past WAL_SIZE_LIMIT_BYTES on `db` while a reader pins it, release the reader, and return the -wal size after the two writes that fold the old log and restart it. */
function growPinnedLogThenRelease(db: SqliteDatabase, dbPath: string): { grown: number; settled: number } {
  db.exec('CREATE TABLE payload (id INTEGER PRIMARY KEY, body BLOB)')
  const rows = Math.ceil(WAL_SIZE_LIMIT_BYTES / (1024 * 1024)) + 16
  let grown = 0
  withPinningReader(dbPath, (reader) => {
    db.transaction(() => {
      const insert = db.prepare('INSERT INTO payload (body) VALUES (zeroblob(1048576))')
      for (let i = 0; i < rows; i++) insert.run()
    }).immediate()
    grown = walBytes(dbPath)
    reader.exec('COMMIT')
  })
  // The first commit after the reader leaves runs the automatic checkpoint that folds the old log; the next write is the one that restarts the log, and that restart is where SQLite applies journal_size_limit.
  db.prepare('INSERT INTO payload (body) VALUES (zeroblob(16))').run()
  db.prepare('INSERT INTO payload (body) VALUES (zeroblob(16))').run()
  return { grown, settled: walBytes(dbPath) }
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

    const { grown, settled } = growPinnedLogThenRelease(db, dbPath)

    expect(grown).toBeGreaterThan(WAL_SIZE_LIMIT_BYTES)
    expect(settled).toBeLessThanOrEqual(WAL_SIZE_LIMIT_BYTES)
  })

  // The telemetry connection opens global.db on its own, outside getDb's set-up, and writes a row on every hook call. The module graph is loaded fresh against a data dir of its own so the 80 MB of payload never lands in the shared test home.
  it('is cut back on the per-call telemetry connection too, which opens global.db without getDb', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-walsize-telemetry-'))
    tmpDirs.push(home)
    const savedEnv = { LOCALAPPDATA: process.env['LOCALAPPDATA'], XDG_DATA_HOME: process.env['XDG_DATA_HOME'] }
    process.env['LOCALAPPDATA'] = home
    process.env['XDG_DATA_HOME'] = home
    vi.resetModules()
    let freshDb: typeof DbModule | undefined
    try {
      freshDb = await import('../src/db.js')
      const freshStats = await import('../src/stats.js')
      const { dataDir } = await import('../src/constants.js')
      const dbPath = path.join(dataDir(), 'global.db')
      expect(dbPath.startsWith(home)).toBe(true)

      const result: { sizes?: { grown: number; settled: number } } = {}
      freshStats.withTelemetryWriteDb((db) => {
        result.sizes = growPinnedLogThenRelease(db, dbPath)
      })

      expect(result.sizes?.grown).toBeGreaterThan(WAL_SIZE_LIMIT_BYTES)
      expect(result.sizes?.settled).toBeLessThanOrEqual(WAL_SIZE_LIMIT_BYTES)
    } finally {
      try {
        freshDb?.closeAllDbs()
      } finally {
        for (const [key, value] of Object.entries(savedEnv)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
        vi.resetModules()
      }
    }
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

  // The share is free / page_count against 0.1. Each row below fills one leaf page, so a delete frees one page and the page count never moves (the schema takes about 64 pages, so the table is sized past 300 for a tenth to be reachable by deleting its rows): the free-page count is the only knob, set from the file's own page counts and not from a clock.
  function tenthBoundaryDb(dbPath: string): { db: ReturnType<typeof getDb>; tenth: number } {
    const db = getDb(dbPath)
    db.exec('CREATE TABLE payload (id INTEGER PRIMARY KEY, body BLOB)')
    const insert = db.prepare('INSERT INTO payload (body) VALUES (zeroblob(3000))')
    const pageCount = (): number => Number(db.pragma('page_count', { simple: true }))
    do insert.run()
    while (pageCount() < 300 || pageCount() % 10 !== 0)
    return { db, tenth: pageCount() / 10 }
  }

  function freeUntil(db: ReturnType<typeof getDb>, freePages: number): void {
    const freeNow = (): number => Number(db.pragma('freelist_count', { simple: true }))
    while (freeNow() < freePages) {
      const { changes } = db.prepare('DELETE FROM payload WHERE id = (SELECT max(id) FROM payload)').run()
      if (changes === 0) throw new Error(`the table is empty at ${freeNow()} free pages, short of ${freePages}`)
    }
    expect(freeNow()).toBe(freePages)
  }

  it('leaves a database one page short of a tenth free alone', () => {
    const dbPath = tmpDbPath()
    const { db, tenth } = tenthBoundaryDb(dbPath)
    freeUntil(db, tenth - 1)
    const before = schemaCookie(db)

    expect(idleReclaim(dbPath)).toBe(true)

    expect(schemaCookie(db)).toBe(before)
  })

  it('vacuums a database with exactly a tenth of its pages free', () => {
    const dbPath = tmpDbPath()
    const { db, tenth } = tenthBoundaryDb(dbPath)
    freeUntil(db, tenth)
    const before = schemaCookie(db)

    expect(idleReclaim(dbPath)).toBe(true)

    expect(schemaCookie(db)).toBe(before + 1)
  })

  it('vacuums a database one page past a tenth free', () => {
    const dbPath = tmpDbPath()
    const { db, tenth } = tenthBoundaryDb(dbPath)
    freeUntil(db, tenth + 1)
    const before = schemaCookie(db)

    expect(idleReclaim(dbPath)).toBe(true)

    expect(schemaCookie(db)).toBe(before + 1)
  })

  it('folds and truncates the -wal of a database it leaves alone, without rewriting a page', () => {
    const dbPath = tmpDbPath()
    const db = filledDb(dbPath, 0)
    const cookie = schemaCookie(db)
    const pages = Number(db.pragma('page_count', { simple: true }))
    expect(walBytes(dbPath)).toBeGreaterThan(0)

    expect(idleReclaim(dbPath)).toBe(true)

    expect(walBytes(dbPath)).toBe(0)
    expect(schemaCookie(db)).toBe(cookie)
    expect(Number(db.pragma('page_count', { simple: true }))).toBe(pages)
  })

  it('reports a missing database as not yet done, so the next cycle tries again', () => {
    expect(idleReclaim(tmpDbPath())).toBe(false)
  })
})
