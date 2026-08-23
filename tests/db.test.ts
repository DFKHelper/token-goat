import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Database from '../src/sqlite_driver.js'

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

  it('sets a busy_timeout above the driver default so concurrent writers wait instead of erroring', () => {
    // token-goat runs multiple processes against one global.db (worker daemon + CLI hook invocations). Without a generous busy_timeout a writer that finds the write lock held fails immediately with SQLITE_BUSY ("database is locked"). The driver opens connections at 5000ms (matching better-sqlite3, since node:sqlite's own default is 0); we raise it to 15000ms here, so a regression that drops the explicit pragma is caught.
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

  it('creates the notes table (architecture notes, notes.ts) on first open', () => {
    const db = getDb(tmpDbPath())
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name)
    expect(names).toContain('notes')

    const cols = (db.prepare('PRAGMA table_info(notes)').all() as { name: string }[]).map((r) => r.name)
    expect(cols).toEqual(
      expect.arrayContaining(['id', 'file_path', 'symbol', 'content', 'fingerprint', 'created_at', 'updated_at']),
    )

    // UNIQUE(file_path, symbol) is the upsert key note-add relies on -- a second insert with the
    // same pair must conflict (and be handled by ON CONFLICT DO UPDATE at the call site), not
    // silently create a duplicate row.
    db.prepare(
      "INSERT INTO notes (file_path, symbol, content, fingerprint, created_at, updated_at) VALUES ('a.ts', '', 'x', 'fp', 1, 1)",
    ).run()
    expect(() =>
      db
        .prepare(
          "INSERT INTO notes (file_path, symbol, content, fingerprint, created_at, updated_at) VALUES ('a.ts', '', 'y', 'fp2', 2, 2)",
        )
        .run(),
    ).toThrow()
  })

  it('creates the symbols_fts virtual table when FTS5 is available', () => {
    const db = getDb(tmpDbPath())
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name)
    // The SQLite build Node bundles ships FTS5 enabled, so this should be present.
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
  // Database.prototype.pragma (the driver's actual prototype, not a reimplementation) so
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

  it('migrates a v8 DB (symbols table without the parent column) up to SCHEMA_VERSION, adding symbols.parent', () => {
    const p = tmpDbPath()

    // Simulate a real pre-v9 on-disk database: a symbols table shaped exactly like v8's
    // SCHEMA_SQL (no `parent` column), stamped user_version = 8. Built directly against the raw
    // file, bypassing token-goat's getDb/initConnection, so this doesn't depend on the current
    // (post-fix) SCHEMA_SQL to construct the "before" state.
    const raw = new Database(p)
    raw.exec(`
      CREATE TABLE symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT,
        name TEXT,
        kind TEXT,
        line_start INTEGER,
        line_end INTEGER,
        body TEXT,
        docstring TEXT
      );
    `)
    raw.prepare(
      `INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('a.kt', 'ktFn', 'function', 1, 1, 'fun ktFn() {}', 'Widget')
    raw.pragma('user_version = 8')
    raw.close()

    const db = getDb(p)
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(SCHEMA_VERSION)

    // Pre-existing row survives the ALTER TABLE with parent defaulted to '', and the table
    // remains usable for new inserts that populate parent explicitly.
    const existing = db.prepare('SELECT docstring, parent FROM symbols WHERE name = ?').get('ktFn') as {
      docstring: string
      parent: string
    }
    expect(existing.docstring).toBe('Widget')
    expect(existing.parent).toBe('')

    db.prepare(
      `INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring, parent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('b.kt', 'ktFn2', 'function', 1, 1, 'fun ktFn2() {}', '/** doc */', 'Widget')
    const inserted = db.prepare('SELECT docstring, parent FROM symbols WHERE name = ?').get('ktFn2') as {
      docstring: string
      parent: string
    }
    expect(inserted.docstring).toBe('/** doc */')
    expect(inserted.parent).toBe('Widget')
  })

  it('migrates a v9 DB (hint_emissions table without the bytes_emitted column) up to SCHEMA_VERSION, adding hint_emissions.bytes_emitted', () => {
    const p = tmpDbPath()

    // Simulate a real pre-v10 on-disk database: a hint_emissions table shaped exactly like v9's
    // SCHEMA_SQL (no `bytes_emitted` column), stamped user_version = 9. Built directly against
    // the raw file, bypassing token-goat's getDb/initConnection, same pattern as the v8 -> v9
    // symbols.parent test above.
    const raw = new Database(p)
    raw.exec(`
      CREATE TABLE hint_emissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        session_id TEXT NOT NULL,
        harness TEXT NOT NULL,
        correlator TEXT,
        emitted_at REAL NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0,
        acted_on INTEGER NOT NULL DEFAULT 0,
        calls_remaining INTEGER NOT NULL DEFAULT 0
      );
    `)
    raw.prepare(
      `INSERT INTO hint_emissions (category, session_id, harness, correlator, emitted_at, resolved, acted_on, calls_remaining) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('bash_redirect', 'preexisting-session', 'claude-code', null, Date.now(), 1, 0, 0)
    raw.pragma('user_version = 9')
    raw.close()

    const db = getDb(p)
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(SCHEMA_VERSION)

    // Pre-existing row survives the ALTER TABLE with bytes_emitted left NULL (not 0 -- there is
    // no way to know what a pre-migration emission cost, and rendering it as a genuine zero
    // would misreport a real spend as a measured non-spend).
    const existing = db.prepare('SELECT category, bytes_emitted FROM hint_emissions WHERE session_id = ?').get('preexisting-session') as {
      category: string
      bytes_emitted: number | null
    }
    expect(existing.category).toBe('bash_redirect')
    expect(existing.bytes_emitted).toBe(null)

    db.prepare(
      `INSERT INTO hint_emissions (category, session_id, harness, correlator, emitted_at, resolved, acted_on, calls_remaining, bytes_emitted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('bash_redirect', 'fresh-session', 'claude-code', null, Date.now(), 1, 0, 0, 42)
    const inserted = db.prepare('SELECT bytes_emitted FROM hint_emissions WHERE session_id = ?').get('fresh-session') as { bytes_emitted: number | null }
    expect(inserted.bytes_emitted).toBe(42)
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

describe('folded-path expression indexes (full table scan fix)', () => {
  // Regression: pathEqClause() (sql_path.ts) emits `TG_LOWER(column) = ?` for case-insensitive
  // filesystem comparisons, and TG_LOWER is a custom registered SQL function -- SQLite cannot
  // use a plain column index (idx_symbols_file etc.) to satisfy a WHERE clause wrapped in a
  // function call, so every such query used to be a full table SCAN regardless of table size.
  // The fix is an expression index (CREATE INDEX ... ON table(TG_LOWER(column))) added to
  // SCHEMA_SQL for files/symbols/refs/chunks -- SQLite matches pathEqClause's exact
  // `TG_LOWER(column) = ?` text against it and uses SEARCH instead of SCAN, without requiring
  // any writer to populate a separate folded column. These tests assert the query plan directly
  // via EXPLAIN QUERY PLAN so the fix can't silently regress back to a full scan.
  const tables: ReadonlyArray<readonly [string, string]> = [
    ['files', 'path'],
    ['symbols', 'file_path'],
    ['refs', 'file_path'],
    ['chunks', 'file_path'],
  ]
  for (const [table, column] of tables) {
    it(`uses SEARCH (not SCAN) for a TG_LOWER(${column}) = ? lookup on ${table}`, () => {
      const db = getDb(tmpDbPath())
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN SELECT * FROM ${table} WHERE TG_LOWER(${column}) = ?`)
        .all('c:/proj/file.ts') as Array<{ detail: string }>
      const detail = plan.map((row) => row.detail).join(' | ')
      expect(detail).toMatch(/SEARCH/)
      expect(detail).not.toMatch(/SCAN/)
    })
  }

  it('is populated for rows already present before the index is (re)created (pre-existing DB)', () => {
    // Simulate a DB that lost or never had the expression index (e.g. an older on-disk index
    // predating this fix): open a connection (creating the schema), drop the index, insert
    // rows, then reopen via getDb. initConnection's `CREATE INDEX IF NOT EXISTS` runs
    // unconditionally on every open (no MIGRATIONS/SCHEMA_VERSION gate needed for a purely
    // additive index -- see the SCHEMA_SQL comment in db.ts), so the index comes back; SQLite
    // backfills an expression index from existing table contents automatically on CREATE INDEX,
    // unlike a stored column, which would need an explicit UPDATE backfill.
    const p = tmpDbPath()
    const db = getDb(p)
    db.exec('DROP INDEX IF EXISTS idx_symbols_file_folded')
    db.prepare(
      'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('C:/proj/Foo.ts', 'foo', 'function', 1, 1, 'x', '')
    closeDb(p)

    const reopened = getDb(p) // initConnection re-runs SCHEMA_SQL, recreating the dropped index.
    const plan = reopened
      .prepare('EXPLAIN QUERY PLAN SELECT * FROM symbols WHERE TG_LOWER(file_path) = ?')
      .all('c:/proj/foo.ts') as Array<{ detail: string }>
    expect(plan.map((row) => row.detail).join(' | ')).toMatch(/SEARCH/)

    const row = reopened
      .prepare('SELECT name FROM symbols WHERE TG_LOWER(file_path) = ?')
      .get('c:/proj/foo.ts') as { name: string } | undefined
    expect(row?.name).toBe('foo')
  })
})
