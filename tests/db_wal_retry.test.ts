/**
 * The WAL conversion must wait out a database another process is busy with.
 *
 * SQLite answers `SQLITE_BUSY` for a journal-mode conversion **without consulting the busy
 * handler**, so `busy_timeout` -- which every other lock wait in this codebase relies on -- does
 * nothing for it. On a database that does not exist yet, where every process racing to create it
 * runs the conversion, the losers therefore used to throw `database is locked` straight out of
 * `getDb`. Reproduced with six processes indexing one new database under load: one lost, threw from
 * that pragma, and dropped the file it was indexing while the run still exited 0.
 *
 * Why this is a unit test over a stub connection rather than several real processes: the failure
 * needs the conversion itself contended, and no arrangement of real processes produces that on
 * demand. An existing database file blocks the *open* instead, where `busy_timeout` does apply and
 * absorbs the wait, so the pre-fix and fixed code behave identically. Two such arrangements were
 * built and measured, and both passed on the pre-fix code. Only the genuine cold-start collision
 * reaches the pragma, and its window is microseconds wide: even with all six workers released from
 * one barrier, tests/index_concurrent_write_race.test.ts caught the defect in two runs out of five.
 * That test is kept for what it does cover -- the whole real path, end to end -- while the retrying
 * itself is pinned here, where every branch is reachable on purpose.
 *
 * The stub is not standing in for a dependency the shipping path omits: `initConnection` calls this
 * same function with a real connection, and it is the only place in `src/db.ts` that sets the
 * journal mode, which the last case here enforces.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { enableWalWithRetry } from '../src/db.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DB_SOURCE = path.join(HERE, '..', 'src', 'db.ts')

/** A connection whose journal-mode conversion is refused the first `refusals` times. */
function stubConn(opts: { refusals: number; modeWhileRefusing?: string }): {
  pragma: (sql: string, o?: { simple?: boolean }) => unknown
  attempts: () => number
} {
  let attempts = 0
  let mode = 'delete'
  return {
    pragma(sql: string): unknown {
      if (sql.includes('=')) {
        attempts += 1
        if (attempts <= opts.refusals) {
          if (opts.modeWhileRefusing !== undefined) mode = opts.modeWhileRefusing
          throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
        }
        mode = 'wal'
        return mode
      }
      return mode
    },
    attempts: () => attempts,
  }
}

describe('enableWalWithRetry', () => {
  it('retries a refused conversion instead of throwing on the first refusal', () => {
    const conn = stubConn({ refusals: 3 })
    expect(() => enableWalWithRetry(conn)).not.toThrow()
    // The count, not just the absence of a throw: a version that swallowed the error and returned
    // would leave the database in rollback-journal mode and pass a "did not throw" check.
    expect(conn.attempts()).toBe(4)
  })

  it('stops as soon as another process has done the conversion, without converting itself', () => {
    // The losing process has nothing to fix: whoever won the race did the work it wanted done.
    // Here every conversion attempt is refused forever, but the mode reads back as `wal` after the
    // first, so this must return rather than spend its whole deadline retrying.
    const conn = stubConn({ refusals: Number.MAX_SAFE_INTEGER, modeWhileRefusing: 'wal' })
    const started = Date.now()
    expect(() => enableWalWithRetry(conn)).not.toThrow()
    expect(conn.attempts()).toBe(1)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('gives up eventually, reporting the underlying refusal rather than a bare timeout', () => {
    // A database that is genuinely unwritable -- a permission or filesystem problem -- must not be
    // retried silently forever, and the reason must survive into the message so it is not read as
    // ordinary contention. Deadline reached by a clock the loop cannot see moving backwards, so
    // this asserts the branch by pointing the loop at a connection that never succeeds and never
    // reports `wal`.
    const conn = {
      pragma(sql: string): unknown {
        if (sql.includes('=')) throw Object.assign(new Error('attempt to write a readonly database'), { code: 'SQLITE_READONLY' })
        return 'delete'
      },
    }
    const started = Date.now()
    // A short budget so this costs a fraction of a second instead of the production fifteen; the
    // branch reached is the same one, and the default is what every real caller gets.
    expect(() => enableWalWithRetry(conn, 250)).toThrow(/failed to enable WAL mode.*readonly/)
    // It really waited rather than failing fast, which is what separates this from the old code.
    expect(Date.now() - started).toBeGreaterThanOrEqual(200)
  })

  it('is the only place the journal mode is set, so a raw pragma cannot creep back in', () => {
    // The defect was a bare `pragma('journal_mode = WAL')` with no retry. Nothing about the tests
    // above would notice one being added back somewhere else in this file, and the real path is
    // only reachable through a race, so the structure is pinned directly.
    const source = fs.readFileSync(DB_SOURCE, 'utf-8')
    const setters = source.match(/pragma\(\s*['"`]journal_mode\s*=/g) ?? []
    expect(setters).toHaveLength(1)
    const helperStart = source.indexOf('export function enableWalWithRetry')
    expect(helperStart).toBeGreaterThan(-1)
    expect(source.indexOf(setters[0] ?? '')).toBeGreaterThan(helperStart)
  })
})
