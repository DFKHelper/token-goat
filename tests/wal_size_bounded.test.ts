/** A -wal file must not stay at its peak size once its log has been folded back. Found on a real global.db: a 5.0 GB -wal beside a 5.0 GB database of which only 704 frames were live, left by a whole-database VACUUM whose truncating checkpoint a concurrent reader refused. The tests drive the production paths (getDb's connection set-up, the per-call telemetry connection in stats.ts, the worker's idleReclaim) and wait on no clock: every step is a statement that has returned. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeAllDbs, getDb, WAL_SIZE_LIMIT_BYTES } from '../src/db.js'
import { cmdReclaimIndex, reclaimIndex, walCheckpointBusyNoWait } from '../src/index_reclaim.js'
import { clearModuleCaches } from '../src/reset.js'
import Database from '../src/sqlite_driver.js'
import type { SqliteDatabase } from '../src/sqlite_driver.js'
import type * as DbModule from '../src/db.js'
import { idleReclaim } from '../src/worker.js'
import { runTeardown } from './helpers/strict_teardown.js'

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
  // Provenance: HAND-DERIVED. A 1 MiB zeroblob is 1048576 bytes of payload, so ceil(WAL_SIZE_LIMIT_BYTES / 1048576) rows hold exactly the limit (64) and one more (65) puts the payload strictly past it, whatever the page and frame overhead; the log cannot be checkpointed while the reader pins it, so every byte written stays in it. Fewer rows would not cross the limit, so this is the least disk the claim can use.
  const rows = Math.ceil(WAL_SIZE_LIMIT_BYTES / (1024 * 1024)) + 1
  let grown = 0
  withPinningReader(dbPath, (reader) => {
    db.transaction(() => {
      const insert = db.prepare('INSERT INTO payload (body) VALUES (zeroblob(1048576))')
      for (let i = 0; i < rows; i++) insert.run()
    }).immediate()
    grown = walBytes(dbPath)
    reader.exec('COMMIT')
  })
  // The first commit after the reader leaves runs the automatic checkpoint that folds the old log; the next write is the one that restarts the log, and that restart is where SQLite applies journal_size_limit. Provenance: HAND-DERIVED. Those two writes are the two commits that sequence needs, and 16 bytes is any size small enough not to matter.
  db.prepare('INSERT INTO payload (body) VALUES (zeroblob(16))').run()
  db.prepare('INSERT INTO payload (body) VALUES (zeroblob(16))').run()
  return { grown, settled: walBytes(dbPath) }
}

beforeEach(() => {
  clearModuleCaches()
})

function removeDirs(dirs: string[]): Array<() => void> {
  return dirs.splice(0).map((dir) => () => fs.rmSync(dir, { recursive: true, force: true }))
}

// Every connection is closed before the directories go, each step on its own, and a failed removal fails the test: Windows refuses to delete an open -wal, so a swallowed failure would strand the file (about 80 MB) with no sign of which connection leaked.
afterEach(() => {
  runTeardown([closeAllDbs, clearModuleCaches, ...removeDirs(tmpDirs)])
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
  // Provenance: HAND-DERIVED. The page size is SQLite's default 4096 (nothing here sets it), so a 65536-byte blob takes 17 pages (one on the leaf, 16 in its overflow chain) and 40 of them take about 680, far more than the schema's few dozen. Deleting none of them leaves no free pages, under the tenth (0.1) that triggers a vacuum; deleting 0.75 of them frees about three quarters of the pages, far over it.
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

  // The share is free / page_count against 0.1. Each row below fills one leaf page, so a delete frees one page and the page count never moves (the schema takes about 64 pages, so the table is sized past 300 for a tenth to be reachable by deleting its rows): the free-page count is the only knob, set from the file's own page counts and not from a clock. Provenance: HAND-DERIVED. A 4096-byte page keeps a payload of up to 4061 bytes (page size less 35) on its leaf, so a 3000-byte blob stays local and two of them (6000) cannot share a page: one row, one page. The count is grown to 300 pages or more so the tenth (30 or more) is far below the rows available to delete (over 200, the schema being about 64 pages), and to a multiple of 10 so the tenth is a whole number of pages and tenth - 1, tenth and tenth + 1 free pages sit on both sides of the threshold exactly.
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

  // The state of the user's 5.0 GB -wal: the vacuum rewrote every page through the log and a reader that pinned the old snapshot refused the truncating checkpoint after it. Provenance: HAND-DERIVED. The 0.75 share is the one the vacuum test above uses, over the tenth that makes the first pass vacuum; the vacuum leaves no free pages, so the retry takes the checkpoint-only path and the schema cookie (raised by one per vacuum, as above) counts the vacuums.
  it('reports a vacuum whose truncating checkpoint a reader refused as not done, keeps asking without a second vacuum, and truncates once the reader is gone', () => {
    const dbPath = tmpDbPath()
    const db = filledDb(dbPath, 0.75)
    const before = schemaCookie(db)

    withPinningReader(dbPath, () => {
      expect(idleReclaim(dbPath), 'the pass whose truncation was refused is not settled').toBe(false)
      expect(idleReclaim(dbPath), 'the retry with the reader still there is not settled either').toBe(false)
      expect(schemaCookie(db), 'the retry did not vacuum again').toBe(before + 1)
    })
    expect(schemaCookie(db), 'the first pass vacuumed').toBe(before + 1)
    expect(walBytes(dbPath), 'the refused truncation left the log in place').toBeGreaterThan(0)

    expect(idleReclaim(dbPath), 'the retry with the reader gone is settled').toBe(true)
    expect(schemaCookie(db), 'the retry did not vacuum again').toBe(before + 1)
    expect(walBytes(dbPath), 'the retry truncated the log').toBe(0)
  })

  // Provenance: HAND-DERIVED. 777 ms is any nonzero value other than the connection's 15000, so a checkpoint that waits or a timeout that is not put back shows as a different number, and so small that a wait costs well under a second. The pragma is read at the moment each checkpoint is issued, so the test observes the wait setting and never a clock.
  it('leaves a log a reader pins unsettled on every pass without a pass waiting for the reader, and puts the connection timeout back', () => {
    const dbPath = tmpDbPath()
    const db = filledDb(dbPath, 0)
    db.pragma('busy_timeout = 777')
    const before = schemaCookie(db)
    const timeoutAtCheckpoint: number[] = []
    const pragma = db.pragma.bind(db) as (...args: unknown[]) => unknown
    const spy = vi.spyOn(db, 'pragma').mockImplementation(((...args: unknown[]) => {
      if (String(args[0]).startsWith('wal_checkpoint')) timeoutAtCheckpoint.push(Number(pragma('busy_timeout', { simple: true })))
      return pragma(...args)
    }) as typeof db.pragma)

    try {
      withPinningReader(dbPath, () => {
        db.prepare('INSERT INTO payload (body) VALUES (zeroblob(16))').run()
        expect(idleReclaim(dbPath), 'the first pass is refused').toBe(false)
        expect(idleReclaim(dbPath), 'the second pass is refused').toBe(false)
      })
    } finally {
      spy.mockRestore()
    }

    expect(timeoutAtCheckpoint, 'each checkpoint ran with no wait').toEqual([0, 0])
    expect(Number(db.pragma('busy_timeout', { simple: true })), 'the connection timeout is back').toBe(777)
    expect(schemaCookie(db), 'no pass vacuumed').toBe(before)
    expect(walBytes(dbPath), 'the log is still there').toBeGreaterThan(0)
  })
})

// Provenance: HAND-DERIVED. 777 ms is any nonzero value other than the connection's 15000, so a checkpoint that waits records 777 and one that does not records 0. The pragma is read at the moment each checkpoint is issued, so the rows observe the wait setting and never a clock.
describe('the checkpoints of a reclaim pass over a log a reader pins', () => {
  function timeoutsAtCheckpoints(dbPath: string, db: ReturnType<typeof getDb>, pass: () => void): number[] {
    db.pragma('busy_timeout = 777')
    const timeouts: number[] = []
    const pragma = db.pragma.bind(db) as (...args: unknown[]) => unknown
    const spy = vi.spyOn(db, 'pragma').mockImplementation(((...args: unknown[]) => {
      if (String(args[0]).startsWith('wal_checkpoint')) timeouts.push(Number(pragma('busy_timeout', { simple: true })))
      return pragma(...args)
    }) as typeof db.pragma)
    try {
      withPinningReader(dbPath, pass)
    } finally {
      spy.mockRestore()
    }
    return timeouts
  }

  it('run with no wait in the idle pass, the one that vacuums included', () => {
    const dbPath = tmpDbPath()
    const db = getDb(dbPath)
    db.exec('CREATE TABLE payload (id INTEGER PRIMARY KEY, body BLOB)')
    db.transaction(() => {
      const insert = db.prepare('INSERT INTO payload (body) VALUES (zeroblob(65536))')
      for (let i = 0; i < 40; i++) insert.run()
    }).immediate()
    db.prepare('DELETE FROM payload WHERE id <= 30').run()
    const before = schemaCookie(db)

    const timeouts = timeoutsAtCheckpoints(dbPath, db, () => {
      expect(idleReclaim(dbPath), 'the pass whose truncation was refused is not settled').toBe(false)
    })

    expect(schemaCookie(db), 'the pass vacuumed, so both of its own checkpoints ran').toBe(before + 1)
    expect(timeouts, 'the checkpoint before the vacuum and the one after it ran with no wait').toEqual([0, 0])
  })

  it('wait out the connection timeout for the reader by default, so a manual reclaim keeps its patience', () => {
    const dbPath = tmpDbPath()
    const db = getDb(dbPath)
    db.exec('CREATE TABLE payload (id INTEGER PRIMARY KEY, body BLOB)')

    const timeouts = timeoutsAtCheckpoints(dbPath, db, () => {
      db.prepare('INSERT INTO payload (body) VALUES (zeroblob(16))').run()
      reclaimIndex(dbPath)
    })

    expect(timeouts, 'both checkpoints ran with the connection timeout').toEqual([777, 777])
  })
})

// Provenance: HAND-DERIVED. 777 ms is any nonzero value other than the connection's 15000, so a VACUUM that waits sees 777 and one that does not sees 0. The pragma is read at the moment VACUUM is issued, so the rows observe the wait setting and never a clock. The refusal is a stub on the connection's exec that throws for VACUUM only, with the code SQLite reports for a lock held elsewhere (SQLITE_BUSY, sqlite.org/rescode.html), because holding a real writer lock for the length of a wait would make the row a timing test.
describe('the VACUUM of a reclaim pass', () => {
  function vacuumableDb(dbPath: string): ReturnType<typeof getDb> {
    const db = getDb(dbPath)
    db.exec('CREATE TABLE payload (id INTEGER PRIMARY KEY, body BLOB)')
    db.transaction(() => {
      const insert = db.prepare('INSERT INTO payload (body) VALUES (zeroblob(65536))')
      for (let i = 0; i < 40; i++) insert.run()
    }).immediate()
    db.prepare('DELETE FROM payload WHERE id <= 30').run()
    db.pragma('busy_timeout = 777')
    return db
  }

  /** Run `pass` with every VACUUM on `db` recording the busy_timeout in effect when it is issued; `refuseWith` makes the VACUUM throw it instead of running. */
  function timeoutsAtVacuum(db: ReturnType<typeof getDb>, pass: () => void, refuseWith?: Error): number[] {
    const timeouts: number[] = []
    const exec = db.exec.bind(db) as (sql: string) => unknown
    const spy = vi.spyOn(db, 'exec').mockImplementation(((sql: string) => {
      if (sql === 'VACUUM') {
        timeouts.push(Number(db.pragma('busy_timeout', { simple: true })))
        if (refuseWith !== undefined) throw refuseWith
      }
      return exec(sql)
    }) as typeof db.exec)
    try {
      pass()
    } finally {
      spy.mockRestore()
    }
    return timeouts
  }

  function busyError(): Error {
    return Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
  }

  it('runs with no wait in the idle pass and puts the connection timeout back after it', () => {
    const dbPath = tmpDbPath()
    const db = vacuumableDb(dbPath)
    const before = schemaCookie(db)

    const timeouts = timeoutsAtVacuum(db, () => {
      expect(idleReclaim(dbPath), 'the pass is settled').toBe(true)
    })

    expect(timeouts, 'the one VACUUM ran with no wait').toEqual([0])
    expect(schemaCookie(db), 'the VACUUM ran').toBe(before + 1)
    expect(Number(db.pragma('busy_timeout', { simple: true })), 'the connection timeout is back').toBe(777)
  })

  it('keeps the connection timeout when a reclaim is not the idle pass', () => {
    const dbPath = tmpDbPath()
    const db = vacuumableDb(dbPath)

    const timeouts = timeoutsAtVacuum(db, () => {
      reclaimIndex(dbPath)
    })

    expect(timeouts, 'the VACUUM waited as the connection says').toEqual([777])
    expect(Number(db.pragma('busy_timeout', { simple: true })), 'the connection timeout is unchanged').toBe(777)
  })

  it('keeps the connection timeout in the reclaim-index command', () => {
    const dbPath = tmpDbPath()
    const db = vacuumableDb(dbPath)
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write)

    let timeouts: number[]
    try {
      timeouts = timeoutsAtVacuum(db, () => {
        cmdReclaimIndex({ dbPath, force: true })
      })
    } finally {
      stdout.mockRestore()
    }

    expect(timeouts, 'the command VACUUM waited as the connection says').toEqual([777])
  })

  it('is deferred at once when the idle pass finds the lock held, with the connection timeout back', () => {
    const dbPath = tmpDbPath()
    const db = vacuumableDb(dbPath)
    const before = schemaCookie(db)
    let result: ReturnType<typeof reclaimIndex> | undefined

    const timeouts = timeoutsAtVacuum(
      db,
      () => {
        result = reclaimIndex(dbPath, { rebuild: false, waitForReaders: false })
      },
      busyError(),
    )

    expect(timeouts, 'the refused VACUUM ran with no wait').toEqual([0])
    expect(result?.vacuumDeferred, 'the refusal is reported as a deferral').toBe(true)
    expect(schemaCookie(db), 'nothing was vacuumed').toBe(before)
    expect(Number(db.pragma('busy_timeout', { simple: true })), 'the connection timeout is back after the refusal').toBe(777)
  })

  it('lets a fault other than a held lock through, with the connection timeout back', () => {
    const dbPath = tmpDbPath()
    const db = vacuumableDb(dbPath)
    const fault = Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' })
    let thrown: unknown

    timeoutsAtVacuum(
      db,
      () => {
        try {
          reclaimIndex(dbPath, { rebuild: false, waitForReaders: false })
        } catch (err) {
          thrown = err
        }
      },
      fault,
    )

    expect(thrown, 'the fault reaches the caller').toBe(fault)
    expect(Number(db.pragma('busy_timeout', { simple: true })), 'the connection timeout is back after the fault').toBe(777)
  })
})

describe('walCheckpointBusyNoWait', () => {
  // Provenance: HAND-DERIVED. 777 ms is any nonzero value other than the connection's 15000, so a timeout left at zero or put back as a default shows as a different number. The failure is a stub on the connection's pragma that throws for the checkpoint only, because a real checkpoint does not throw on a busy reader (it answers busy), so the throw path cannot be reached without it; nothing here waits on the clock.
  it('puts the connection timeout back and lets the error through when the checkpoint throws', () => {
    const dbPath = tmpDbPath()
    const db = getDb(dbPath)
    db.pragma('busy_timeout = 777')
    const refused = new Error('checkpoint failed')
    const pragma = db.pragma.bind(db) as (...args: unknown[]) => unknown
    const spy = vi.spyOn(db, 'pragma').mockImplementation(((...args: unknown[]) => {
      if (String(args[0]).startsWith('wal_checkpoint')) throw refused
      return pragma(...args)
    }) as typeof db.pragma)

    let thrown: unknown
    try {
      walCheckpointBusyNoWait(db)
    } catch (err) {
      thrown = err
    } finally {
      spy.mockRestore()
    }

    expect(thrown, 'the checkpoint error reaches the caller').toBe(refused)
    expect(Number(db.pragma('busy_timeout', { simple: true })), 'the connection timeout is back after a throw').toBe(777)
  })
})

/** The text between the braces of each arrow-function afterEach block in `source`, found by counting braces (these files keep braces out of the strings and comments inside those blocks). */
function afterEachBodies(source: string): string[] {
  const bodies: string[] = []
  for (const match of source.matchAll(/afterEach\(\(\) => \{/g)) {
    const start = match.index + match[0].length
    let depth = 1
    let end = start
    while (depth > 0 && end < source.length) {
      const char = source[end]
      if (char === '{') depth++
      else if (char === '}') depth--
      end++
    }
    bodies.push(source.slice(start, end - 1))
  }
  return bodies
}

/** `body` with the argument of its `runTeardown(...)` call cut out, found by counting parentheses. */
function withoutRunTeardownCall(body: string): string {
  const open = body.indexOf('runTeardown(')
  if (open < 0) return body
  let depth = 0
  let end = open + 'runTeardown'.length
  do {
    const char = body[end]
    if (char === '(') depth++
    else if (char === ')') depth--
    end++
  } while (depth > 0 && end < body.length)
  return body.slice(0, open) + body.slice(end)
}

describe('the teardown', () => {
  // This is the check that a swallow written straight into an afterEach cannot slip past runTeardown. What it cannot see: a swallow inside a helper an afterEach calls, or an afterEach written in another form than an arrow function with no parameters.
  it.each(['wal_size_bounded.test.ts', 'worker_idle_vacuum_bookkeeping.test.ts'])('%s removes nothing in an afterEach except through runTeardown', (name) => {
    const bodies = afterEachBodies(fs.readFileSync(path.join(import.meta.dirname, name), 'utf8'))

    expect(bodies.length, 'the file has an afterEach block').toBeGreaterThan(0)
    for (const body of bodies) {
      expect(body, 'the block tears down through runTeardown').toContain('runTeardown(')
      expect(withoutRunTeardownCall(body), 'nothing removes or swallows outside it').not.toMatch(/rmSync|rmdirSync|unlinkSync|catch/)
    }
  })

  it('fails with every step that failed, and still runs the steps after it, instead of swallowing a removal it could not do', () => {
    const refused = new Error('EBUSY: resource busy or locked')
    const ran: string[] = []
    let thrown: unknown

    try {
      runTeardown([
        () => {
          throw refused
        },
        () => ran.push('after the failure'),
      ])
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toEqual([refused])
    expect(ran).toEqual(['after the failure'])
  })

  // Windows refuses to delete a file a connection holds open; the other platforms unlink it, so there a leaked connection cannot show as a failed removal and only the step-level test above applies.
  it.runIf(process.platform === 'win32')('fails the removal of a directory whose database a connection still holds open', () => {
    const dbPath = tmpDbPath()
    const leaked = new Database(dbPath)
    try {
      leaked.pragma('journal_mode = WAL')
      leaked.exec('CREATE TABLE t (id INTEGER)')

      expect(() => runTeardown(removeDirs([path.dirname(dbPath)]))).toThrow(AggregateError)
    } finally {
      leaked.close()
    }
  })
})
