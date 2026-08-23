/**
 * A better-sqlite3-shaped facade over Node's built-in `node:sqlite`.
 *
 * Why this file exists: `better-sqlite3` is a native addon, and it is the single largest thing a
 * default `npm i -g token-goat` drags in. Measured against the real lockfile it is 36 of the 106
 * packages a default install resolves, the only package in the tree still marked deprecated, and
 * one of the 14 that run an install script. With it gone, `npm i --omit=optional token-goat`
 * resolves **two** packages and runs no install scripts at all. Node ships the same SQLite engine
 * in core -- `node:sqlite` was unflagged in Node 22.13.0 -- so the dependency buys nothing the
 * runtime does not already have. The pieces this file needs on top of that (`columns()`,
 * `isTransaction`, the `timeout` constructor option) landed in 22.16.0, which is why the package's
 * `engines` floor moved there rather than staying at 22.13.
 *
 * What it is not: a general better-sqlite3 polyfill. It covers exactly the surface this repository
 * uses, which `tests/sqlite_driver.test.ts` pins against better-sqlite3 itself as a differential
 * oracle. Adding a call to some other part of better-sqlite3's API will not silently fall through
 * to something approximate; it will fail to compile, because the interfaces below are the contract.
 *
 * Five places the two libraries genuinely differ, and what is done about each:
 *
 *   1. `node:sqlite` has no `pragma()`. `PRAGMA x` and `PRAGMA x = y` both prepare and execute
 *      fine, so {@link Database.pragma} is `prepare('PRAGMA ' + source).all()`, with `{simple:true}`
 *      taking the first column of the first row exactly as better-sqlite3 does. An assigning pragma
 *      returns no rows, which `simple` reports as `undefined` -- the same thing better-sqlite3
 *      returns there.
 *   2. `node:sqlite` has no `transaction()`. {@link Database.transaction} builds it, including the
 *      `.immediate()` variant six call sites in this repository depend on, and including SAVEPOINT
 *      nesting so a transaction opened inside another one does not try to `BEGIN` twice. Nesting is
 *      decided by SQLite's own `isTransaction`, not a counter this file keeps, so a transaction
 *      opened by any other route is still seen.
 *   3. Loading `node:sqlite` emits an `ExperimentalWarning` on stderr. token-goat runs as a
 *      PreToolUse hook on every Read, Grep, Glob and WebFetch, so an unconditional line of stderr
 *      per invocation is not cosmetic. {@link suppressSqliteExperimentalWarning} removes that one
 *      warning and then uninstalls itself -- see its own comment for why it cannot simply restore
 *      after the require returns.
 *   4. The two report the same failure under different names. better-sqlite3 puts the result code's
 *      name in `err.code`; `node:sqlite` puts a generic `ERR_SQLITE_ERROR` there and the numeric
 *      extended code in `err.errcode`. {@link sqliteResultCodeName} translates one into the other
 *      and {@link attempt} applies it to every call that can throw, so a caller branching on
 *      `SQLITE_BUSY` keeps working. This was not hypothetical: `index_reclaim.ts` tells routine
 *      lock contention apart from a real error that way, and without the translation a deferred
 *      VACUUM became a thrown `database is locked`.
 *   5. They disagree on the default `busy_timeout`: better-sqlite3 opens at 5000ms, `node:sqlite`
 *      at 0. The constructor below restores 5000 so a connection that names no timeout keeps the
 *      patience it used to have, which matters for the readonly connections `sqlite_query.ts`
 *      opens on databases this program does not own and cannot re-open on a retry.
 */

import * as fs from 'node:fs'
import { createRequire } from 'node:module'

const _require = createRequire(import.meta.url)

/**
 * Swallow the single `ExperimentalWarning` that loading `node:sqlite` emits, and nothing else.
 *
 * `process.emitWarning` defers to `process.nextTick`, so the warning has not fired by the time
 * `require('node:sqlite')` returns -- restoring `process.emit` on the next line would be too early
 * and the warning would print anyway (verified, not assumed). So the filter stays installed until
 * it has actually seen its warning, and removes itself at that point; a `setImmediate` bounds it to
 * one turn of the event loop in case the warning never comes, and a process short enough to exit
 * first never had a second warning to miss.
 *
 * The predicate is deliberately narrow: the name must be `ExperimentalWarning` and the message must
 * mention SQLite. A genuine `DeprecationWarning`, or an `ExperimentalWarning` about anything else,
 * goes through untouched -- both checked in the driver tests, because a filter that quietly ate
 * every warning would look identical from the outside on the day it started mattering.
 *
 * Exported only so those tests can drive it directly; nothing else should call it.
 */
export function suppressSqliteExperimentalWarning(): () => void {
  const original = process.emit
  let armed = true
  const restore = (): void => {
    if (!armed) return
    armed = false
    process.emit = original
  }
  process.emit = function patched(this: NodeJS.Process, name: string | symbol, ...rest: unknown[]) {
    const data = rest[0]
    if (
      armed &&
      name === 'warning' &&
      data instanceof Error &&
      data.name === 'ExperimentalWarning' &&
      /sqlite/i.test(data.message)
    ) {
      restore()
      return false
    }
    return (original as (...a: unknown[]) => boolean).call(this, name, ...rest)
  } as typeof process.emit
  setImmediate(restore)
  return restore
}

/**
 * The subset of `node:sqlite` this file drives. Declared structurally rather than imported from
 * `node:sqlite`'s own types: an ESM `import` is hoisted above every statement in the module, which
 * would run the require before the warning filter could be installed. `createRequire` is an
 * ordinary call and runs where it is written.
 */
interface NodeStatementSync {
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  iterate(...params: unknown[]): IterableIterator<unknown>
  columns(): SqliteColumn[]
  setReadBigInts(enabled: boolean): void
  readonly sourceSQL: string
}

interface NodeDatabaseSync {
  prepare(sql: string): NodeStatementSync
  exec(sql: string): void
  close(): void
  function(name: string, options: { deterministic?: boolean }, fn: (...args: never[]) => unknown): void
  loadExtension(path: string): void
  readonly isOpen: boolean
  readonly isTransaction: boolean
}

interface NodeSqliteModule {
  DatabaseSync: new (path: string, options?: Record<string, unknown>) => NodeDatabaseSync
}

const restoreWarnings = suppressSqliteExperimentalWarning()
let nodeSqlite: NodeSqliteModule
try {
  nodeSqlite = _require('node:sqlite') as NodeSqliteModule
} catch (e) {
  restoreWarnings()
  throw e
}
const { DatabaseSync } = nodeSqlite

/** SQLite's primary result codes, indexed by the code itself. Gaps are impossible: 0-28 are contiguous, and 100/101 are appended separately below. */
const SQLITE_PRIMARY_CODES = [
  'SQLITE_OK', 'SQLITE_ERROR', 'SQLITE_INTERNAL', 'SQLITE_PERM', 'SQLITE_ABORT', 'SQLITE_BUSY',
  'SQLITE_LOCKED', 'SQLITE_NOMEM', 'SQLITE_READONLY', 'SQLITE_INTERRUPT', 'SQLITE_IOERR',
  'SQLITE_CORRUPT', 'SQLITE_NOTFOUND', 'SQLITE_FULL', 'SQLITE_CANTOPEN', 'SQLITE_PROTOCOL',
  'SQLITE_EMPTY', 'SQLITE_SCHEMA', 'SQLITE_TOOBIG', 'SQLITE_CONSTRAINT', 'SQLITE_MISMATCH',
  'SQLITE_MISUSE', 'SQLITE_NOLFS', 'SQLITE_AUTH', 'SQLITE_FORMAT', 'SQLITE_RANGE', 'SQLITE_NOTADB',
  'SQLITE_NOTICE', 'SQLITE_WARNING',
] as const

/** Suffixes of the extended result codes, per family, in subcode order starting at 1. `null` marks a subcode SQLite does not define -- only `SQLITE_ABORT` has one, whose sole extended code is `SQLITE_ABORT_ROLLBACK` at subcode 2. */
const SQLITE_EXTENDED_SUFFIXES: Record<string, readonly (string | null)[]> = {
  SQLITE_OK: ['LOAD_PERMANENTLY', 'SYMLINK'],
  SQLITE_ERROR: ['MISSING_COLLSEQ', 'RETRY', 'SNAPSHOT'],
  SQLITE_ABORT: [null, 'ROLLBACK'],
  SQLITE_BUSY: ['RECOVERY', 'SNAPSHOT', 'TIMEOUT'],
  SQLITE_LOCKED: ['SHAREDCACHE', 'VTAB'],
  SQLITE_READONLY: ['RECOVERY', 'CANTLOCK', 'ROLLBACK', 'DBMOVED', 'CANTINIT', 'DIRECTORY'],
  SQLITE_IOERR: [
    'READ', 'SHORT_READ', 'WRITE', 'FSYNC', 'DIR_FSYNC', 'TRUNCATE', 'FSTAT', 'UNLOCK', 'RDLOCK',
    'DELETE', 'BLOCKED', 'NOMEM', 'ACCESS', 'CHECKRESERVEDLOCK', 'LOCK', 'CLOSE', 'DIR_CLOSE',
    'SHMOPEN', 'SHMSIZE', 'SHMLOCK', 'SHMMAP', 'SEEK', 'DELETE_NOENT', 'MMAP', 'GETTEMPPATH',
    'CONVPATH', 'VNODE', 'AUTH', 'BEGIN_ATOMIC', 'COMMIT_ATOMIC', 'ROLLBACK_ATOMIC', 'DATA',
    'CORRUPTFS', 'IN_PAGE',
  ],
  SQLITE_CORRUPT: ['VTAB', 'SEQUENCE', 'INDEX'],
  SQLITE_CANTOPEN: ['NOTEMPDIR', 'ISDIR', 'FULLPATH', 'CONVPATH', 'DIRTYWAL', 'SYMLINK'],
  SQLITE_CONSTRAINT: [
    'CHECK', 'COMMITHOOK', 'FOREIGNKEY', 'FUNCTION', 'NOTNULL', 'PRIMARYKEY', 'TRIGGER', 'UNIQUE',
    'VTAB', 'ROWID', 'PINNED', 'DATATYPE',
  ],
  SQLITE_AUTH: ['USER'],
  SQLITE_NOTICE: ['RECOVER_WAL', 'RECOVER_ROLLBACK', 'RBU'],
  SQLITE_WARNING: ['AUTOINDEX'],
}

/**
 * Spell a numeric SQLite result code the way better-sqlite3 spells it in `err.code`.
 *
 * The two libraries report the same failure under different names: better-sqlite3 puts the result
 * code's name in `code` (`SQLITE_BUSY`), while `node:sqlite` puts its own generic
 * `ERR_SQLITE_ERROR` there and the numeric extended code in `errcode`. Code in this repository
 * branches on the former -- `index_reclaim.ts` decides whether a failed VACUUM is contention it
 * should defer or a real error it must rethrow by prefix-matching `SQLITE_BUSY`/`SQLITE_LOCKED` --
 * so without translation that check silently stops matching and a routine lock loss surfaces as a
 * crash. Exported for the driver tests, which check the table against better-sqlite3's own answers.
 *
 * An extended code is `primary | (subcode << 8)`. Unknown codes fall back to the primary name, and
 * an unknown primary to `ERR_SQLITE_ERROR`, so a future SQLite adding a code cannot throw here.
 */
export function sqliteResultCodeName(errcode: number): string {
  if (!Number.isInteger(errcode) || errcode < 0) return 'ERR_SQLITE_ERROR'
  if (errcode === 100) return 'SQLITE_ROW'
  if (errcode === 101) return 'SQLITE_DONE'
  const primary = SQLITE_PRIMARY_CODES[errcode & 0xff]
  if (primary === undefined) return 'ERR_SQLITE_ERROR'
  const subcode = errcode >> 8
  if (subcode === 0) return primary
  const suffix = SQLITE_EXTENDED_SUFFIXES[primary]?.[subcode - 1]
  return suffix === undefined || suffix === null ? primary : `${primary}_${suffix}`
}

/** Run `fn`, relabelling any `node:sqlite` error with better-sqlite3's `code` spelling. The error object itself is kept, so its message and stack are the ones SQLite and Node produced; only `code` is rewritten, and `errcode`/`errstr` stay untouched for anyone who wants the raw pair. */
function attempt<T>(fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    const err = e as { code?: unknown; errcode?: unknown }
    if (err.code === 'ERR_SQLITE_ERROR' && typeof err.errcode === 'number') {
      err.code = sqliteResultCodeName(err.errcode)
    }
    throw e
  }
}

/** Column metadata, in better-sqlite3's shape. `node:sqlite` already returns exactly this. */
export interface SqliteColumn {
  name: string
  column: string | null
  table: string | null
  database: string | null
  type: string | null
}

/** What `.run()` reports. Both libraries return plain numbers here unless big-integer reads are on. */
export interface SqliteRunResult {
  changes: number | bigint
  lastInsertRowid: number | bigint
}

export interface SqliteStatement {
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  run(...params: unknown[]): SqliteRunResult
  iterate(...params: unknown[]): IterableIterator<unknown>
  /** Return the first column's value instead of a row object. Chainable, like better-sqlite3. */
  pluck(toggle?: boolean): SqliteStatement
  /** Read INTEGER columns as `bigint`, so a value above 2^53 is exact rather than rounded. */
  safeIntegers(toggle?: boolean): SqliteStatement
  columns(): SqliteColumn[]
  /** True when this statement produces rows. `sqlite_query.ts` uses it as a security check. */
  readonly reader: boolean
  readonly source: string
}

/**
 * What `db.transaction(fn)` returns: callable, plus the three explicit lock modes. `.immediate()`
 * is the one that matters here -- a plain `BEGIN` is deferred, which takes the write lock only at
 * the first write and so can fail mid-transaction under concurrency; six call sites in this
 * repository use `.immediate()` for exactly that reason.
 */
export interface SqliteTransaction<A extends unknown[], R> {
  (...args: A): R
  default(...args: A): R
  deferred(...args: A): R
  immediate(...args: A): R
  exclusive(...args: A): R
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement
  exec(sql: string): void
  pragma(source: string, options?: { simple?: boolean }): unknown
  transaction<A extends unknown[], R>(fn: (...args: A) => R): SqliteTransaction<A, R>
  function(name: string, options: { deterministic?: boolean }, fn: (...args: never[]) => unknown): void
  loadExtension(path: string): void
  close(): void
  readonly open: boolean
  readonly inTransaction: boolean
  readonly readonly: boolean
  readonly name: string
}

/** Constructor options, named as better-sqlite3 names them so call sites need no edit. */
export interface SqliteOptions {
  readonly?: boolean
  fileMustExist?: boolean
  timeout?: number
}

class Statement implements SqliteStatement {
  #stmt: NodeStatementSync
  #pluck = false

  constructor(stmt: NodeStatementSync) {
    this.#stmt = stmt
  }

  get source(): string {
    return this.#stmt.sourceSQL
  }

  /**
   * better-sqlite3's `reader` flag: does this statement return rows?
   *
   * `node:sqlite` has no equivalent, so it is derived from the prepared statement's own column
   * count -- SQLite gives a row-producing statement its result columns at prepare time and gives a
   * non-producing one none. That is a derivation, and this is the third defence-in-depth layer in
   * `sqlite_query.ts`'s read-only guard, so it is not taken on faith: the driver tests run both
   * libraries side by side over SELECT, a CTE, VALUES, EXPLAIN, an empty-result SELECT, INSERT,
   * UPDATE, DELETE, CREATE, a reading PRAGMA and an assigning PRAGMA, and require every verdict to
   * agree. If a future SQLite statement form ever breaks the equivalence, that test fails rather
   * than the guard quietly weakening.
   */
  get reader(): boolean {
    return attempt(() => this.#stmt.columns()).length > 0
  }

  // A plucked row is "the first column", which for an object row means the first *inserted* key. V8 preserves insertion order for string keys, and node:sqlite builds the row by walking the result columns left to right, so Object.values()[0] is the leftmost column -- not the column named in the SQL text, the same rule better-sqlite3 applies.
  #shape(row: unknown): unknown {
    if (!this.#pluck || row === undefined || row === null) return row
    const values = Object.values(row as Record<string, unknown>)
    return values.length === 0 ? undefined : values[0]
  }

  get(...params: unknown[]): unknown {
    return this.#shape(attempt(() => this.#stmt.get(...params)))
  }

  all(...params: unknown[]): unknown[] {
    const rows = attempt(() => this.#stmt.all(...params))
    return this.#pluck ? rows.map((r) => this.#shape(r)) : rows
  }

  run(...params: unknown[]): SqliteRunResult {
    return attempt(() => this.#stmt.run(...params))
  }

  // Wrapped rather than returned directly so pluck applies lazily, one row at a time: the whole point of iterate() here is that sqlite_query.ts caps the row count without buffering the rest, and mapping the iterator through .all() first would defeat that.
  *iterate(...params: unknown[]): IterableIterator<unknown> {
    const rows = attempt(() => this.#stmt.iterate(...params))[Symbol.iterator]()
    // Pulled one step at a time rather than with `for...of`, because node:sqlite steps the statement lazily: a lock lost or a row that fails to decode throws from `next()`, long after the call that produced the iterator returned. Wrapping only that call would relabel nothing.
    for (;;) {
      const next = attempt(() => rows.next())
      if (next.done === true) return
      yield this.#shape(next.value)
    }
  }

  pluck(toggle = true): SqliteStatement {
    this.#pluck = toggle
    return this
  }

  safeIntegers(toggle = true): SqliteStatement {
    this.#stmt.setReadBigInts(toggle)
    return this
  }

  columns(): SqliteColumn[] {
    return attempt(() => this.#stmt.columns())
  }
}

/**
 * A SQLite connection. Constructed exactly as better-sqlite3's is -- `new Database(path)` or
 * `new Database(path, { readonly: true, fileMustExist: true })` -- so the two call sites that build
 * one needed no change beyond the import.
 */
export default class Database implements SqliteDatabase {
  #db: NodeDatabaseSync
  #path: string
  #readonly: boolean
  #savepoints = 0

  constructor(dbPath: string, options: SqliteOptions = {}) {
    // better-sqlite3 refuses to create a missing file under either flag; node:sqlite refuses under readOnly but would happily create one under fileMustExist alone. Checked here so the two behave the same, and phrased the way SQLite itself phrases it because callers (see openReadonlySqlite in sqlite_query.ts) wrap this message rather than inspect it.
    const wantsExisting = options.readonly === true || options.fileMustExist === true
    if (wantsExisting && dbPath !== ':memory:' && !fs.existsSync(dbPath)) {
      throw new Error('unable to open database file')
    }
    this.#db = attempt(() => new DatabaseSync(dbPath, {
      readOnly: options.readonly === true,
      // sqlite-vec is loaded through db.loadExtension by initConnection, which node:sqlite refuses unless the connection opted in at construction. Harmless when no extension is ever loaded.
      allowExtension: true,
      // better-sqlite3 opens every connection with busy_timeout at 5000ms; node:sqlite opens at 0, so a connection that named no timeout would silently go from five seconds of patience to none. db.ts overrides this to 15000 in initConnection, but sqlite_query.ts opens a user's arbitrary database readonly and takes whatever the default is -- which would have turned ordinary contention with another writer into an immediate "database is locked".
      timeout: options.timeout ?? 5000,
    }))
    this.#path = dbPath
    this.#readonly = options.readonly === true
  }

  get open(): boolean {
    return this.#db.isOpen
  }

  get inTransaction(): boolean {
    return this.#db.isTransaction
  }

  get readonly(): boolean {
    return this.#readonly
  }

  get name(): string {
    return this.#path
  }

  prepare(sql: string): SqliteStatement {
    return new Statement(attempt(() => this.#db.prepare(sql)))
  }

  exec(sql: string): void {
    attempt(() => this.#db.exec(sql))
  }

  pragma(source: string, options: { simple?: boolean } = {}): unknown {
    const rows = attempt(() => this.#db.prepare(`PRAGMA ${source}`).all()) as Array<Record<string, unknown>>
    if (options.simple !== true) return rows
    const first = rows[0]
    if (first === undefined) return undefined
    const values = Object.values(first)
    return values.length === 0 ? undefined : values[0]
  }

  function(name: string, options: { deterministic?: boolean }, fn: (...args: never[]) => unknown): void {
    attempt(() => this.#db.function(name, options, fn))
  }

  loadExtension(extensionPath: string): void {
    attempt(() => this.#db.loadExtension(extensionPath))
  }

  close(): void {
    attempt(() => this.#db.close())
  }

  /**
   * Wrap `fn` so it runs inside a transaction, committing on return and rolling back on throw.
   *
   * Nesting uses SAVEPOINT, which is what makes it safe for a transactional helper to call another
   * one: an inner `BEGIN` would throw ("cannot start a transaction within a transaction"), an inner
   * SAVEPOINT composes. Whether we are nested is read from SQLite via `isTransaction` rather than
   * tracked in a counter here, so a transaction some other code path opened still nests correctly.
   *
   * The rollback is best-effort and never replaces the caller's error: if the ROLLBACK itself fails
   * -- the connection died, the transaction was already unwound -- the original failure is still
   * what propagates, because that is the one that explains what went wrong.
   */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): SqliteTransaction<A, R> {
    const build =
      (beginSql: string) =>
      (...args: A): R => {
        if (this.#db.isTransaction) {
          const name = `tg_sp_${this.#savepoints++}`
          attempt(() => this.#db.exec(`SAVEPOINT ${name}`))
          try {
            const result = fn(...args)
            attempt(() => this.#db.exec(`RELEASE ${name}`))
            return result
          } catch (e) {
            try {
              attempt(() => this.#db.exec(`ROLLBACK TO ${name}`))
              attempt(() => this.#db.exec(`RELEASE ${name}`))
            } catch {
              // Best-effort; the caller's error below is the one that matters.
            }
            throw e
          }
        }
        attempt(() => this.#db.exec(beginSql))
        try {
          const result = fn(...args)
          attempt(() => this.#db.exec('COMMIT'))
          return result
        } catch (e) {
          try {
            attempt(() => this.#db.exec('ROLLBACK'))
          } catch {
            // Best-effort; see above.
          }
          throw e
        }
      }

    const wrapped = build('BEGIN') as SqliteTransaction<A, R>
    wrapped.default = wrapped
    wrapped.deferred = build('BEGIN')
    wrapped.immediate = build('BEGIN IMMEDIATE')
    wrapped.exclusive = build('BEGIN EXCLUSIVE')
    return wrapped
  }
}
