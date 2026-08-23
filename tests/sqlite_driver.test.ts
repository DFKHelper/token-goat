/**
 * `src/sqlite_driver.ts` against better-sqlite3 itself, as a differential oracle.
 *
 * The driver replaced better-sqlite3 as the runtime SQLite binding: it is the same engine reached
 * through `node:sqlite` instead of a native addon, which removes 36 packages, the last deprecated
 * entry, and an install script from every consumer install. Nothing in `src/` imports better-sqlite3
 * any more.
 *
 * The risk that swap creates is not that the driver fails loudly -- the whole suite would go red.
 * It is that the driver agrees with better-sqlite3 on the cases the suite happens to exercise and
 * diverges quietly somewhere else, because three parts of it are reimplementations rather than
 * passthroughs: `pragma()`, `transaction()`, and the `reader` flag. A test written only against the
 * driver would encode whatever the driver does, including its bugs. So the cases below run both
 * libraries over the same input and require the answers to match, which means better-sqlite3 stays
 * as a devDependency -- not shipped to anyone, and earning its place as the reference.
 *
 * `reader` gets the longest list because it is a security check, not a convenience: it is the third
 * defence-in-depth layer in `sqlite_query.ts`'s read-only guard, and it is derived (from the
 * prepared statement's column count) rather than read from SQLite directly.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import Reference from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import Database, { sqliteResultCodeName, suppressSqliteExperimentalWarning } from '../src/sqlite_driver.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-driver-'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
})

/**
 * The two handles as one iterable, so a case can be written once and run against both.
 *
 * The reference is cast to the driver's type. TypeScript models the two `transaction()` overloads
 * with mutually incompatible generic signatures, so a plain array of both widens to a union nothing
 * can call -- but "these are interchangeable at every call site in this repository" is precisely the
 * claim the driver makes and this file exists to check. The cast states that claim; the assertions
 * below are what actually test it, at run time, where it matters.
 */
function both(ours: Database, theirs: Reference.Database): Database[] {
  return [ours, theirs as unknown as Database]
}

/** Open one database of each library on its own file, with the same schema. */
function pair(): { ours: Database; theirs: Reference.Database; close: () => void } {
  const ours = new Database(path.join(tmp, 'ours.db'))
  const theirs = new Reference(path.join(tmp, 'theirs.db'))
  for (const db of [ours, theirs]) db.exec('CREATE TABLE t(a INTEGER, b TEXT)')
  return {
    ours,
    theirs,
    close: () => {
      ours.close()
      theirs.close()
    },
  }
}

describe('reader: does this statement produce rows', () => {
  // node:sqlite has no `reader`, so the driver derives it from the prepared statement's column
  // count. Every shape sqlite_query.ts's guard could plausibly meet is listed, including the ones
  // that make the derivation non-obvious: a SELECT matching no rows is still a reader (it has
  // columns, it just returns none), EXPLAIN is a reader, VALUES is a reader, and PRAGMA flips on
  // whether it reads or assigns. If SQLite ever changes one of these, this goes red rather than the
  // read-only guard silently weakening.
  const SHAPES = [
    'SELECT * FROM t',
    'SELECT 1',
    'WITH c AS (SELECT 1 AS x) SELECT x FROM c',
    'VALUES(1)',
    'EXPLAIN SELECT * FROM t',
    'SELECT * FROM t WHERE 0',
    'PRAGMA user_version',
    "INSERT INTO t VALUES(1,'x')",
    'UPDATE t SET a = 1',
    'DELETE FROM t',
    'CREATE TABLE z(q)',
    'PRAGMA user_version = 3',
  ]

  it('agrees with better-sqlite3 on every statement shape', () => {
    const { ours, theirs, close } = pair()
    try {
      for (const sql of SHAPES) {
        expect(ours.prepare(sql).reader, `reader disagreed for: ${sql}`).toBe(theirs.prepare(sql).reader)
      }
    } finally {
      close()
    }
  })

  // Anchors the assertion above. Without this, a driver whose `reader` was hardcoded `true` and a
  // reference that also said `true` everywhere would agree perfectly and prove nothing -- the list
  // has to actually contain both answers for "they match" to mean anything.
  it('and the shape list really contains both answers', () => {
    const { theirs, close } = pair()
    try {
      const verdicts = SHAPES.map((sql) => theirs.prepare(sql).reader)
      expect(verdicts.filter((v) => v === true).length).toBeGreaterThan(0)
      expect(verdicts.filter((v) => v === false).length).toBeGreaterThan(0)
    } finally {
      close()
    }
  })
})

describe('pragma', () => {
  it('returns rows, or the first scalar under { simple: true }, exactly as better-sqlite3 does', () => {
    const { ours, theirs, close } = pair()
    try {
      for (const source of ['user_version', 'journal_mode', 'busy_timeout = 15000', 'synchronous = NORMAL']) {
        expect(ours.pragma(source, { simple: true }), `simple disagreed for: ${source}`).toEqual(
          theirs.pragma(source, { simple: true }),
        )
        expect(ours.pragma(source), `rows disagreed for: ${source}`).toEqual(theirs.pragma(source))
      }
    } finally {
      close()
    }
  })

  it('actually applies an assigning pragma rather than only reporting one', () => {
    // The reimplementation runs `PRAGMA x = y` through prepare().all(), which returns no rows. A
    // version that swallowed the statement instead of executing it would return the same empty
    // result and look identical here -- so the value is read back afterwards.
    const { ours, theirs, close } = pair()
    try {
      for (const db of [ours, theirs]) db.pragma('user_version = 41')
      expect(ours.pragma('user_version', { simple: true })).toBe(41)
      expect(theirs.pragma('user_version', { simple: true })).toBe(41)
    } finally {
      close()
    }
  })

  it('reports an assigning pragma as undefined under { simple: true }', () => {
    const { ours, theirs, close } = pair()
    try {
      expect(ours.pragma('user_version = 7', { simple: true })).toBe(
        theirs.pragma('user_version = 7', { simple: true }),
      )
      expect(ours.pragma('user_version = 7', { simple: true })).toBeUndefined()
    } finally {
      close()
    }
  })
})

describe('transaction', () => {
  it('commits on return and rolls back on throw', () => {
    const { ours, theirs, close } = pair()
    try {
      for (const db of both(ours, theirs)) {
        db.transaction(() => {
          db.prepare("INSERT INTO t VALUES(1,'kept')").run()
        })()
        expect(() =>
          db.transaction(() => {
            db.prepare("INSERT INTO t VALUES(2,'discarded')").run()
            throw new Error('boom')
          })(),
        ).toThrow('boom')
        // Both halves: the commit must have landed AND the rollback must have unwound. Asserting
        // only the count would pass on a driver that committed nothing and rolled back nothing.
        expect(db.prepare('SELECT b FROM t ORDER BY a').pluck().all()).toEqual(['kept'])
      }
    } finally {
      close()
    }
  })

  it('nests, so a transactional helper can call another one', () => {
    // This is the case a naive implementation gets wrong: an inner BEGIN throws "cannot start a
    // transaction within a transaction", so the driver has to use SAVEPOINT when already inside one.
    const { ours, theirs, close } = pair()
    try {
      for (const db of both(ours, theirs)) {
        const inner = db.transaction((label: string) => {
          db.prepare('INSERT INTO t VALUES(?,?)').run(1, label)
        })
        db.transaction(() => {
          inner('a')
          inner('b')
        })()
        expect(db.prepare('SELECT b FROM t ORDER BY b').pluck().all()).toEqual(['a', 'b'])
      }
    } finally {
      close()
    }
  })

  it('rolls the inner savepoint back without losing the outer work', () => {
    const { ours, theirs, close } = pair()
    try {
      for (const db of both(ours, theirs)) {
        const inner = db.transaction((label: string) => {
          db.prepare('INSERT INTO t VALUES(?,?)').run(1, label)
          if (label === 'bad') throw new Error('inner failed')
        })
        db.transaction(() => {
          db.prepare("INSERT INTO t VALUES(0,'outer')").run()
          try {
            inner('bad')
          } catch {
            // Swallowed on purpose: the outer transaction chooses to continue, which is the whole
            // reason savepoints exist. A driver that rolled the entire transaction back here would
            // lose 'outer' and 'after' too.
          }
          db.prepare("INSERT INTO t VALUES(2,'after')").run()
        })()
        expect(db.prepare('SELECT b FROM t ORDER BY a').pluck().all()).toEqual(['outer', 'after'])
      }
    } finally {
      close()
    }
  })

  it('exposes .immediate(), and it takes the write lock up front', () => {
    // Six call sites depend on .immediate() specifically. A driver that defined it as an alias for
    // the deferred form would pass every other test in this file: the difference only shows under
    // concurrency, where a deferred BEGIN takes the write lock late and can fail mid-transaction. So
    // it is checked against SQLite's own view -- a second connection must be locked out while the
    // immediate transaction is open, before that transaction has written anything.
    const dbPath = path.join(tmp, 'lock.db')
    const writer = new Database(dbPath)
    writer.exec('CREATE TABLE t(a)')
    const other = new Database(dbPath, { timeout: 1 })
    try {
      let observed: string | null = null
      writer.transaction(() => {
        try {
          other.prepare('INSERT INTO t VALUES(1)').run()
          observed = 'not locked'
        } catch (e) {
          observed = e instanceof Error ? e.message : String(e)
        }
      }).immediate()
      expect(observed, 'a second writer must be refused while an IMMEDIATE transaction is open').toMatch(
        /locked|busy/i,
      )
    } finally {
      writer.close()
      other.close()
    }
  })
})

describe('statement surface', () => {
  it('pluck returns the leftmost column for get, all and iterate', () => {
    const { ours, theirs, close } = pair()
    try {
      for (const db of [ours, theirs]) db.exec("INSERT INTO t VALUES(1,'x'),(2,'y')")
      for (const [label, db] of [
        ['ours', ours],
        ['theirs', theirs],
      ] as const) {
        expect(db.prepare('SELECT a, b FROM t ORDER BY a').pluck().all(), label).toEqual([1, 2])
        expect(db.prepare('SELECT b, a FROM t ORDER BY a').pluck().get(), label).toBe('x')
        expect([...db.prepare('SELECT a FROM t ORDER BY a').pluck().iterate()], label).toEqual([1, 2])
        // A plucked query that matches nothing is undefined, not null and not an empty object.
        expect(db.prepare('SELECT a FROM t WHERE a = 99').pluck().get(), label).toBeUndefined()
      }
    } finally {
      close()
    }
  })

  // 2^53 + 1: the smallest integer a JS double cannot represent.
  const BIG = 9007199254740993n

  it('safeIntegers reads a value past 2^53 exactly, on both libraries', () => {
    // The reason sqlite_query.ts turns this on for arbitrary user databases: without it a 64-bit
    // INTEGER beyond Number.MAX_SAFE_INTEGER does not survive the trip out.
    const { ours, theirs, close } = pair()
    try {
      for (const db of both(ours, theirs)) {
        db.prepare('INSERT INTO t VALUES(?, NULL)').run(BIG)
        expect(db.prepare('SELECT a FROM t').safeIntegers(true).pluck().get()).toBe(BIG)
      }
    } finally {
      close()
    }
  })

  it('differs from better-sqlite3 by default: it throws where better-sqlite3 silently rounds', () => {
    // The one behavioural difference between the two libraries that this repository accepts rather
    // than papers over, so it is pinned here instead of left to be discovered.
    //
    // Without safeIntegers, better-sqlite3 hands back the nearest double -- 9007199254740992 for
    // the value 9007199254740993, wrong by one, with no error. node:sqlite refuses. Reproducing the
    // rounding would mean building silent data corruption on purpose, and sqlite_query.ts's own
    // module doc already calls that behaviour out as the thing it has to defend against, so the
    // refusal is kept.
    //
    // It is safe to keep because no production read can reach it. Only two paths touch a database
    // this repository did not write: `sqlite-query`, which sets safeIntegers(true) and normalises
    // every value through normalizeSqliteScalar, and `sqlite-schema`, which reads PRAGMA metadata
    // and COUNT(*) -- a row count above 2^53 is not a database anyone has. Every other read is
    // against token-goat's own schema, whose integers are line numbers, byte sizes, counts and
    // millisecond timestamps.
    const { ours, theirs, close } = pair()
    try {
      for (const db of both(ours, theirs)) db.prepare('INSERT INTO t VALUES(?, NULL)').run(BIG)
      expect(() => ours.prepare('SELECT a FROM t').pluck().get()).toThrow(/too large/i)
      expect(theirs.prepare('SELECT a FROM t').pluck().get()).toBe(9007199254740992)
    } finally {
      close()
    }
  })

  it('reads an in-range integer as a plain number, which every other query relies on', () => {
    const { ours, theirs, close } = pair()
    try {
      for (const db of both(ours, theirs)) {
        db.prepare('INSERT INTO t VALUES(?, NULL)').run(1234567890)
        expect(typeof db.prepare('SELECT a FROM t').pluck().get()).toBe('number')
        expect(db.prepare('SELECT a FROM t').pluck().get()).toBe(1234567890)
      }
    } finally {
      close()
    }
  })

  it('columns reports the result names, including an alias', () => {
    const { ours, theirs, close } = pair()
    try {
      const sql = 'SELECT a AS renamed, b FROM t'
      expect(ours.prepare(sql).columns().map((c) => c.name)).toEqual(
        theirs.prepare(sql).columns().map((c) => c.name),
      )
      expect(ours.prepare(sql).columns().map((c) => c.name)).toEqual(['renamed', 'b'])
    } finally {
      close()
    }
  })

  it('run reports changes and lastInsertRowid as plain numbers', () => {
    const { ours, theirs, close } = pair()
    try {
      for (const [label, db] of [
        ['ours', ours],
        ['theirs', theirs],
      ] as const) {
        const r = db.prepare("INSERT INTO t VALUES(NULL,'x')").run()
        expect(r.changes, label).toBe(1)
        expect(typeof r.lastInsertRowid, label).toBe('number')
      }
    } finally {
      close()
    }
  })

  it('registers a custom SQL function, which pathEqClause depends on', () => {
    const { ours, theirs, close } = pair()
    try {
      for (const [label, db] of [
        ['ours', ours],
        ['theirs', theirs],
      ] as const) {
        db.function('TG_UPPER', { deterministic: true }, (v: unknown) => String(v).toUpperCase())
        expect(db.prepare("SELECT TG_UPPER('mixedCase') AS v").pluck().get(), label).toBe('MIXEDCASE')
      }
    } finally {
      close()
    }
  })
})

describe('connection options', () => {
  it('refuses a missing file under readonly or fileMustExist, the same way better-sqlite3 does', () => {
    const missing = path.join(tmp, 'nope.db')
    for (const options of [{ readonly: true }, { fileMustExist: true }]) {
      expect(() => new Database(missing, options), JSON.stringify(options)).toThrow(/unable to open/i)
      expect(() => new Reference(missing, options), JSON.stringify(options)).toThrow(/unable to open/i)
      // The refusal must be a refusal, not a create-then-fail: a stray file here would leave the
      // next open succeeding against an empty database.
      expect(fs.existsSync(missing), 'no file may be created').toBe(false)
    }
  })

  it('opens readonly, reports it, and rejects a write at the engine level', () => {
    const dbPath = path.join(tmp, 'ro.db')
    const seed = new Database(dbPath)
    seed.exec("CREATE TABLE t(a); INSERT INTO t VALUES(1)")
    seed.close()
    const ro = new Database(dbPath, { readonly: true, fileMustExist: true })
    try {
      expect(ro.readonly).toBe(true)
      expect(ro.prepare('SELECT a FROM t').pluck().get()).toBe(1)
      expect(() => ro.prepare('INSERT INTO t VALUES(2)').run()).toThrow(/readonly|read.only/i)
    } finally {
      ro.close()
    }
  })

  it('reports open and inTransaction', () => {
    const { ours, theirs, close } = pair()
    try {
      for (const [i, db] of both(ours, theirs).entries()) {
        const label = i === 0 ? 'ours' : 'theirs'
        expect(db.open, label).toBe(true)
        expect(db.inTransaction, label).toBe(false)
        db.transaction(() => {
          expect(db.inTransaction, `${label} inside`).toBe(true)
        })()
        expect(db.inTransaction, `${label} after`).toBe(false)
      }
    } finally {
      close()
    }
  })

  it('reports open as false once closed', () => {
    const db = new Database(':memory:')
    db.close()
    expect(db.open).toBe(false)
  })
})

describe('the ExperimentalWarning filter', () => {
  it('swallows the SQLite experimental warning and nothing else', () => {
    const seen: string[] = []
    const listener = (w: Error): void => {
      seen.push(`${w.name}: ${w.message}`)
    }
    process.on('warning', listener)
    const restore = suppressSqliteExperimentalWarning()
    try {
      const mk = (name: string, message: string): Error => Object.assign(new Error(message), { name })
      // process.emitWarning defers to nextTick, so these are emitted directly to keep the test
      // synchronous -- the filter sits on process.emit, which is what nextTick would call anyway.
      process.emit('warning', mk('ExperimentalWarning', 'SQLite is an experimental feature'))
      process.emit('warning', mk('DeprecationWarning', 'something genuinely deprecated'))
      process.emit('warning', mk('ExperimentalWarning', 'some unrelated experimental feature'))
    } finally {
      restore()
      process.off('warning', listener)
    }

    // All three assertions matter. A filter that ate everything would satisfy the first alone, and
    // one that ate nothing would satisfy the last two.
    expect(seen.join('\n')).not.toContain('SQLite is an experimental feature')
    expect(seen.join('\n')).toContain('something genuinely deprecated')
    expect(seen.join('\n')).toContain('some unrelated experimental feature')
  })

  it('leaves the built binary printing no experimental warning at all', () => {
    // The end of the chain the unit test above only covers in pieces: the real bundle, spawned the
    // way a user or a hook spawns it, must produce a clean stderr. This is the property that
    // actually matters -- token-goat runs as a PreToolUse hook on every Read, Grep, Glob and
    // WebFetch, so one unconditional stderr line per invocation would be printed constantly.
    const bundle = path.join(repoRoot, 'dist', 'token-goat.mjs')
    const r = spawnSync(process.execPath, [bundle, '--version'], { encoding: 'utf8' })
    // Anchors the negative assertion below: a spawn that failed to run at all would print no
    // warning either, and would look exactly like success here.
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim(), 'the command must actually have run').toMatch(/\d+\.\d+\.\d+/)
    expect(r.stderr, 'a hook fires on every Read/Grep/Glob/WebFetch; stderr must stay clean').not.toContain(
      'ExperimentalWarning',
    )
  })
})

describe('defaults a caller never names', () => {
  // The class of bug that hides here: an option nobody passes, whose default the two libraries
  // disagree about. Nothing in the port mentions busy_timeout, so nothing would have failed --
  // sqlite_query.ts opens a user's database readonly with no timeout argument, and would have gone
  // from better-sqlite3's five seconds of patience to none the moment another process held a lock.
  it('opens with the same busy_timeout better-sqlite3 opens with', () => {
    const { ours, theirs, close } = pair()
    try {
      expect(ours.pragma('busy_timeout', { simple: true })).toBe(
        (theirs.pragma('busy_timeout', { simple: true }) as number),
      )
      // Anchor: the shared answer is the real 5000, not two connections that both happen to say 0.
      expect(ours.pragma('busy_timeout', { simple: true })).toBe(5000)
    } finally {
      close()
    }
  })

  it('still lets an explicit timeout win over that default', () => {
    const db = new Database(path.join(tmp, 'explicit.db'), { timeout: 250 })
    try {
      expect(db.pragma('busy_timeout', { simple: true })).toBe(250)
    } finally {
      db.close()
    }
  })
})

describe('error result codes', () => {
  // The divergence that made this section necessary. better-sqlite3 puts the SQLite result code's
  // name in `err.code`; node:sqlite puts a generic `ERR_SQLITE_ERROR` there and the number in
  // `err.errcode`. index_reclaim.ts branches on the name to tell a lock it should wait out from an
  // error it must rethrow, so an untranslated code turned a deferred VACUUM into a crash. These are
  // differential rather than hard-coded: whatever better-sqlite3 answers is the expected answer.
  const FAILURES: { name: string; setup: string; boom: string }[] = [
    { name: 'a primary-key collision', setup: 'CREATE TABLE p(x INTEGER PRIMARY KEY); INSERT INTO p VALUES(1)', boom: 'INSERT INTO p VALUES(1)' },
    { name: 'a NOT NULL violation', setup: 'CREATE TABLE n(x INTEGER NOT NULL)', boom: 'INSERT INTO n VALUES(NULL)' },
    { name: 'a UNIQUE violation', setup: 'CREATE TABLE u(x TEXT UNIQUE); INSERT INTO u VALUES(\'a\')', boom: 'INSERT INTO u VALUES(\'a\')' },
    { name: 'a CHECK violation', setup: 'CREATE TABLE c(x INTEGER CHECK(x > 0))', boom: 'INSERT INTO c VALUES(-1)' },
    { name: 'a missing table', setup: 'SELECT 1', boom: 'SELECT * FROM nope' },
    { name: 'a syntax error', setup: 'SELECT 1', boom: 'SELEKT 1' },
  ]

  it.each(FAILURES)('reports $name under the same code better-sqlite3 reports', ({ setup, boom }) => {
    const { ours, theirs, close } = pair()
    try {
      for (const db of both(ours, theirs)) db.exec(setup)
      const codeOf = (fn: () => unknown): unknown => {
        try {
          fn()
        } catch (e) {
          return (e as { code?: unknown }).code
        }
        return 'DID_NOT_THROW'
      }
      const expected = codeOf(() => theirs.exec(boom))
      // Anchor: a test that compared two `undefined`s, or two "never threw" sentinels, would pass
      // while proving nothing. The reference must have produced a real SQLite code first.
      expect(String(expected)).toMatch(/^SQLITE_/)
      expect(codeOf(() => ours.exec(boom))).toBe(expected)
    } finally {
      close()
    }
  })

  it('keeps node:sqlite errcode and errstr alongside the rewritten code', () => {
    // Only `code` is rewritten. The error object, its message and its stack are the ones SQLite and
    // Node produced, and the raw numeric pair stays readable by anything that wants it.
    const { ours, close } = pair()
    try {
      ours.exec('CREATE TABLE p(x INTEGER PRIMARY KEY)')
      ours.exec('INSERT INTO p VALUES(1)')
      let caught: { code?: unknown; errcode?: unknown; errstr?: unknown; message?: string } = {}
      try {
        ours.exec('INSERT INTO p VALUES(1)')
      } catch (e) {
        caught = e as typeof caught
      }
      expect(caught.code).toBe('SQLITE_CONSTRAINT_PRIMARYKEY')
      expect(caught.errcode).toBe(1555)
      expect(caught.errstr).toBe('constraint failed')
      expect(caught.message).toMatch(/constraint/i)
    } finally {
      close()
    }
  })

  it('translates a busy lock, which is the code index_reclaim.ts actually branches on', () => {
    const dbPath = path.join(tmp, 'busy.db')
    const holder = new Database(dbPath)
    holder.exec('CREATE TABLE t(x)')
    const loser = new Database(dbPath, { timeout: 1 })
    holder.exec('BEGIN EXCLUSIVE')
    try {
      let code: unknown
      try {
        loser.exec('INSERT INTO t VALUES(1)')
      } catch (e) {
        code = (e as { code?: unknown }).code
      }
      // The prefix, not the exact string: SQLite may answer SQLITE_BUSY or an extended member of
      // that family, and index_reclaim.ts matches the family by prefix for exactly that reason.
      expect(String(code)).toMatch(/^SQLITE_BUSY/)
    } finally {
      holder.exec('ROLLBACK')
      holder.close()
      loser.close()
    }
  })

  it('translates codes it has never seen thrown, including every extended family', () => {
    // The table is data, and the tests above can only provoke a handful of its rows. This pins the
    // arithmetic (`primary | subcode << 8`), the two-value special cases, the one gap SQLite leaves
    // in the SQLITE_ABORT family, and the fallbacks -- an unknown subcode degrades to the primary
    // name rather than inventing one, and an unknown primary degrades to node's own generic code.
    expect(sqliteResultCodeName(5)).toBe('SQLITE_BUSY')
    expect(sqliteResultCodeName(19)).toBe('SQLITE_CONSTRAINT')
    expect(sqliteResultCodeName(100)).toBe('SQLITE_ROW')
    expect(sqliteResultCodeName(101)).toBe('SQLITE_DONE')
    expect(sqliteResultCodeName(261)).toBe('SQLITE_BUSY_RECOVERY')
    expect(sqliteResultCodeName(517)).toBe('SQLITE_BUSY_SNAPSHOT')
    expect(sqliteResultCodeName(262)).toBe('SQLITE_LOCKED_SHAREDCACHE')
    expect(sqliteResultCodeName(1555)).toBe('SQLITE_CONSTRAINT_PRIMARYKEY')
    expect(sqliteResultCodeName(2067)).toBe('SQLITE_CONSTRAINT_UNIQUE')
    expect(sqliteResultCodeName(8714)).toBe('SQLITE_IOERR_IN_PAGE')
    expect(sqliteResultCodeName(1032)).toBe('SQLITE_READONLY_DBMOVED')
    expect(sqliteResultCodeName(516)).toBe('SQLITE_ABORT_ROLLBACK')
    // SQLITE_ABORT has no subcode 1, so that slot must fall back rather than read the next suffix.
    expect(sqliteResultCodeName(260)).toBe('SQLITE_ABORT')
    expect(sqliteResultCodeName(99 << 8 | 5)).toBe('SQLITE_BUSY')
    expect(sqliteResultCodeName(50)).toBe('ERR_SQLITE_ERROR')
    expect(sqliteResultCodeName(-1)).toBe('ERR_SQLITE_ERROR')
    expect(sqliteResultCodeName(1.5)).toBe('ERR_SQLITE_ERROR')
  })
})
