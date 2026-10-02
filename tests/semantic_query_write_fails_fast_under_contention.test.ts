/** Regression for recordSemanticQuery writing through getGlobalDb()'s shared connection, whose 15000ms busy_timeout is the indexer's budget, so a held lock on global.db stalled `semantic` for up to 15s after its results were already computed. CAPTURE: fixture methodology (a real second connection holding `BEGIN EXCLUSIVE` on a real scratch global.db, the shipped busy_timeout left in place) is the one tests/stats_write_fails_fast_under_contention.test.ts uses for recordStat; HAND-DERIVED: the expected row values are the inputs passed in. */
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
import { recordSemanticQuery } from '../src/semantic_distances.js'
import { getGlobalDb } from '../src/stats.js'

function rowCount(dbPath: string): number {
  return (getDb(dbPath).prepare('SELECT COUNT(*) AS n FROM semantic_queries').get() as { n: number }).n
}

beforeEach(() => {
  clearModuleCaches()
  _testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-semq-write-fast-'))
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(_testDataDir, { recursive: true, force: true })
})

describe('recordSemanticQuery under a real held lock, with the real busy_timeout (no override)', () => {
  it('gives up within the telemetry budget instead of waiting out the 15s indexing budget', () => {
    const dbPath = path.join(_testDataDir, 'global.db')
    getGlobalDb()
    expect(getDb(dbPath).pragma('busy_timeout', { simple: true })).toBe(15000)
    const before = rowCount(dbPath)

    const blocker = new Database(dbPath)
    blocker.pragma('busy_timeout = 0')
    blocker.exec('BEGIN EXCLUSIVE')
    let elapsedMs: number
    let threw: unknown
    try {
      const t0 = Date.now()
      try {
        recordSemanticQuery({ projectRoot: _testDataDir, closestDistance: 0.5, floorRejectedMin: null, weak: false })
      } catch (e) {
        threw = e
      }
      elapsedMs = Date.now() - t0
    } finally {
      blocker.exec('ROLLBACK')
      blocker.close()
    }

    expect(threw, 'a failed telemetry write must never reach the query it describes').toBeUndefined()
    // Same 3000ms ceiling, and the same reason, as the recordStat test this mirrors: SQLite's busy handler oversleeps differently per platform, and the shared connection's 15000ms still fails it everywhere.
    expect(elapsedMs, `recordSemanticQuery took ${elapsedMs}ms under a held lock`).toBeLessThan(3000)
    expect(rowCount(dbPath), 'the row is lost, not half-written').toBe(before)
  }, 20_000)

  it('still records the row once the lock is gone', () => {
    const dbPath = path.join(_testDataDir, 'global.db')
    getGlobalDb()
    const before = rowCount(dbPath)

    recordSemanticQuery({ projectRoot: _testDataDir, closestDistance: 0.91, floorRejectedMin: 1.2, weak: true })

    expect(rowCount(dbPath)).toBe(before + 1)
    const row = getDb(dbPath)
      .prepare('SELECT closest_distance, floor_rejected_min, weak FROM semantic_queries ORDER BY rowid DESC LIMIT 1')
      .get() as { closest_distance: number; floor_rejected_min: number; weak: number }
    expect(row).toEqual({ closest_distance: 0.91, floor_rejected_min: 1.2, weak: 1 })
  })
})
