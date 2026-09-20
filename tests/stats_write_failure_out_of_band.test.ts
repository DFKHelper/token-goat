/**
 * Regression for recordStat's silent catch when the failure is the storage itself, not a stubbed
 * seam above it: `src/stats.ts::recordStat` ends in a bare `catch { }`, so a write that fails
 * because `global.db` is genuinely locked is recorded nowhere -- no stat (it is the write to the
 * stats table that failed), no log, nothing. On current main, holding `BEGIN EXCLUSIVE` on a real
 * `global.db` from a second connection and calling `recordStat` from the first reproduces this:
 * the call returns normally (never blocking the hook path, which is correct and must not change),
 * but the row never lands and nothing anywhere says so.
 *
 * The lock here is a real held write lock via a second `Database` connection (mirrors
 * tests/index_reclaim.test.ts's own `BEGIN EXCLUSIVE` regression, the only other place in this
 * suite that reproduces a genuinely locked database rather than an injected throw), not a mocked
 * `db.prepare` that throws -- an injected throw proves the catch runs, never that a record of the
 * failure survives a database that cannot accept writes at all, which is what shipped without a test.
 *
 * Provenance: HAND-DERIVED. The lock, the throttle window, and the expected log line are computed
 * from recordStat/recordStatWriteFailure's real behavior against a real sqlite lock, not read off
 * stats.ts's own source.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let _testDataDir: string

vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    dataDir: () => _testDataDir,
  }
})

import Database from '../src/sqlite_driver.js'
import { closeAllDbs, getDb } from '../src/db.js'
import { clearModuleCaches } from '../src/reset.js'
import { getGlobalDb, recordStat } from '../src/stats.js'

const STATS_WRITE_FAILURE_LOG_MIN_INTERVAL_MS = 60 * 1000

function statsLogPath(dir: string): string {
  return path.join(dir, 'stats-write-failed.log')
}

function statsMarkerPath(dir: string): string {
  return path.join(dir, 'stats-write-failed.marker')
}

function readLogLines(dir: string): string[] {
  try {
    return fs.readFileSync(statsLogPath(dir), 'utf8').split('\n').filter((l) => l.length > 0)
  } catch {
    return []
  }
}

beforeEach(() => {
  clearModuleCaches()
  _testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-stats-write-fail-'))
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(_testDataDir, { recursive: true, force: true })
})

describe('recordStat when the write to global.db itself fails', () => {
  it('returns normally and appends the kind and error to an out-of-band log, not the failing database', () => {
    const dbPath = path.join(_testDataDir, 'global.db')
    // Applies the stats schema and creates the file before the lock lands, so the lock below is
    // the only thing standing between recordStat and a table that already exists.
    getGlobalDb()
    // Shortens the busy_timeout on the cached handle recordStat reuses, so the real 15s db.ts
    // wait (see db.ts's busy_timeout comment) is not what this test sits through.
    getDb(dbPath).pragma('busy_timeout = 100')

    const blocker = new Database(dbPath)
    blocker.pragma('busy_timeout = 0')
    blocker.exec('BEGIN EXCLUSIVE')
    try {
      const before = (getDb(dbPath).prepare('SELECT COUNT(*) AS n FROM stats').get() as { n: number }).n

      let threw: unknown
      try {
        recordStat('read_replacement', 10, 20, undefined, 'a lost measurement')
      } catch (e) {
        threw = e
      }
      expect(threw, 'recordStat must never let the write failure reach its caller').toBeUndefined()

      // Still lost: this is the defect the out-of-band log exists to make visible, not to fix.
      expect((getDb(dbPath).prepare('SELECT COUNT(*) AS n FROM stats').get() as { n: number }).n).toBe(before)

      const lines = readLogLines(_testDataDir)
      expect(lines, 'the out-of-band log, not the database, must record the failure').toHaveLength(1)
      expect(lines[0]).toContain('read_replacement')
      expect(lines[0]).toMatch(/locked|busy/i)
    } finally {
      blocker.exec('ROLLBACK')
      blocker.close()
    }
  })

  it('throttles a second failure inside the window and accepts one outside it', () => {
    const dbPath = path.join(_testDataDir, 'global.db')
    getGlobalDb()
    getDb(dbPath).pragma('busy_timeout = 100')

    const blocker = new Database(dbPath)
    blocker.pragma('busy_timeout = 0')
    blocker.exec('BEGIN EXCLUSIVE')
    try {
      recordStat('read_replacement', 0, 0, undefined, 'first')
      expect(readLogLines(_testDataDir), 'first failure must be recorded').toHaveLength(1)

      recordStat('known_root_record_failed', 0, 0, undefined, 'second, same window')
      expect(readLogLines(_testDataDir), 'a second failure inside the window must not append').toHaveLength(1)

      // Backdate the throttle marker past the window -- the same technique tests/config.test.ts
      // and tests/bash_output_cache.test.ts use to simulate elapsed time without a real sleep.
      const past = new Date(Date.now() - STATS_WRITE_FAILURE_LOG_MIN_INTERVAL_MS - 1000)
      fs.utimesSync(statsMarkerPath(_testDataDir), past, past)

      recordStat('reconcile_note_failed', 0, 0, undefined, 'third, outside the window')
      const lines = readLogLines(_testDataDir)
      expect(lines, 'a failure outside the window must be recorded').toHaveLength(2)
      expect(lines[1]).toContain('reconcile_note_failed')
    } finally {
      blocker.exec('ROLLBACK')
      blocker.close()
    }
  })
})
