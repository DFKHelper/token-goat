/** `token-goat stats` must say "unknown" when it could not read something, never print a smaller number or a zero that looks measured. Three repros, each on the real read path (a real scratch global.db made unreadable, a real stats-write-failed.log written by the shipping recordStat under a real held lock), none through a mocked reader: (1) `stats_daily_rollup` unreadable, which summarize() swallowed in a bare catch so the totals silently dropped every rolled-up day; (2) recordStat writes that never reached global.db, logged to stats-write-failed.log and read by nothing; (3) `stats --json` on a missing global.db, which printed measured-looking zeros. Each row has a control that stays 0 or unchanged, because a genuinely empty readable source is zero and only a failed read is unknown. Provenance: HAND-DERIVED. The broken rollup table is the T3 repro (a table with no `events` column, so the fold-in's SELECT throws), and the failure log is the shipping producer's own output captured from a held EXCLUSIVE lock, not a restated line. */
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
import { runStats } from '../src/cli_stats.js'
import { closeAllDbs } from '../src/db.js'
import { clearModuleCaches } from '../src/reset.js'
import { getGlobalDb, recordStat } from '../src/stats.js'

function captureOutput(fn: () => void): string {
  const chunks: string[] = []
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    chunks.push(String(c))
    return true
  })
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    chunks.push(args.map(String).join(' ') + '\n')
  })
  try {
    fn()
  } finally {
    out.mockRestore()
    log.mockRestore()
  }
  return chunks.join('')
}

function statsJson(windowDays: number): Record<string, unknown> {
  return JSON.parse(captureOutput(() => runStats({ json: true, windowDays }))) as Record<string, unknown>
}

function seedTwoRows(): void {
  const db = getGlobalDb()
  const now = Math.floor(Date.now() / 1000)
  const insert = db.prepare('INSERT INTO stats (ts, kind, bytes_saved, tokens_saved) VALUES (?, ?, ?, ?)')
  insert.run(now - 60, 'image_shrink', 4000, 1000)
  insert.run(now - 120, 'image_shrink', 2000, 500)
}

/** Makes the next rollup fold-in throw: the table exists (so the fold-in tries it) but lacks the `events` column its SELECT names. */
function breakRollupTable(): void {
  getGlobalDb().exec('DROP TABLE stats_daily_rollup; CREATE TABLE stats_daily_rollup (day TEXT, kind TEXT)')
}

/** Runs the shipping recordStat while a second connection holds the write lock, so recordStatWriteFailure writes its real log line. */
function failOneStatWrite(): void {
  const dbPath = path.join(_testDataDir, 'global.db')
  const blocker = new Database(dbPath)
  blocker.pragma('busy_timeout = 0')
  blocker.exec('BEGIN EXCLUSIVE')
  try {
    recordStat('read_replacement', 10, 20, undefined, 'a lost measurement')
  } finally {
    blocker.exec('ROLLBACK')
    blocker.close()
  }
}

beforeEach(() => {
  clearModuleCaches()
  _testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-stats-unknown-'))
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(_testDataDir, { recursive: true, force: true })
})

describe('stats when stats_daily_rollup cannot be read', () => {
  it('prints the totals as unknown with the reason, in text and in --json', () => {
    seedTwoRows()
    breakRollupTable()

    const text = captureOutput(() => runStats({ windowDays: 0 }))
    expect(text).toMatch(/Total events:\s+unknown \(.*stats_daily_rollup/)
    expect(text).toMatch(/Tokens saved:\s+unknown \(/)
    expect(text, 'the raw-only count must not be shown as the total').not.toMatch(/Total events:\s+2\b/)

    const json = statsJson(0)
    expect(json['total_events']).toBeNull()
    expect(json['total_bytes_saved']).toBeNull()
    expect(json['total_tokens_saved']).toBeNull()
    expect(String(json['totals_unknown_reason'])).toContain('stats_daily_rollup')
  })

  it('control: a readable rollup table keeps the numbers and carries no reason', () => {
    seedTwoRows()

    const text = captureOutput(() => runStats({ windowDays: 0 }))
    expect(text).toMatch(/Total events:\s+2\b/)
    expect(text).not.toContain('unknown')

    const json = statsJson(0)
    expect(json['total_events']).toBe(2)
    expect(json['total_tokens_saved']).toBe(1500)
    expect(json['totals_unknown_reason']).toBeNull()
  })

  it('control: a readable but empty database is a genuine zero, not unknown', () => {
    getGlobalDb()

    expect(captureOutput(() => runStats({ windowDays: 0 }))).toContain('No stats recorded yet.')
    const json = statsJson(0)
    expect(json['total_events']).toBe(0)
    expect(json['totals_unknown_reason']).toBeNull()
    expect(json['db_missing']).toBe(false)
  })
})

describe('stats after recordStat writes failed', () => {
  it('says writes failed, with the count and the latest reason, so a gap in the numbers is explained', () => {
    getGlobalDb()
    failOneStatWrite()

    const text = captureOutput(() => runStats({ windowDays: 0 }))
    expect(text).toContain('No stats recorded yet.')
    expect(text).toMatch(/Stats writes failed: 1 logged, latest .*(locked|busy)/i)

    const failures = statsJson(0)['write_failures'] as { count: number; latest_reason: string; latest_at: string }
    expect(failures.count).toBe(1)
    expect(failures.latest_reason).toMatch(/locked|busy/i)
    expect(Number.isNaN(Date.parse(failures.latest_at))).toBe(false)
  })

  it('says so with no global.db at all, where the log is the only evidence left', () => {
    getGlobalDb()
    failOneStatWrite()
    closeAllDbs()
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(_testDataDir, `global.db${suffix}`), { force: true })

    expect(captureOutput(() => runStats({ windowDays: 0 }))).toMatch(/Stats writes failed: 1 logged/)
  })

  it('control: with no failure log, nothing is said and write_failures is null', () => {
    seedTwoRows()

    expect(captureOutput(() => runStats({ windowDays: 0 }))).not.toContain('Stats writes failed')
    expect(statsJson(0)['write_failures']).toBeNull()
  })
})

describe('stats --json with no global.db', () => {
  it('says the database is missing instead of printing measured-looking zeros', () => {
    expect(fs.existsSync(path.join(_testDataDir, 'global.db'))).toBe(false)

    const json = statsJson(30)
    expect(json['db_missing']).toBe(true)
    expect(json['total_events']).toBeNull()
    expect(json['total_tokens_saved']).toBeNull()
    expect(String(json['totals_unknown_reason'])).toMatch(/global\.db/)
    expect(fs.existsSync(path.join(_testDataDir, 'global.db')), 'a read must not create the database').toBe(false)
  })

  it('keeps the text answer for a fresh install', () => {
    expect(captureOutput(() => runStats({ windowDays: 30 }))).toContain('No stats recorded yet.')
  })
})
