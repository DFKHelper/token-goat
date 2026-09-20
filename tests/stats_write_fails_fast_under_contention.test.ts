/**
 * Regression for recordStat holding the hook path for the full 15s db.ts busy_timeout instead of
 * failing fast. `initConnection`'s 15000ms budget is right for indexing and the worker, which share
 * one cached connection to global.db and must wait out contention -- see db.ts's busy_timeout
 * comment. recordStat's own contract, stated in its catch, is the opposite: it must never block or
 * slow the hook path. Before this fix recordStat wrote through that same cached, patient connection,
 * so a real held lock cost the hook path the full ~15s wait (see "The defect" in this batch's brief).
 *
 * CAPTURE: fixture methodology (a real second connection holding `BEGIN EXCLUSIVE` on a real scratch
 * global.db, with no busy_timeout override on the connection under test) is lifted from
 * tests/stats_write_failure_out_of_band.test.ts, which this file's provenance line also credits.
 * Unlike that file, this one does NOT shorten the timeout on the shared connection first -- the whole
 * point is to observe the real, shipped budget rather than a test-only override.
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

function statsLogPath(dir: string): string {
  return path.join(dir, 'stats-write-failed.log')
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
  _testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-stats-write-fast-'))
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(_testDataDir, { recursive: true, force: true })
})

describe('recordStat under a real held lock, with the real busy_timeout (no override)', () => {
  it('returns in well under a second instead of sitting through db.ts\'s 15s indexing budget', () => {
    const dbPath = path.join(_testDataDir, 'global.db')
    // Applies the stats schema and creates the file before the lock lands, same as stats_write_failure_out_of_band.test.ts -- the lock below is the only thing standing between recordStat and a table that already exists, and getDb's own busy_timeout is left at its shipped 15000ms so this exercises the real budget, not a test-shortened one.
    getGlobalDb()
    expect(getDb(dbPath).pragma('busy_timeout', { simple: true })).toBe(15000)

    const blocker = new Database(dbPath)
    blocker.pragma('busy_timeout = 0')
    blocker.exec('BEGIN EXCLUSIVE')
    try {
      const before = (getDb(dbPath).prepare('SELECT COUNT(*) AS n FROM stats').get() as { n: number }).n

      const t0 = Date.now()
      let threw: unknown
      try {
        recordStat('read_replacement', 10, 20, undefined, 'a lost measurement')
      } catch (e) {
        threw = e
      }
      const elapsedMs = Date.now() - t0

      expect(threw, 'recordStat must never let the write failure reach its caller').toBeUndefined()
      expect(
        elapsedMs,
        `recordStat took ${elapsedMs}ms under a real held lock -- it must fail fast, not sit through db.ts's 15000ms indexing budget`,
      ).toBeLessThan(1000)

      // Still lost: the out-of-band log exists to make this visible, not to fix it.
      expect((getDb(dbPath).prepare('SELECT COUNT(*) AS n FROM stats').get() as { n: number }).n).toBe(before)

      const lines = readLogLines(_testDataDir)
      expect(lines, 'the out-of-band log, not the database, must record the failure').toHaveLength(1)
      expect(lines[0]).toContain('read_replacement')
      expect(lines[0]).toMatch(/locked|busy/i)
    } finally {
      blocker.exec('ROLLBACK')
      blocker.close()
    }
  }, 20_000)

  it('still lets a normal write through once the lock releases', () => {
    const dbPath = path.join(_testDataDir, 'global.db')
    getGlobalDb()
    const before = (getDb(dbPath).prepare('SELECT COUNT(*) AS n FROM stats').get() as { n: number }).n

    recordStat('read_replacement', 100, 25, undefined, 'no contention')

    const row = getDb(dbPath)
      .prepare('SELECT COUNT(*) AS n, bytes_saved, tokens_saved, detail FROM stats WHERE detail = ?')
      .get('no contention') as { n: number; bytes_saved: number; tokens_saved: number; detail: string }
    expect((getDb(dbPath).prepare('SELECT COUNT(*) AS n FROM stats').get() as { n: number }).n).toBe(before + 1)
    expect(row.bytes_saved).toBe(100)
    expect(row.tokens_saved).toBe(25)
    expect(row.detail).toBe('no contention')
  })
})
