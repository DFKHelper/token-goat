import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Database from 'better-sqlite3'

import { closeAllDbs, closeDb, getDb, SCHEMA_VERSION } from '../src/db.js'
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

describe('getDb error handling', () => {
  // Regression (M9): if a setup step inside initConnection throws after `new Database(...)`
  // has already opened the file (e.g. the WAL-mode check fails), the just-opened handle was
  // neither cached NOR closed -- a leaked file descriptor. This spies on the REAL
  // Database.prototype.pragma (better-sqlite3's actual prototype, not a reimplementation) so
  // getDb runs its real production code path end to end; only the `journal_mode = WAL` call
  // is intercepted to simulate WAL failing to engage, matching initConnection's own check.
  it('closes the just-opened handle if the WAL-mode setup step throws inside initConnection', () => {
    const dbPath = tmpDbPath()
    const originalPragma = Database.prototype.pragma
    let capturedConn: InstanceType<typeof Database> | null = null
    const captureConn = (conn: InstanceType<typeof Database>): void => {
      capturedConn = conn
    }
    const spy = vi
      .spyOn(Database.prototype, 'pragma')
      .mockImplementation(function (this: InstanceType<typeof Database>, source: string, options?: object) {
        captureConn(this)
        if (typeof source === 'string' && source.startsWith('journal_mode')) {
          // Simulate WAL mode failing to engage (e.g. an unsupported filesystem).
          return 'memory'
        }
        return originalPragma.call(this, source, options as never)
      })
    try {
      expect(() => getDb(dbPath)).toThrow(/failed to enable WAL mode/)
      expect(capturedConn).not.toBeNull()
      // Pre-fix: the handle is left open (leaked fd). Post-fix: initConnection's failure is
      // caught at the getDb call site and the handle is closed before the error propagates.
      expect(capturedConn!.open).toBe(false)
    } finally {
      spy.mockRestore()
    }

    // A closed handle releases its OS-level lock on the file, so a fresh getDb for the same
    // path (with the mock removed) must succeed rather than hitting a stale lock from the
    // leaked handle.
    const recovered = getDb(dbPath)
    expect((recovered.prepare('SELECT 1 AS one').get() as { one: number }).one).toBe(1)
  })
})

describe('getDb schema version', () => {
  // No SQLite schema-version/migration mechanism existed before this: SCHEMA_SQL only used
  // CREATE TABLE IF NOT EXISTS, and initConnection never touched PRAGMA user_version. A future
  // schema change (e.g. an ALTER TABLE on an existing table) would have had nowhere to hook a
  // migration step, so a full reindex would hard-crash on the first mismatched file and the
  // worker's incremental drain would silently stop updating the index. These tests exercise the
  // version check + migration-runner scaffolding added to close that gap.

  it('stamps a brand-new DB with PRAGMA user_version = SCHEMA_VERSION', () => {
    const db = getDb(tmpDbPath())
    const version = Number(db.pragma('user_version', { simple: true }))
    expect(version).toBe(SCHEMA_VERSION)
  })

  it('does not rewrite user_version when reopening a DB already at SCHEMA_VERSION', () => {
    const p = tmpDbPath()
    getDb(p) // First open: creates the schema and stamps user_version to SCHEMA_VERSION.
    closeDb(p) // Evict the cached handle so the next getDb() call re-runs initConnection for real.

    const spy = vi.spyOn(Database.prototype, 'pragma')
    try {
      const db = getDb(p)
      // The migration-runner path only ever writes user_version via `user_version = N`; a DB
      // already at SCHEMA_VERSION must not take that branch at all.
      const versionWrites = spy.mock.calls.filter(
        ([source]) => typeof source === 'string' && /^user_version\s*=/.test(source),
      )
      expect(versionWrites).toHaveLength(0)
      expect(Number(db.pragma('user_version', { simple: true }))).toBe(SCHEMA_VERSION)
    } finally {
      spy.mockRestore()
    }
  })

  it('migrates a DB with a lower user_version up to SCHEMA_VERSION without erroring', () => {
    const p = tmpDbPath()
    getDb(p)
    closeDb(p)

    // Simulate a DB from before this migration mechanism existed: open the raw file directly
    // (bypassing token-goat's getDb/initConnection) and force user_version back down, the same
    // state every pre-existing on-disk index is actually in today (never stamped, reads as 0).
    const raw = new Database(p)
    raw.pragma('user_version = 0')
    raw.close()

    const db = getDb(p)
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(SCHEMA_VERSION)
    // No real migration step is registered yet, so this must be a non-destructive no-op: the DB
    // stays fully usable, not just re-stamped.
    const row = db.prepare('SELECT 1 AS one').get() as { one: number }
    expect(row.one).toBe(1)
  })

  it('refuses to open a DB whose user_version is newer than this build supports', () => {
    const p = tmpDbPath()
    getDb(p)
    closeDb(p)

    // Simulate an older binary opening a database written by a newer one (a downgrade, or two
    // globally-installed versions pointed at the same project).
    const raw = new Database(p)
    raw.pragma(`user_version = ${SCHEMA_VERSION + 1}`)
    raw.close()

    expect(() => getDb(p)).toThrow(/schema version/i)
    // getDb's existing error-handling path closes the just-opened handle on any initConnection
    // throw, so this must fail the same way on every attempt, not just the first.
    expect(() => getDb(p)).toThrow(/schema version/i)

    // Rolling the stored version back down (e.g. reinstalling a matching build) must recover
    // cleanly -- no leaked fd/lock from the refused attempts above.
    const raw2 = new Database(p)
    raw2.pragma(`user_version = ${SCHEMA_VERSION}`)
    raw2.close()
    const recovered = getDb(p)
    expect((recovered.prepare('SELECT 1 AS one').get() as { one: number }).one).toBe(1)
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
