/** Regression for recordStat's silent catch when the failure is the storage itself, not a stubbed seam above it: `src/stats.ts::recordStat` ends in a bare `catch { }`, so a write that fails because `global.db` is genuinely locked is recorded nowhere -- no stat (it is the write to the stats table that failed), no log, nothing. On current main, holding `BEGIN EXCLUSIVE` on a real `global.db` from a second connection and calling `recordStat` from the first reproduces this: the call returns normally (never blocking the hook path, which is correct and must not change), but the row never lands and nothing anywhere says so. The lock here is a real held write lock via a second `Database` connection (mirrors tests/index_reclaim.test.ts's own `BEGIN EXCLUSIVE` regression, the only other place in this suite that reproduces a genuinely locked database rather than an injected throw), not a mocked `db.prepare` that throws -- an injected throw proves the catch runs, never that a record of the failure survives a database that cannot accept writes at all, which is what shipped without a test. Provenance: HAND-DERIVED. The lock, the throttle window, and the expected log line are computed from recordStat/recordStatWriteFailure's real behavior against a real sqlite lock, not read off stats.ts's own source. */
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
import { RESIDENT_TAIL_MAX_BYTES } from '../src/resident_context.js'
import { getGlobalDb, readStatsWriteFailures, recordStat, statsWriteFailuresLine } from '../src/stats.js'

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
    // Applies the stats schema and creates the file before the lock lands, so the lock below is the only thing standing between recordStat and a table that already exists.
    getGlobalDb()
    // No busy_timeout override needed here: recordStat now writes through its own short-budget connection rather than this cached one (see stats.ts's STATS_WRITE_BUSY_TIMEOUT_MS), so this observes the real shipped behavior directly. tests/stats_write_fails_fast_under_contention.test.ts additionally asserts the elapsed time this test does not.

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

    const blocker = new Database(dbPath)
    blocker.pragma('busy_timeout = 0')
    blocker.exec('BEGIN EXCLUSIVE')
    try {
      recordStat('read_replacement', 0, 0, undefined, 'first')
      expect(readLogLines(_testDataDir), 'first failure must be recorded').toHaveLength(1)

      recordStat('known_root_record_failed', 0, 0, undefined, 'second, same window')
      expect(readLogLines(_testDataDir), 'a second failure inside the window must not append').toHaveLength(1)

      // Backdate the throttle marker past the window -- the same technique tests/config.test.ts and tests/bash_output_cache.test.ts use to simulate elapsed time without a real sleep.
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

describe('the write-failure log stays within the window readStatsWriteFailures reads', () => {
  // Provenance: HAND-DERIVED. Fill lines are written here, one per record, in the shape recordStatWriteFailure appends; sizes are computed from RESIDENT_TAIL_MAX_BYTES, not read off stats.ts's trim logic.
  function fillLine(n: number): string {
    return `2026-01-01T00:00:00.000Z recordStat write failed for kind=fill${n}: busy`
  }

  function seedLog(dir: string, bytes: number): void {
    const lines: string[] = []
    let size = 0
    for (let n = 0; size < bytes; n++) {
      const line = fillLine(n)
      lines.push(line)
      size += Buffer.byteLength(line) + 1
    }
    fs.writeFileSync(statsLogPath(dir), lines.join('\n') + '\n')
  }

  function failOnce(kind: string): void {
    const dbPath = path.join(_testDataDir, 'global.db')
    getGlobalDb()
    const blocker = new Database(dbPath)
    blocker.pragma('busy_timeout = 0')
    blocker.exec('BEGIN EXCLUSIVE')
    try {
      recordStat(kind, 0, 0, undefined, 'lost')
    } finally {
      blocker.exec('ROLLBACK')
      blocker.close()
    }
  }

  it('shrinks a log over the bound to at most the bound after one more failure, keeping the newest line', () => {
    seedLog(_testDataDir, RESIDENT_TAIL_MAX_BYTES + 4096)
    expect(fs.statSync(statsLogPath(_testDataDir)).size).toBeGreaterThan(RESIDENT_TAIL_MAX_BYTES)

    failOnce('newest_kind')

    expect(fs.statSync(statsLogPath(_testDataDir)).size).toBeLessThanOrEqual(RESIDENT_TAIL_MAX_BYTES)
    const lines = readLogLines(_testDataDir)
    expect(lines[lines.length - 1]).toContain('newest_kind')
    for (const line of lines) expect(line, 'a trim must cut on a line boundary').toMatch(/^\d{4}-\d{2}-\d{2}T\S+ recordStat write failed for kind=\S+: /)
  })

  // The rewrite leaves a log under the bound, so the reader's own window no longer shows that lines were dropped: the count and its "at least" label must survive the rewrite, or a trimmed log prints as an exact total.
  it('a log rewritten to fit the bound still reads as a floor, and says "at least"', () => {
    seedLog(_testDataDir, RESIDENT_TAIL_MAX_BYTES + 4096)

    failOnce('newest_kind')

    const failures = readStatsWriteFailures()
    expect(failures?.count_is_lower_bound).toBe(true)
    expect(statsWriteFailuresLine(failures!)).toContain('at least ')
    expect(failures?.latest_reason).toBe(readLogLines(_testDataDir).pop()?.replace(/^\S+ recordStat write failed for kind=\S+: /, ''))
  })

  it('a rewrite keeps exactly one dropped-lines marker, even over an older one inside the kept tail, and the marker is not counted as a failure', () => {
    // An earlier rewrite's marker sits mid-file here, well inside the newest window, so the next rewrite would keep it unless it drops it.
    const marker = '2026-01-01T00:00:00.000Z recordStat write failed for kind=stats_log_trimmed: earlier lines were dropped'
    const half = Array.from({ length: 5000 }, (_, n) => fillLine(n))
    const body = [...half, marker, ...half, ...Array.from({ length: 5000 }, (_, n) => fillLine(n))]
    fs.writeFileSync(statsLogPath(_testDataDir), body.join('\n') + '\n')
    expect(fs.statSync(statsLogPath(_testDataDir)).size).toBeGreaterThan(RESIDENT_TAIL_MAX_BYTES)

    failOnce('second_kind')

    const lines = readLogLines(_testDataDir)
    expect(lines.filter((l) => l.includes('kind=stats_log_trimmed'))).toHaveLength(1)
    expect(lines[0]).toContain('kind=stats_log_trimmed')
    expect(lines[lines.length - 1]).toContain('second_kind')
    expect(fs.statSync(statsLogPath(_testDataDir)).size).toBeLessThanOrEqual(RESIDENT_TAIL_MAX_BYTES)
    const failures = readStatsWriteFailures()
    expect(failures?.count).toBe(lines.length - 1)
    expect(failures?.count_is_lower_bound).toBe(true)
  })

  it('a log that was never trimmed is an exact count, with no "at least"', () => {
    seedLog(_testDataDir, 1024)
    const seeded = readLogLines(_testDataDir).length

    failOnce('appended_kind')

    const failures = readStatsWriteFailures()
    expect(failures?.count).toBe(seeded + 1)
    expect(failures?.count_is_lower_bound).toBe(false)
    expect(statsWriteFailuresLine(failures!)).not.toContain('at least')
  })

  it('appends without rewriting a log that is still inside the bound', () => {
    seedLog(_testDataDir, 1024)
    const before = readLogLines(_testDataDir)

    failOnce('appended_kind')

    const after = readLogLines(_testDataDir)
    expect(after.slice(0, before.length)).toEqual(before)
    expect(after).toHaveLength(before.length + 1)
    expect(after[after.length - 1]).toContain('appended_kind')
  })
})
